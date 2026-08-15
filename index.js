const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
dotenv.config();

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const app = express();
const port = process.env.PORT || 5000;
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
        const usersCollection = db.collection('user'); // আপনার Collection name 'user'

        // 1. CREATE PITCH
        app.post('/api/pitches', async (req, res) => {
            try {
                const { title, description, category, requiredSkills, createdBy, creatorRole, roleInTeam } = req.body;

                if (!createdBy || !ObjectId.isValid(createdBy)) {
                    return res.status(400).send({ success: false, error: "Invalid User ID" });
                }

                const now = new Date();
                const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

                const newPitch = {
                    title,
                    description,
                    category,
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
                    supervisionStatus: "UNASSIGNED",

                    status: "MATCHING",
                    expiresAt: expiresAt,

                    isFinalized: false,
                    workspaceId: null,
                    createdAt: now
                };

                const result = await pitchesCollection.insertOne(newPitch);
                res.send({ success: true, insertedId: result.insertedId });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // 2. GET USER'S PITCHES
        app.get('/api/pitches/user/:userId', async (req, res) => {
            try {
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
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // 3. FINALIZE TEAM & LOCK WORKSPACE
        app.patch('/api/pitches/:id/finalize', async (req, res) => {
            try {
                const pitchId = req.params.id;
                if (!ObjectId.isValid(pitchId)) return res.status(400).send({ error: "Invalid Pitch ID" });

                const pitch = await pitchesCollection.findOne({ _id: new ObjectId(pitchId) });
                if (!pitch) return res.status(404).send({ error: "Pitch not found" });

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

                const updateDoc = {
                    $set: {
                        isFinalized: true,
                        status: "ACTIVE",
                        workspaceId: workspaceResult.insertedId
                    }
                };

                await pitchesCollection.updateOne({ _id: new ObjectId(pitchId) }, updateDoc);
                res.send({ success: true, workspaceId: workspaceResult.insertedId });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // 4. ACCEPT / REJECT JOIN REQUEST
        app.patch('/api/pitches/:id/request-action', async (req, res) => {
            try {
                const pitchId = req.params.id;
                const { requestId, action, roleInTeam } = req.body;

                if (!ObjectId.isValid(pitchId)) return res.status(400).send({ error: "Invalid Pitch ID" });

                const pitch = await pitchesCollection.findOne({ _id: new ObjectId(pitchId) });
                if (!pitch) return res.status(404).send({ error: "Pitch not found" });

                const targetRequest = pitch.joinRequests.find(r => r._id.toString() === requestId);
                if (!targetRequest) return res.status(404).send({ error: "Request not found" });

                if (action === "ACCEPTED") {
                    await pitchesCollection.updateOne(
                        { _id: new ObjectId(pitchId) },
                        {
                            $push: { members: { userId: new ObjectId(targetRequest.userId), roleInTeam: roleInTeam || targetRequest.role || "Developer" } },
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
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // 5. GET SINGLE PITCH BY ID (FIXED LOOKUP & MERGE)
        app.get('/api/pitches/:id', async (req, res) => {
            try {
                const pitchId = req.params.id;
                if (!ObjectId.isValid(pitchId)) {
                    return res.status(400).send({ error: "Invalid Pitch ID" });
                }

                const pitches = await pitchesCollection.aggregate([
                    { $match: { _id: new ObjectId(pitchId) } },
                    {
                        $lookup: {
                            from: "user", // Fixed: 'users' -> 'user'
                            localField: "members.userId",
                            foreignField: "_id",
                            as: "memberUsers"
                        }
                    },
                    {
                        $addFields: {
                            members: {
                                $map: {
                                    input: "$members",
                                    as: "m",
                                    in: {
                                        $let: {
                                            vars: {
                                                matchedUser: {
                                                    $arrayElemAt: [
                                                        {
                                                            $filter: {
                                                                input: "$memberUsers",
                                                                cond: { $eq: ["$$this._id", "$$m.userId"] }
                                                            }
                                                        },
                                                        0
                                                    ]
                                                }
                                            },
                                            in: {
                                                userId: "$$m.userId",
                                                roleInTeam: "$$m.roleInTeam",
                                                role: "$$m.role",
                                                name: { $ifNull: ["$$m.name", "$$matchedUser.name"] },
                                                email: { $ifNull: ["$$m.email", "$$matchedUser.email"] },
                                                image: { $ifNull: ["$$m.image", "$$matchedUser.image"] }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    { $project: { memberUsers: 0 } }
                ]).toArray();

                if (!pitches || pitches.length === 0) {
                    return res.status(404).send({ error: "Pitch not found" });
                }

                res.send(pitches[0]);
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

        // 8. GET ALL PITCHES (FIXED LOOKUP & MERGE)
        app.get('/api/pitches', async (req, res) => {
            try {
                const { category, search, status } = req.query;
                let matchQuery = {};

                if (status) matchQuery.status = status;
                if (category && category !== "All") matchQuery.category = category;
                if (search) {
                    matchQuery.$or = [
                        { title: { $regex: search, $options: 'i' } },
                        { description: { $regex: search, $options: 'i' } },
                        { requiredSkills: { $elemMatch: { $regex: search, $options: 'i' } } }
                    ];
                }

                const pitches = await pitchesCollection.aggregate([
                    { $match: matchQuery },
                    { $sort: { createdAt: -1 } },
                    {
                        $lookup: {
                            from: "user", // Fixed: 'users' -> 'user'
                            localField: "members.userId",
                            foreignField: "_id",
                            as: "memberUsers"
                        }
                    },
                    {
                        $addFields: {
                            members: {
                                $map: {
                                    input: "$members",
                                    as: "m",
                                    in: {
                                        $let: {
                                            vars: {
                                                matchedUser: {
                                                    $arrayElemAt: [
                                                        {
                                                            $filter: {
                                                                input: "$memberUsers",
                                                                cond: { $eq: ["$$this._id", "$$m.userId"] }
                                                            }
                                                        },
                                                        0
                                                    ]
                                                }
                                            },
                                            in: {
                                                userId: "$$m.userId",
                                                roleInTeam: "$$m.roleInTeam",
                                                role: "$$m.role",
                                                name: { $ifNull: ["$$m.name", "$$matchedUser.name"] },
                                                email: { $ifNull: ["$$m.email", "$$matchedUser.email"] },
                                                image: { $ifNull: ["$$m.image", "$$matchedUser.image"] }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    { $project: { memberUsers: 0 } }
                ]).toArray();

                res.send({ success: true, count: pitches.length, data: pitches });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // 9. SUBMIT JOIN REQUEST
        app.post('/api/pitches/:id/join-request', async (req, res) => {
            try {
                const pitchId = req.params.id;
                const { userId, name, email, applicantName, applicantEmail, role, message } = req.body;

                if (!ObjectId.isValid(pitchId) || !userId || !ObjectId.isValid(userId)) {
                    return res.status(400).send({ success: false, error: "Invalid Pitch ID or User ID" });
                }

                const pitch = await pitchesCollection.findOne({ _id: new ObjectId(pitchId) });
                if (!pitch) {
                    return res.status(404).send({ success: false, error: "Pitch not found" });
                }

                const isMember = pitch.members.some(m => m.userId.toString() === userId.toString());
                if (isMember) {
                    return res.status(400).send({ success: false, error: "You are already a member of this pitch!" });
                }

                const existingRequest = pitch.joinRequests?.find(r => r.userId.toString() === userId.toString());
                if (existingRequest) {
                    return res.status(400).send({ success: false, error: "You have already applied for this pitch!" });
                }

                const resolvedName = name || applicantName || "Unknown Student";
                const resolvedEmail = email || applicantEmail || "No email provided";

                const newRequest = {
                    _id: new ObjectId(),
                    userId: new ObjectId(userId),
                    applicantName: resolvedName,
                    applicantEmail: resolvedEmail,
                    role: role || "Developer",
                    message: message || "",
                    status: "PENDING",
                    createdAt: new Date()
                };

                await pitchesCollection.updateOne(
                    { _id: new ObjectId(pitchId) },
                    { $push: { joinRequests: newRequest } }
                );

                res.send({ success: true, message: "Join request submitted successfully!" });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // 10. GET ALL JOIN REQUESTS FOR A SINGLE PITCH
        app.get('/api/pitches/:id/join-requests', async (req, res) => {
            try {
                const pitchId = req.params.id;
                const { status } = req.query;

                if (!ObjectId.isValid(pitchId)) {
                    return res.status(400).send({ success: false, error: "Invalid Pitch ID" });
                }

                const pitch = await pitchesCollection.findOne({ _id: new ObjectId(pitchId) });
                if (!pitch) {
                    return res.status(404).send({ success: false, error: "Pitch not found" });
                }

                let requests = pitch.joinRequests || [];

                if (status) {
                    requests = requests.filter(r => r.status === status.toUpperCase());
                }

                res.send({
                    success: true,
                    pitchTitle: pitch.title,
                    count: requests.length,
                    data: requests
                });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // 11. GET USER'S SENT APPLICATIONS
        app.get('/api/pitches/join-requests/user/:userId', async (req, res) => {
            try {
                const userId = req.params.userId;

                if (!userId || userId === 'undefined') {
                    return res.status(400).send({ success: false, error: "Valid User ID is required" });
                }

                if (!ObjectId.isValid(userId)) {
                    return res.status(400).send({ success: false, error: "Invalid User ID format" });
                }

                const userObjectId = new ObjectId(userId);

                // Match both ObjectId and String stored versions in DB
                const pitches = await pitchesCollection.find({
                    "joinRequests": {
                        $elemMatch: {
                            $or: [
                                { userId: userObjectId },
                                { userId: userId }
                            ]
                        }
                    }
                }).toArray();

                const myApplications = [];

                pitches.forEach(pitch => {
                    if (Array.isArray(pitch.joinRequests)) {
                        pitch.joinRequests.forEach(reqObj => {
                            // Safe string comparison for both ObjectId and String types
                            const reqUserId = reqObj.userId ? reqObj.userId.toString() : null;

                            if (reqUserId === userId.toString()) {
                                myApplications.push({
                                    requestId: reqObj._id ? reqObj._id.toString() : null,
                                    pitchId: pitch._id ? pitch._id.toString() : null,
                                    pitchTitle: pitch.title,
                                    category: pitch.category,
                                    pitchStatus: pitch.status,
                                    role: reqObj.role,
                                    message: reqObj.message,
                                    status: reqObj.status,
                                    createdAt: reqObj.createdAt
                                });
                            }
                        });
                    }
                });

                return res.send({ success: true, count: myApplications.length, data: myApplications });
            } catch (error) {
                console.error("Error fetching user join requests:", error);
                return res.status(500).send({ success: false, error: error.message });
            }
        });

        // 12. GET ALL INCOMING REQUESTS FOR A PITCH OWNER
        app.get('/api/pitches/owner/:ownerId/join-requests', async (req, res) => {
            try {
                const ownerId = req.params.ownerId;
                const { status } = req.query;

                if (!ObjectId.isValid(ownerId)) {
                    return res.status(400).send({ success: false, error: "Invalid Owner ID" });
                }

                let matchStatus = status ? status.toUpperCase() : null;

                const incomingRequests = await pitchesCollection.aggregate([
                    { $match: { createdBy: new ObjectId(ownerId) } },
                    { $unwind: "$joinRequests" },
                    ...(matchStatus ? [{ $match: { "joinRequests.status": matchStatus } }] : []),
                    {
                        $project: {
                            _id: "$joinRequests._id",
                            userId: "$joinRequests.userId",
                            applicantName: "$joinRequests.applicantName",
                            applicantEmail: "$joinRequests.applicantEmail",
                            role: "$joinRequests.role",
                            message: "$joinRequests.message",
                            status: "$joinRequests.status",
                            createdAt: "$joinRequests.createdAt",
                            pitchId: "$_id",
                            pitchTitle: "$title",
                            pitchCategory: "$category"
                        }
                    }
                ]).toArray();

                res.send({ success: true, count: incomingRequests.length, data: incomingRequests });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // ACCEPT JOIN REQUEST & SAVE NAME/EMAIL IN MEMBERS ARRAY
        app.patch('/api/pitches/:pitchId/join-requests/:requestId/accept', async (req, res) => {
            try {
                const { pitchId, requestId } = req.params;

                if (!ObjectId.isValid(pitchId) || !ObjectId.isValid(requestId)) {
                    return res.status(400).send({ success: false, error: "Invalid ID format" });
                }

                const pitch = await pitchesCollection.findOne({
                    _id: new ObjectId(pitchId),
                    "joinRequests._id": new ObjectId(requestId)
                });

                if (!pitch) {
                    return res.status(404).send({ success: false, error: "Pitch or Request not found" });
                }

                const requestObj = pitch.joinRequests.find(r => r._id.toString() === requestId);

                if (!requestObj) {
                    return res.status(404).send({ success: false, error: "Request object not found" });
                }

                if (requestObj.status === "ACCEPTED") {
                    return res.status(400).send({ success: false, error: "Request already accepted" });
                }

                const user = await usersCollection.findOne({ _id: new ObjectId(requestObj.userId) });

                const memberData = {
                    _id: new ObjectId(),
                    userId: new ObjectId(requestObj.userId),
                    name: user?.name || requestObj.applicantName || "Unknown",
                    email: user?.email || requestObj.applicantEmail || "No email",
                    roleInTeam: requestObj.role || "Member",
                    joinedAt: new Date()
                };

                const updateResult = await pitchesCollection.updateOne(
                    {
                        _id: new ObjectId(pitchId),
                        "joinRequests._id": new ObjectId(requestId)
                    },
                    {
                        $set: { "joinRequests.$.status": "ACCEPTED" },
                        $push: { members: memberData }
                    }
                );

                res.send({
                    success: true,
                    message: "Join request accepted successfully",
                    member: memberData
                });

            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // REMOVE A MEMBER FROM A PITCH
        app.delete('/api/pitches/:pitchId/members/:memberUserId', async (req, res) => {
            try {
                const { pitchId, memberUserId } = req.params;

                if (!ObjectId.isValid(pitchId) || !ObjectId.isValid(memberUserId)) {
                    return res.status(400).send({ success: false, error: "Invalid Pitch or User ID" });
                }

                const result = await pitchesCollection.updateOne(
                    { _id: new ObjectId(pitchId) },
                    {
                        $pull: {
                            members: {
                                $or: [
                                    { userId: new ObjectId(memberUserId) },
                                    { userId: memberUserId }
                                ]
                            }
                        }
                    }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ success: false, error: "Member not found or already removed" });
                }

                res.send({ success: true, message: "Member removed successfully" });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // 13. ASSIGN SUPERVISOR FROM TEAM MEMBERS
        app.patch('/api/pitches/:id/assign-supervisor', async (req, res) => {
            try {
                const pitchId = req.params.id;
                // Frontend থেকে name এবং email পাঠানো হচ্ছে, তাই destructure এও তা রাখা হলো
                const { supervisorId, name, email } = req.body;

                if (!ObjectId.isValid(pitchId)) {
                    return res.status(400).send({ success: false, error: "Invalid Pitch ID" });
                }

                let updateDoc;

                // যদি supervisorId null বা undefined হয়, তার মানে Unassign করতে বলা হচ্ছে
                if (!supervisorId) {
                    updateDoc = {
                        $set: {
                            supervisorId: null,
                            supervisionStatus: "UNASSIGNED",
                            supervisorDetails: null
                        }
                    };
                } else {
                    // Assign করার লজিক
                    if (!ObjectId.isValid(supervisorId)) {
                        return res.status(400).send({ success: false, error: "Invalid Supervisor ID" });
                    }
                    updateDoc = {
                        $set: {
                            supervisorId: new ObjectId(supervisorId),
                            supervisionStatus: "ASSIGNED",
                            supervisorDetails: { name, email }
                        }
                    };
                }

                const result = await pitchesCollection.updateOne(
                    { _id: new ObjectId(pitchId) },
                    updateDoc
                );

                if (result.modifiedCount === 0) {
                    return res.status(400).send({ success: false, error: "Failed to update supervisor" });
                }

                res.send({
                    success: true,
                    message: supervisorId ? "Supervisor assigned successfully!" : "Supervisor unassigned successfully!",
                    status: supervisorId ? "ASSIGNED" : "UNASSIGNED"
                });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // 14. DELETE/CANCEL A JOIN REQUEST (For User)
        app.delete('/api/pitches/:pitchId/join-requests/:requestId', async (req, res) => {
            try {
                const { pitchId, requestId } = req.params;

                if (!ObjectId.isValid(pitchId) || !ObjectId.isValid(requestId)) {
                    return res.status(400).send({ success: false, error: "Invalid ID format" });
                }

                const result = await pitchesCollection.updateOne(
                    { _id: new ObjectId(pitchId) },
                    {
                        $pull: {
                            joinRequests: { _id: new ObjectId(requestId) }
                        }
                    }
                );

                if (result.modifiedCount === 0) {
                    return res.status(404).send({ success: false, error: "Request not found or already deleted" });
                }

                res.send({ success: true, message: "Join request cancelled/deleted successfully" });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // Connection alive
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('UniHub Server!');
});

app.listen(port, () => {
    console.log(`UniHub server is running on port ${port}`);
});