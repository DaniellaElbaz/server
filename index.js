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
const parentCalendarRouter = require('./routers/parentCalendarRouter');
app.use('/parent-calendar', parentCalendarRouter);
const kidsTasksRouter = require('./routers/kidsTasksRouter');
app.use('/kids-legacy',  kidsTasksRouter);
const kidsRouter = require('./routers/kidsRouter');
app.use('/kids', kidsRouter);
const kidsTriviaRouter = require('./routers/kidsTriviaRouter');
app.use('/kids/trivia', kidsTriviaRouter);
const parentTasksRouter = require('./routers/parentTasksRouter');
app.use('/parent-tasks', parentTasksRouter);

app.listen(3000, () => {
  console.log('Server is running on port 3000');
});
