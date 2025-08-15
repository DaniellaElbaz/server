const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));
app.use(express.json());


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});


const familyRouter = require('./routers/familyRouter');
app.use('/family', familyRouter);


app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
