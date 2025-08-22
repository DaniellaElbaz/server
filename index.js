// server/index.js
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();

// CORS
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));
app.use(express.json());

// ===== DB (אם את לא משתמשת ישירות כאן, זה בסדר שישאר לראוטרים) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ===== Static: כל מה שבתיקיית client =====
const CLIENT_DIR = path.resolve(__dirname, '..', 'client');
app.use(express.static(CLIENT_DIR)); // מאפשר /css/* /images/* /child-tasks.js וכו'

// ===== Routers (API) =====
const familyRouter         = require('./routers/familyRouter');
const parentCalendarRouter = require('./routers/parentCalendarRouter');
const kidsTasksRouter      = require('./routers/kidsTasksRouter'); // legacy
const kidsRouter           = require('./routers/kidsRouter');
const kidsTriviaRouter     = require('./routers/kidsTriviaRouter');
const parentTasksRouter    = require('./routers/parentTasksRouter');

app.use('/family',          familyRouter);
app.use('/parent-calendar', parentCalendarRouter);    // שימי לב: זה API
app.use('/kids-legacy',     kidsTasksRouter);
app.use('/kids',            kidsRouter);
app.use('/kids/trivia',     kidsTriviaRouter);
app.use('/parent-tasks',    parentTasksRouter);

// ===== דפי HTML =====
app.get('/',               (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'index.html')));
app.get('/child-tasks',    (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'child-tasks.html')));
app.get('/quiz',           (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'quiz.html')));
app.get('/parent-approve', (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'parent-approve.html')));
app.get('/parent-home',    (_req, res) => res.sendFile(path.join(CLIENT_DIR, 'parent-home.html')));

// חשוב: כי /parent-calendar כבר תפוס כ-API
app.get('/parent-calendar.html', (_req, res) =>
  res.sendFile(path.join(CLIENT_DIR, 'parent-calendar.html'))
);

// בריאות
app.get('/health', (_req, res) => res.json({ ok: true }));

// ===== PORT (Render) =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server is running on port', PORT);
});
