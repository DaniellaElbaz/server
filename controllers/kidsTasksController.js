const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// עזר: התחלת שבוע (א' 00:00:00) לפי תאריך מקומי/UTC
function weekStartSunday(d) {
  const dt = new Date(d);
  const dow = dt.getUTCDay();           // 0=א'
  const start = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - dow); // חזרה לא'
  return start;
}

/** GET /kids/tasks?family_key=&child_id=&date=YYYY-MM-DD */
exports.listChildTasksForDay = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const child_id   = Number(req.query.child_id);
  const dateStr    = req.query.date || new Date().toISOString().slice(0,10);

  if (!family_key || !child_id) {
    return res.status(400).json({ message: 'family_key and child_id are required' });
  }

  try {
    const q = `
      SELECT
        a.assignment_id,
        t.task_id,
        t.title,
        t.points_default,
        COALESCE(e.status, 0)    AS status,     -- 0=Pending,1=Child done,2=Approved,3=Rejected
        e.event_id
      FROM ChildTaskAssignments a
      JOIN ChildTasks t ON t.task_id = a.task_id AND t.active
      LEFT JOIN ChildTaskEvents e
        ON e.child_id = a.child_id
       AND e.task_id  = a.task_id
       AND e.task_date= $3::date
      WHERE a.family_key = $1
        AND a.child_id   = $2
        AND (a.start_date IS NULL OR a.start_date <= $3::date)
        AND (a.end_date   IS NULL OR a.end_date   >= $3::date)
        AND (
          a.recurrence = 'daily'
          OR (a.recurrence = 'once'   AND a.start_date = $3::date)
          OR (a.recurrence = 'weekly' AND ((a.days_mask >> EXTRACT(DOW FROM $3::date))::int & 1) = 1)
        )
      ORDER BY LOWER(t.title)
    `;
    const { rows } = await pool.query(q, [family_key, child_id, dateStr]);
    return res.json({ date: dateStr, items: rows });
  } catch (err) {
    console.error('listChildTasksForDay error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};

/** POST /kids/tasks/mark-done
 * body: { family_key, child_id, task_id, date? (YYYY-MM-DD) }
 * יוצר/מעודכן אינסטנס יומי לסטטוס 1 (ילד סיים)
 */
exports.childMarkDone = async (req, res) => {
  const { family_key, child_id, task_id } = req.body || {};
  const dateStr = req.body?.date || new Date().toISOString().slice(0,10);

  if (!family_key || !child_id || !task_id) {
    return res.status(400).json({ message: 'family_key, child_id, task_id are required' });
  }

  try {
    const q = `
      INSERT INTO ChildTaskEvents (family_key, assignment_id, task_id, child_id, task_date, status, child_marked_at)
      VALUES (
        $1,
        (SELECT assignment_id FROM ChildTaskAssignments
          WHERE family_key=$1 AND child_id=$2 AND task_id=$3 LIMIT 1),
        $3, $2, $4::date, 1, now()                -- 1=child_done
      )
      ON CONFLICT (child_id, task_id, task_date)
      DO UPDATE SET status = 1, child_marked_at = now()
      RETURNING event_id, status
    `;
    const r = await pool.query(q, [family_key, child_id, task_id, dateStr]);
    return res.json({ message: 'Marked as done', event_id: r.rows[0].event_id, status: r.rows[0].status });
  } catch (err) {
    console.error('childMarkDone error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};

/** GET /kids/score/daily?family_key=&child_id=&date=YYYY-MM-DD */
exports.childDailyScore = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const child_id   = Number(req.query.child_id);
  const dateStr    = req.query.date || new Date().toISOString().slice(0,10);
  if (!family_key || !child_id) return res.status(400).json({ message: 'family_key and child_id are required' });

  try {
    const q = `
      SELECT COALESCE(SUM(points),0) AS points
      FROM PointsLedger
      WHERE family_key=$1 AND child_id=$2 AND (created_at AT TIME ZONE 'UTC')::date = $3::date
    `;
    const { rows } = await pool.query(q, [family_key, child_id, dateStr]);
    return res.json({ date: dateStr, points: Number(rows[0].points || 0) });
  } catch (err) {
    console.error('childDailyScore error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};

/** GET /kids/score/leaderboard?family_key=&week_start=YYYY-MM-DD (אופציונלי)
 * אם לא נשלח week_start – ניקח את תחילת השבוע הנוכחי (א')
 */
exports.familyLeaderboardThisWeek = async (req, res) => {
  const family_key = Number(req.query.family_key);
  if (!family_key) return res.status(400).json({ message: 'family_key is required' });

  const now = new Date();
  const start = req.query.week_start ? new Date(req.query.week_start) : weekStartSunday(now);
  const end   = new Date(start); end.setUTCDate(end.getUTCDate()+7);

  try {
    const q = `
      SELECT
        c.child_id AS id,
        COALESCE(c.nickname, c.child_name) AS name,
        c.avatar_url,
        COALESCE(SUM(p.points),0) AS points
      FROM Children c
      LEFT JOIN PointsLedger p
        ON p.child_id=c.child_id AND p.family_key=$1
       AND p.created_at >= $2 AND p.created_at < $3
      WHERE c.family_key = $1
      GROUP BY c.child_id, c.nickname, c.child_name, c.avatar_url
      ORDER BY points DESC, name ASC
      LIMIT 10
    `;
    const { rows } = await pool.query(q, [family_key, start.toISOString(), end.toISOString()]);
    return res.json({ week_start: start.toISOString().slice(0,10), items: rows });
  } catch (err) {
    console.error('familyLeaderboardThisWeek error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};
