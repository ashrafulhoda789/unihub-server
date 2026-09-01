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
        const tasksCollection = db.collection('tasks');
        const usersCollection = db.collection('user');
        const curriculumCollection = db.collection('curriculum_resources');
        const classroomCollection = db.collection('classroom_resources');

        app.get('/api/users', async (req, res) => {
            const data = await usersCollection.find().toArray();
            res.send(data);
        })

        app.patch('/api/users', async (req, res) => {
            try {
                const { userId, name, email, avatar, image } = req.body;

                if (!userId || !ObjectId.isValid(userId)) {
                    return res.status(400).json({ success: false, message: "Valid User ID is required" });
                }

                const updateData = {};
                if (name) updateData.name = name;
                if (email) updateData.email = email;

                const imageUrl = avatar || image;
                if (imageUrl) updateData.image = imageUrl;

                if (Object.keys(updateData).length === 0) {
                    return res.status(400).json({ success: false, message: "No profile data provided to update" });
                }

                updateData.updatedAt = new Date();

                const result = await usersCollection.updateOne(
                    { _id: new ObjectId(userId) },
                    { $set: updateData }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).json({ success: false, message: "User not found" });
                }

                return res.status(200).json({
                    success: true,
                    message: "Profile updated successfully!"
                });
            } catch (error) {
                console.error("Profile update error:", error);
                return res.status(500).json({ success: false, message: "Internal server error", error: error.message });
            }
        });

        // --------------Pitch Api---------------------

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

                const queryId = new ObjectId(pitchId);

                const pitches = await pitchesCollection.aggregate([
                    {
                        $match: {
                            $or: [
                                { _id: queryId },
                                { workspaceId: queryId }
                            ]
                        }
                    },
                    {
                        $lookup: {
                            from: "user",
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

        // 8. GET ALL PITCHES 
        app.get('/api/pitches', async (req, res) => {
            try {
                const { category, search, status, page = 1, limit = 6 } = req.query;

                const pageNum = parseInt(page, 10) || 1;
                const limitNum = parseInt(limit, 10) || 6;
                const skip = (pageNum - 1) * limitNum;

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

                const result = await pitchesCollection.aggregate([
                    { $match: matchQuery },
                    { $sort: { createdAt: -1 } },
                    {
                        $lookup: {
                            from: "user",
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
                    { $project: { memberUsers: 0 } },
                    {
                        $facet: {
                            metadata: [{ $count: "total" }],
                            data: [{ $skip: skip }, { $limit: limitNum }]
                        }
                    }
                ]).toArray();

                const total = result[0]?.metadata[0]?.total || 0;
                const totalPages = Math.ceil(total / limitNum);
                const pitches = result[0]?.data || [];

                res.send({
                    success: true,
                    total,
                    totalPages,
                    currentPage: pageNum,
                    count: pitches.length,
                    data: pitches
                });
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
                const { q, status, category, page = 1, limit = 6 } = req.query;

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

                let myApplications = [];

                pitches.forEach(pitch => {
                    if (Array.isArray(pitch.joinRequests)) {
                        pitch.joinRequests.forEach(reqObj => {
                            const reqUserId = reqObj.userId ? reqObj.userId.toString() : null;

                            if (reqUserId === userId.toString()) {
                                myApplications.push({
                                    requestId: reqObj._id ? reqObj._id.toString() : null,
                                    pitchId: pitch._id ? pitch._id.toString() : null,
                                    pitchTitle: pitch.title || '',
                                    category: pitch.category || 'General',
                                    pitchStatus: pitch.status,
                                    role: reqObj.role || '',
                                    message: reqObj.message || '',
                                    status: reqObj.status || 'PENDING',
                                    createdAt: reqObj.createdAt
                                });
                            }
                        });
                    }
                });

                // 1. Filtering Logic
                if (status && status !== 'ALL') {
                    myApplications = myApplications.filter(item => item.status.toUpperCase() === status.toUpperCase());
                }

                if (category && category !== 'ALL') {
                    myApplications = myApplications.filter(item => item.category.toLowerCase() === category.toLowerCase());
                }

                if (q && q.trim() !== '') {
                    const queryLower = q.toLowerCase().trim();
                    myApplications = myApplications.filter(item =>
                        item.pitchTitle.toLowerCase().includes(queryLower) ||
                        item.role.toLowerCase().includes(queryLower) ||
                        item.message.toLowerCase().includes(queryLower)
                    );
                }

                // Sort by newest applications first
                myApplications.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

                // 2. Pagination Logic
                const total = myApplications.length;
                const pageNum = parseInt(page, 10) || 1;
                const limitNum = parseInt(limit, 10) || 6;
                const totalPages = Math.ceil(total / limitNum) || 1;

                const startIndex = (pageNum - 1) * limitNum;
                const paginatedData = myApplications.slice(startIndex, startIndex + limitNum);

                return res.send({
                    success: true,
                    total,
                    totalPages,
                    currentPage: pageNum,
                    limit: limitNum,
                    count: paginatedData.length,
                    data: paginatedData
                });
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


        // --------------Task related api--------------

        app.get('/api/workspaces/:workspaceId', async (req, res) => {
            try {
                const { workspaceId } = req.params;
                const { userId } = req.query;

                if (!ObjectId.isValid(workspaceId) || !ObjectId.isValid(userId)) {
                    return res.status(400).send({ success: false, error: "Invalid IDs" });
                }

                const workspace = await workspacesCollection.findOne({ _id: new ObjectId(workspaceId) });
                if (!workspace) {
                    return res.status(404).send({ success: false, error: "Workspace not found" });
                }

                const isSupervisor = workspace.supervisorId?.toString() === userId;
                const isMember = workspace.members?.some(m => m.userId.toString() === userId);

                if (!isSupervisor && !isMember) {
                    return res.status(403).send({ success: false, accessDenied: true, error: "Unauthorized Access" });
                }

                res.send({ success: true, workspace });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // 1. CREATE A TASK
        app.post('/api/tasks', async (req, res) => {
            try {

                const { workspaceId, title, description, assignedTo, dueDate, status, attachments, createdBy } = req.body;

                console.log("📝 Creating task with workspaceId:", workspaceId);

                // Validation
                if (!workspaceId || !ObjectId.isValid(workspaceId)) {
                    return res.status(400).send({ success: false, error: "Invalid Workspace ID" });
                }

                if (!title || !title.trim()) {
                    return res.status(400).send({ success: false, error: "Title is required" });
                }

                if (!createdBy || !ObjectId.isValid(createdBy)) {
                    return res.status(400).send({ success: false, error: "Invalid User ID" });
                }

                const workspace = await pitchesCollection.findOne({
                    $or: [
                        { _id: new ObjectId(workspaceId) },
                        { workspaceId: new ObjectId(workspaceId) }
                    ]
                });

                if (!workspace) {
                    // console.error(" Workspace not found for ID:", workspaceId);
                    return res.status(404).send({ success: false, error: "Workspace not found" });
                }

                // console.log("Found workspace/pitch:", workspace._id);

                // Authorization Gate: Check if user is Supervisor or Lead Developer
                const isSupervisor = workspace.supervisorId && workspace.supervisorId.toString() === createdBy;
                const leadMember = workspace.members?.find(m => m.roleInTeam === 'Lead Developer');
                const isLeadDev = leadMember && leadMember.userId.toString() === createdBy;

                console.log("Authorization check - isSupervisor:", isSupervisor, "isLeadDev:", isLeadDev);

                if (!isSupervisor && !isLeadDev) {
                    return res.status(403).send({
                        success: false,
                        error: "Access denied: Only Supervisor or Lead Developer can create tasks."
                    });
                }

                const formattedAttachments = Array.isArray(attachments)
                    ? attachments
                    : attachments ? [attachments] : [];

                const newTask = {
                    workspaceId: new ObjectId(workspaceId),
                    title: title.trim(),
                    description: description || "",
                    assignedTo: Array.isArray(assignedTo) ? assignedTo.map(id => new ObjectId(id)) : [],
                    status: status || "TODO",  // ✅ এখন status থাকবে
                    attachments: formattedAttachments || [],
                    submissionUrl: null,
                    reviewedBy: null,
                    dueDate: dueDate ? new Date(dueDate) : null,
                    createdBy: new ObjectId(createdBy),
                    createdAt: new Date(),
                    updatedAt: new Date()
                };

                const result = await tasksCollection.insertOne(newTask);

                res.status(201).send({
                    success: true,
                    insertedId: result.insertedId,
                    task: {
                        ...newTask,
                        _id: result.insertedId,
                        assigneeDetails: []
                    }
                });
            } catch (error) {
                console.error("Error creating task:", error.message);
                res.status(500).send({ success: false, error: error.message });
            }
        });


        // Backend GET API Fix
        app.get('/api/workspaces/:workspaceId/tasks', async (req, res) => {
            try {
                const { workspaceId } = req.params;
                if (!ObjectId.isValid(workspaceId)) {
                    return res.status(400).send({ success: false, error: "Invalid Workspace ID" });
                }

                const targetObjId = new ObjectId(workspaceId);
                const now = new Date();

                // 1. প্রথমে দেখুন এই ID দিয়ে Pitch/Workspace পাওয়া যায় কিনা
                const workspacePitch = await pitchesCollection.findOne({
                    $or: [
                        { _id: targetObjId },
                        { workspaceId: targetObjId }
                    ]
                });

                // 2. Pitch পাওয়া গেলে তার _id এবং workspaceId দুটোই কালেক্ট করুন
                let matchingIds = [targetObjId];
                if (workspacePitch) {
                    if (workspacePitch._id) matchingIds.push(new ObjectId(workspacePitch._id));
                    if (workspacePitch.workspaceId) matchingIds.push(new ObjectId(workspacePitch.workspaceId));
                }

                // 3. Auto-Backlog Update
                await tasksCollection.updateMany(
                    {
                        workspaceId: { $in: matchingIds },
                        dueDate: { $exists: true, $type: "date", $lt: now },
                        status: { $nin: ["DONE", "BACKLOG"] }
                    },
                    {
                        $set: { status: "BACKLOG", updatedAt: new Date() }
                    }
                );

                // 4. Aggregate Tasks Query ($in দিয়ে দুটো ID-ই চেক করা হচ্ছে)
                const tasks = await tasksCollection.aggregate([
                    {
                        $match: {
                            workspaceId: { $in: matchingIds }
                        }
                    },
                    { $sort: { createdAt: -1 } },
                    {
                        $lookup: {
                            from: "user",
                            localField: "assignedTo",
                            foreignField: "_id",
                            as: "assigneeDetails"
                        }
                    },
                    {
                        $project: {
                            "assigneeDetails.password": 0
                        }
                    }
                ]).toArray();

                res.send({ success: true, count: tasks.length, data: tasks });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });


        // 3. KANBAN DRAG & DROP / STATUS UPDATE WITH PERMISSION LOGIC
        app.patch('/api/tasks/:id/status', async (req, res) => {
            try {
                const taskId = req.params.id;
                const { targetStatus, userId, submissionUrl } = req.body;

                if (!ObjectId.isValid(taskId) || !ObjectId.isValid(userId)) {
                    return res.status(400).send({ success: false, error: "Invalid Task or User ID" });
                }

                const task = await tasksCollection.findOne({ _id: new ObjectId(taskId) });
                if (!task) {
                    return res.status(404).send({ success: false, error: "Task not found" });
                }

                const workspace = await pitchesCollection.findOne({
                    $or: [
                        { _id: new ObjectId(task.workspaceId) },
                        { workspaceId: new ObjectId(task.workspaceId) }
                    ]
                });

                if (!workspace) {
                    return res.status(404).send({ success: false, error: "Associated pitch/workspace not found" });
                }

                if (task.status === "BACKLOG") {
                    return res.status(400).send({
                        success: false,
                        error: "Overdue items in Backlog cannot be moved directly."
                    });
                }

                // Check Supervisor ID safely
                const isSupervisor = workspace.supervisorId && workspace.supervisorId.toString() === userId;

                // Rule 2: Only Supervisor can move tasks to DONE
                if (targetStatus === "DONE") {
                    if (!isSupervisor) {
                        return res.status(403).send({
                            success: false,
                            error: "Permission denied: Only the Supervisor can approve and mark tasks as DONE."
                        });
                    }
                }

                const updateFields = { status: targetStatus, updatedAt: new Date() };

                if (targetStatus === "DONE") {
                    updateFields.reviewedBy = new ObjectId(userId);
                }

                // Rule 3: Students submit proof link when moving to IN_REVIEW
                if (targetStatus === "IN_REVIEW" && submissionUrl) {
                    updateFields.submissionUrl = submissionUrl;
                }

                const result = await tasksCollection.updateOne(
                    { _id: new ObjectId(taskId) },
                    { $set: updateFields }
                );

                res.send({ success: true, modifiedCount: result.modifiedCount });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });


        // 4. DELETE TASK
        app.delete('/api/tasks/:id', async (req, res) => {
            try {
                const taskId = req.params.id;
                if (!ObjectId.isValid(taskId)) {
                    return res.status(400).send({ success: false, error: "Invalid Task ID" });
                }

                const result = await tasksCollection.deleteOne({ _id: new ObjectId(taskId) });
                if (result.deletedCount === 0) {
                    return res.status(404).send({ success: false, error: "Task not found" });
                }

                res.send({ success: true, message: "Task deleted successfully" });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });



        // -----------------------Curriculum--------------------

        // 1. ADD NEW RESOURCE / CURRICULUM DATA (Admin & Faculty)
        app.post('/api/curriculum-resources', async (req, res) => {
            try {
                const {
                    title,
                    courseName,
                    courseId,
                    documentType,
                    semester,
                    department,
                    description,
                    highlights,
                    fileUrl,
                    publicId,
                    resourceLink,
                    uploadedBy
                } = req.body;

                if (!title || !courseName || !courseId || !documentType || !semester || !department) {
                    return res.status(400).send({
                        success: false,
                        message: "Required fields are missing!"
                    });
                }

                const newResource = {
                    title,
                    courseName,
                    courseId: courseId.toUpperCase(),
                    documentType,
                    semester,
                    department,
                    description: description || "",
                    highlights: Array.isArray(highlights) ? highlights : [],
                    fileUrl: fileUrl || null,
                    publicId: publicId || null,
                    resourceLink: resourceLink || "",
                    uploadedBy: uploadedBy || "Anonymous",
                    createdAt: new Date()
                };

                const result = await curriculumCollection.insertOne(newResource);

                res.status(201).send({
                    success: true,
                    message: "Resource uploaded successfully!",
                    insertedId: result.insertedId
                });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // 2. GET RESOURCES (With Department, Semester, Search & Course Filter for Frontend View)
        app.get('/api/curriculum-resources', async (req, res) => {
            try {
                const { department, semester, courseId, documentType, email, search, q, page = 1, limit = 6 } = req.query;

                const pageNum = parseInt(page, 10) || 1;
                const limitNum = parseInt(limit, 10) || 6;
                const skip = (pageNum - 1) * limitNum;

                let query = {};

                if (email) {
                    query.uploadedBy = email;
                }

                if (department && department !== 'All') query.department = department;
                if (semester && semester !== 'All') query.semester = semester;
                if (courseId) query.courseId = courseId.toUpperCase();
                if (documentType) query.documentType = documentType;

                const searchQuery = search || q;
                if (searchQuery && searchQuery.trim() !== '') {
                    const regex = new RegExp(searchQuery.trim(), 'i');
                    query.$or = [
                        { title: regex },
                        { courseName: regex },
                        { courseId: regex }
                    ];
                }

                // 1. Get total document count for pagination UI calculation
                const total = await curriculumCollection.countDocuments(query);
                const totalPages = Math.ceil(total / limitNum);

                // 2. Fetch paginated data
                const resources = await curriculumCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum)
                    .toArray();

                res.send({
                    success: true,
                    total,
                    totalPages,
                    currentPage: pageNum,
                    count: resources.length,
                    data: resources
                });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // Get single curriculum resource by ID
        app.get('/api/curriculum-resources/:id', async (req, res) => {
            try {
                const id = req.params.id;

                // Valid ObjectId kina check kora
                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ success: false, message: 'Invalid Resource ID format' });
                }

                const query = { _id: new ObjectId(id) };
                const resource = await curriculumCollection.findOne(query);

                if (!resource) {
                    return res.status(404).send({ success: false, message: 'Resource not found' });
                }

                res.send({ success: true, data: resource });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // 4. UPDATE A RESOURCE (Admin & Faculty)
        app.patch('/api/curriculum-resources/:id', async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ success: false, message: "Invalid Resource ID" });
                }

                const {
                    title,
                    courseName,
                    courseId,
                    documentType,
                    semester,
                    department,
                    description,
                    fileUrl,
                    publicId,
                    resourceLink,
                    updatedBy
                } = req.body;

                const updateFields = {
                    ...(title && { title }),
                    ...(courseName && { courseName }),
                    ...(courseId && { courseId: courseId.toUpperCase() }),
                    ...(documentType && { documentType }),
                    ...(semester && { semester }),
                    ...(department && { department }),
                    ...(description !== undefined && { description }),
                    ...(fileUrl && { fileUrl }),
                    ...(publicId && { publicId }),
                    ...(resourceLink !== undefined && { resourceLink }),
                    updatedBy: updatedBy || "Anonymous",
                    updatedAt: new Date()
                };

                const result = await curriculumCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateFields }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ success: false, message: "Resource not found" });
                }

                res.send({
                    success: true,
                    message: "Resource updated successfully!"
                });

            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // 3. DELETE RESOURCE (Admin/Faculty cleanup)
        app.delete('/api/curriculum-resources/:id', async (req, res) => {
            try {
                const { id } = req.params;
                const result = await curriculumCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(404).send({ success: false, message: "Resource not found" });
                }

                res.send({ success: true, message: "Resource deleted successfully" });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });



        // --------------------Classroom---------------
        // 1. ADD NEW CLASSROOM RESOURCE (Admin & Faculty)
        app.post('/api/classroom-resources', async (req, res) => {
            try {
                const {
                    title,
                    courseName,
                    courseId,
                    documentType,
                    semester,
                    department,
                    classroomCategory, // 'book' | 'mid' | 'final'
                    resources, // Multiple files array: [{ fileUrl, publicId, fileName }]
                    uploadedBy
                } = req.body;

                // Validation
                if (!title || !courseName || !courseId || !documentType || !semester || !department || !classroomCategory) {
                    return res.status(400).send({
                        success: false,
                        message: "Required fields (including classroomCategory) are missing!"
                    });
                }

                const newClassroomResource = {
                    title,
                    courseName,
                    courseId: courseId.toUpperCase(),
                    documentType,
                    semester,
                    department,
                    classroomCategory,
                    resources: Array.isArray(resources) ? resources : [],
                    uploadedBy: uploadedBy || "Anonymous",
                    createdAt: new Date()
                };

                const result = await classroomCollection.insertOne(newClassroomResource);

                res.status(201).send({
                    success: true,
                    message: "Classroom resource created successfully!",
                    insertedId: result.insertedId
                });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // 2. GET CLASSROOM RESOURCES (Filtered by Dept, Semester, Category, Search & Pagination)
        app.get('/api/classroom-resources', async (req, res) => {
            try {
                const { department, semester, classroomCategory, courseId, email, search, q, page = 1, limit = 6 } = req.query;

                const pageNum = parseInt(page, 10) || 1;
                const limitNum = parseInt(limit, 10) || 6;
                const skip = (pageNum - 1) * limitNum;

                let query = {};

                if (email) query.uploadedBy = email;
                if (department && department !== 'All') query.department = department;
                if (semester && semester !== 'All') query.semester = semester;
                if (classroomCategory && classroomCategory !== 'All') query.classroomCategory = classroomCategory;
                if (courseId) query.courseId = courseId.toUpperCase();

                const searchQuery = search || q;
                if (searchQuery && searchQuery.trim() !== '') {
                    const regex = new RegExp(searchQuery.trim(), 'i');
                    query.$or = [
                        { title: regex },
                        { courseName: regex },
                        { courseId: regex }
                    ];
                }

                const total = await classroomCollection.countDocuments(query);
                const totalPages = Math.ceil(total / limitNum);

                const resources = await classroomCollection
                    .find(query)
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(limitNum)
                    .toArray();

                res.send({
                    success: true,
                    total,
                    totalPages,
                    currentPage: pageNum,
                    count: resources.length,
                    data: resources
                });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // 3. GET SINGLE CLASSROOM RESOURCE BY ID
        app.get('/api/classroom-resources/:id', async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ success: false, message: 'Invalid Resource ID format' });
                }

                const resource = await classroomCollection.findOne({ _id: new ObjectId(id) });

                if (!resource) {
                    return res.status(404).send({ success: false, message: 'Resource not found' });
                }

                res.send({ success: true, data: resource });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // 4. UPDATE A CLASSROOM RESOURCE
        app.patch('/api/classroom-resources/:id', async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ success: false, message: "Invalid Resource ID" });
                }

                const {
                    title,
                    courseName,
                    courseId,
                    documentType,
                    semester,
                    department,
                    classroomCategory,
                    resources, // Array of files: [{ fileUrl, publicId, fileName }]
                    updatedBy
                } = req.body;

                const updateFields = {
                    ...(title && { title }),
                    ...(courseName && { courseName }),
                    ...(courseId && { courseId: courseId.toUpperCase() }),
                    ...(documentType && { documentType }),
                    ...(semester && { semester }),
                    ...(department && { department }),
                    ...(classroomCategory && { classroomCategory }),
                    ...(Array.isArray(resources) && { resources }), // Multiple files array update
                    updatedBy: updatedBy || "Anonymous",
                    updatedAt: new Date()
                };

                const result = await classroomCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: updateFields }
                );

                if (result.matchedCount === 0) {
                    return res.status(404).send({ success: false, message: "Resource not found" });
                }

                res.send({
                    success: true,
                    message: "Classroom resource updated successfully!"
                });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
            }
        });

        // 5. DELETE A CLASSROOM RESOURCE
        app.delete('/api/classroom-resources/:id', async (req, res) => {
            try {
                const { id } = req.params;

                if (!ObjectId.isValid(id)) {
                    return res.status(400).send({ success: false, message: "Invalid Resource ID" });
                }

                const result = await classroomCollection.deleteOne({ _id: new ObjectId(id) });

                if (result.deletedCount === 0) {
                    return res.status(404).send({ success: false, message: "Resource not found" });
                }

                res.send({ success: true, message: "Classroom resource deleted successfully" });
            } catch (error) {
                res.status(500).send({ success: false, message: error.message });
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