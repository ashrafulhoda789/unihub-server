const express = require('express');
const dotenv = require('dotenv')
const cors = require('cors')
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express()
const port = process.env.PORT;
const uri = process.env.MONGO_DB_URI;

app.use(cors());
app.use(express.json());

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {

        await client.connect();

        const db = client.db('unihub_db');
        const pitchesCollection = db.collection('pitches');
        const workspacesCollection = db.collection('workspaces');

        console.log("Connected to MongoDB with Pitch Schema!");

        // 1. CREATE NEW PITCH
        app.post('/api/pitches', async (req, res) => {
            const { title, description, category, requiredSkills, createdBy, creatorRole, roleInTeam } = req.body;

            const now = new Date();
            // Default Expiry: 7 days from creation
            const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

            const newPitch = {
                title,
                description,
                category, // "DSA" | "Web Dev" | "Machine Learning" | "Embedded Systems" | "Cyber Security"
                requiredSkills: requiredSkills || [],
                createdBy: new ObjectId(createdBy),
                creatorRole: creatorRole || "STUDENT",

                members: [
                    {
                        userId: new ObjectId(createdBy),
                        roleInTeam: roleInTeam || "Lead Developer"
                    }
                ],
                joinRequests: [],

                supervisorId: null,
                supervisionStatus: "UNASSIGNED", // "UNASSIGNED" | "PENDING" | "ACCEPTED" | "REJECTED"

                status: "MATCHING", // "MATCHING" | "ACTIVE" | "CANCELLED" | "COMPLETED"
                expiresAt: expiresAt,

                isFinalized: false,
                workspaceId: null,
                createdAt: now
            };

            const result = await pitchesCollection.insertOne(newPitch);
            res.send({ success: true, insertedId: result.insertedId });
        });

        // 2. GET USER'S PITCHES (as Owner or Member)
        app.get('/api/pitches/user/:userId', async (req, res) => {
            const userId = req.params.userId;
            if (!ObjectId.isValid(userId)) return res.status(400).send({ error: "Invalid User ID" });

            const userObjectId = new ObjectId(userId);
            const query = {
                $or: [
                    { createdBy: userObjectId },
                    { "members.userId": userObjectId }
                ]
            };

            const pitches = await pitchesCollection.find(query).sort({ createdAt: -1 }).toArray();
            res.send(pitches);
        });


        // 3. FINALIZE TEAM (PRIVACY SEAL -> Instantiates Workspace & Sets Status ACTIVE)
        app.patch('/api/pitches/:id/finalize', async (req, res) => {
            const pitchId = req.params.id;
            const pitch = await pitchesCollection.findOne({ _id: new ObjectId(pitchId) });

            if (!pitch) return res.status(404).send({ error: "Pitch not found" });

            // Create a dedicated private workspace document
            const workspaceDoc = {
                pitchId: pitch._id,
                title: pitch.title,
                members: pitch.members,
                kanbanLanes: {
                    backlog: [],
                    todo: [],
                    inReview: [],
                    done: []
                },
                createdAt: new Date()
            };

            const workspaceResult = await workspacesCollection.insertOne(workspaceDoc);

            // Update Pitch status
            const updateDoc = {
                $set: {
                    isFinalized: true,
                    status: "ACTIVE",
                    workspaceId: workspaceResult.insertedId
                }
            };

            await pitchesCollection.updateOne({ _id: new ObjectId(pitchId) }, updateDoc);
            res.send({ success: true, workspaceId: workspaceResult.insertedId });
        });

        // 4. ACCEPT / REJECT JOIN REQUEST
        app.patch('/api/pitches/:id/request-action', async (req, res) => {
            const pitchId = req.params.id;
            const { requestId, action, roleInTeam } = req.body; // action: 'ACCEPTED' | 'REJECTED'

            const pitch = await pitchesCollection.findOne({ _id: new ObjectId(pitchId) });
            if (!pitch) return res.status(404).send({ error: "Pitch not found" });

            const targetRequest = pitch.joinRequests.find(r => r._id.toString() === requestId);
            if (!targetRequest) return res.status(404).send({ error: "Request not found" });

            if (action === "ACCEPTED") {
                await pitchesCollection.updateOne(
                    { _id: new ObjectId(pitchId) },
                    {
                        $push: { members: { userId: targetRequest.userId, roleInTeam: roleInTeam || "Developer" } },
                        $set: { "joinRequests.$[elem].status": "ACCEPTED" }
                    },
                    { arrayFilters: [{ "elem._id": targetRequest._id }] }
                );
            } else {
                await pitchesCollection.updateOne(
                    { _id: new ObjectId(pitchId) },
                    { $set: { "joinRequests.$[elem].status": "REJECTED" } },
                    { arrayFilters: [{ "elem._id": targetRequest._id }] }
                );
            }

            res.send({ success: true, action });
        });

        // 5. GET SINGLE PITCH BY ID
        app.get('/api/pitches/:id', async (req, res) => {
            try {
                const pitchId = req.params.id;
                if (!ObjectId.isValid(pitchId)) return res.status(400).send({ error: "Invalid Pitch ID" });

                const pitch = await pitchesCollection.findOne({ _id: new ObjectId(pitchId) });
                if (!pitch) return res.status(404).send({ error: "Pitch not found" });

                res.send(pitch);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // 6. UPDATE PITCH DETAILS
        app.patch('/api/pitches/:id', async (req, res) => {
            try {
                const pitchId = req.params.id;
                const { title, description, category, requiredSkills } = req.body;

                if (!ObjectId.isValid(pitchId)) return res.status(400).send({ error: "Invalid Pitch ID" });

                const updateDoc = {
                    $set: {
                        title,
                        description,
                        category,
                        requiredSkills: Array.isArray(requiredSkills) ? requiredSkills : requiredSkills.split(",").map(s => s.trim()).filter(Boolean),
                        updatedAt: new Date()
                    }
                };

                const result = await pitchesCollection.updateOne({ _id: new ObjectId(pitchId) }, updateDoc);
                res.send({ success: true, modifiedCount: result.modifiedCount });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // 7. DELETE PITCH BY ID
        app.delete('/api/pitches/:id', async (req, res) => {
            try {
                const pitchId = req.params.id;
                if (!ObjectId.isValid(pitchId)) {
                    return res.status(400).send({ success: false, error: "Invalid Pitch ID" });
                }

                const result = await pitchesCollection.deleteOne({ _id: new ObjectId(pitchId) });

                if (result.deletedCount === 0) {
                    return res.status(404).send({ success: false, error: "Pitch not found" });
                }

                res.send({ success: true, message: "Pitch deleted successfully" });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {

        // await client.close();
    }
}
run().catch(console.dir);


app.get('/', (req, res) => {
    res.send('UniHub Server!')
})

app.listen(port, () => {
    console.log(`UniHub server is running on port ${port}`)
})