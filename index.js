const express = require('express');
const dotenv = require('dotenv')
const cors = require('cors')
dotenv.config();

const { MongoClient, ServerApiVersion } = require('mongodb');

const app = express()
const port = process.env.PORT;
const uri = process.env.MONGO_DB_URI;

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