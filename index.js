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

// ---- דפי HTML (למנוע התנגשות עם נתיבי API, נשתמש בשמות הקבצים) ----
app.get('/', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, '../client/index.html'));
});

// דפי האפליקציה (Front-end pages):
app.get('/child-tasks', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, '../client/child-tasks.html'));
});

app.get('/quiz', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, '../client/quiz.html'));
});

app.get('/parent-approve', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, '../client/parent-approve.html'));
});

// חשוב: /parent-calendar הוא API קיים, לכן את הדף נגיש תחת השם הקובץ:
app.get('/parent-calendar.html', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, '../client/parent-calendar.html'));
});

// אופציונלי: דף בית הורה
app.get('/parent-home.html', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, '../client/parent-home.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on port', PORT);
});