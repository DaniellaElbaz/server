const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();

/** הגשת client */
const CLIENT_DIR = path.resolve(__dirname, '..', '/client');
app.use(express.static(CLIENT_DIR));

app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));
app.use(express.json());

/** חיבור ל־DB */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/** Routers (API) */
app.use('/family',          require('./routers/familyRouter'));
app.use('/parent-calendar', require('./routers/parentCalendarRouter'));
app.use('/kids-legacy',     require('./routers/kidsTasksRouter'));
app.use('/kids',            require('./routers/kidsRouter'));
app.use('/kids/trivia',     require('./routers/kidsTriviaRouter'));
app.use('/parent-tasks',    require('./routers/parentTasksRouter'));

/** דפי Frontend */
app.get('/',               (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
app.get('/login.html',     (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'login.html')));
app.get('/members.html',   (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'members.html')));
app.get('/child-tasks',    (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'child-tasks.html')));
app.get('/quiz',           (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'quiz.html')));
app.get('/parent-approve', (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'parent-approve.html')));
app.get('/parent-calendar.html', (_req, res) =>
  res.sendFile(path.join(CLIENT_DIR, 'parent-calendar.html'))
);



/** Start server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server is running on port', PORT));
