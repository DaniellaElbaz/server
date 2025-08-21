const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * GET /kids/tasks?family_key=&child_id=&date=YYYY-MM-DD
 * מביא את "אירועי היום" של הילד (family / all_kids / child) + סטטוס מ-childtaskevents.
 */
exports.listChildTasks = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const child_id   = Number(req.query.child_id);
  const date       = req.query.date;

  if (!family_key || !child_id || !date) {
    return res.status(400).json({ message: 'family_key, child_id and date are required' });
  }

  try {
    const q = `
      WITH day_window AS (
        SELECT
          ($1::date)::timestamptz                     AS d_start,
          ($1::date + INTERVAL '1 day')::timestamptz AS d_end
      )
      SELECT
        e.event_id            AS task_id,
        e.title,
        1                     AS points_default,
        COALESCE(s.status,0)  AS status,
        s.child_marked_at,
        s.confirmed_at,
        s.points_awarded,
        ec.color              AS category_color
      FROM events e
      CROSS JOIN day_window dw
      LEFT JOIN eventcategories ec ON ec.category_id = e.category_id
      LEFT JOIN childtaskevents s
             ON s.event_id   = e.event_id
            AND s.child_id   = $3
            AND s.task_date  = $1::date
            AND s.family_key = $2
      WHERE e.family_key = $2
        AND e.start_at < dw.d_end
        AND COALESCE(e.end_at, e.start_at) >= dw.d_start
        AND EXISTS (
          SELECT 1
          FROM eventtargets t
          WHERE t.event_id = e.event_id
            AND t.family_key = $2
            AND (
              t.target_type = 'family'
              OR t.target_type = 'all_kids'
              OR (t.target_type = 'child' AND t.child_id = $3)
            )
        )
      ORDER BY e.start_at, e.event_id;
    `;
    const { rows } = await pool.query(q, [date, family_key, child_id]);
    res.json({ items: rows });
  } catch (err) {
  console.error('listChildTasks error:', err.stack || err);
  return res.status(500).json({
    message: 'Database error',
    detail: String(err.message || err)   // נראה את זה ב-Network
  });
}

};

/**
 * POST /kids/tasks/mark-done
 * body: { family_key, child_id, task_id, date }
 * יוצר/מעדכן סטטוס: הילד סימן שסיים (points_awarded נשאר 0 עד אישור הורה).
 */
exports.markChildDone = async (req, res) => {
  const { family_key, child_id, task_id, date } = req.body || {};
  if (!family_key || !child_id || !task_id || !date) {
    return res.status(400).json({ message: 'family_key, child_id, task_id and date are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) ניסיון עדכון
    const up = await client.query(`
      UPDATE childtaskevents
         SET status=1, child_marked_at=now()
       WHERE family_key=$1 AND event_id=$2 AND child_id=$3 AND task_date=$4::date
      RETURNING event_id
    `, [family_key, task_id, child_id, date]);

    // 2) אם לא קיימת שורה – מכניסים חדשה
    if (up.rowCount === 0) {
      await client.query(`
        INSERT INTO childtaskevents
          (family_key, event_id, child_id, task_date, status, child_marked_at)
        VALUES ($1,$2,$3,$4::date,1,now())
      `, [family_key, task_id, child_id, date]);
    }

    await client.query('COMMIT');
    return res.json({ message: 'Marked as done' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('markChildDone error:', err.stack || err);
    return res.status(500).json({ message: 'Database error', detail: String(err.message || err) });
  } finally {
    client.release();
  }
};

/**
 * GET /kids/score/daily?family_key=&child_id=&date=YYYY-MM-DD
 * סכום נקודות מאושרות באותו יום (points_awarded). כרגע יעלה 0 עד אישור הורה.
 */
exports.dailyScore = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const child_id   = Number(req.query.child_id);
  const date       = req.query.date;           // YYYY-MM-DD

  if (!family_key || !child_id || !date) {
    return res.status(400).json({ message: 'family_key, child_id and date are required' });
  }

  try {
    const q = `
      WITH task_pts AS (
        SELECT COALESCE(SUM(points_awarded),0) AS pts
        FROM childtaskevents
        WHERE family_key=$1 AND child_id=$2 AND task_date=$3::date AND status=2
      ),
      trivia_pts AS (
        SELECT COALESCE(SUM(points),0) AS pts
        FROM pointsledger
        WHERE family_key=$1 AND child_id=$2
          AND (
               trivia_date = $3::date
            OR (source='trivia' AND DATE(created_at) = $3::date)
          )
      )
      SELECT (SELECT pts FROM task_pts) + (SELECT pts FROM trivia_pts) AS points
    `;
    const { rows } = await pool.query(q, [family_key, child_id, date]);
    return res.json({ points: Number(rows[0]?.points || 0) });
  } catch (err) {
    console.error('dailyScore error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};
// ---- WEEKLY LEADERBOARD (Sunday→Saturday) ----
exports.weeklyLeaderboard = async (req, res) => {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  const family_key = Number(req.query.family_key);
  // date אופציונלי להצגת שבוע של תאריך כלשהו; ברירת מחדל היום
  const baseDate = req.query.date || new Date().toISOString().slice(0,10);

  if (!family_key) return res.status(400).json({ message: 'family_key is required' });

  // גבולות שבוע: ראשון עד שבת (UTC פשטני; אם צריך לפי אזור זמן אפשר לכוון)
  const d = new Date(baseDate + 'T00:00:00Z');
  const dow = d.getUTCDay();             // 0=Sunday
  const weekStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow));
  const weekEnd   = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate() + 7));

  try {
    const q = `
      SELECT c.child_id, c.child_name AS name, c.avatar_url,
             COALESCE(SUM(p.points), 0) AS points
      FROM children c
      LEFT JOIN pointsledger p
        ON p.child_id = c.child_id
       AND p.family_key = $1
       AND p.created_at >= $2
       AND p.created_at <  $3
      WHERE c.family_key = $1
      GROUP BY c.child_id, c.child_name, c.avatar_url
      ORDER BY points DESC, c.child_name ASC
      LIMIT 3
    `;
    const { rows } = await pool.query(q, [family_key, weekStart.toISOString(), weekEnd.toISOString()]);
    res.json({
      week_start: weekStart.toISOString(),
      week_end:   weekEnd.toISOString(),
      items: rows
    });
  } catch (err) {
    console.error('weeklyLeaderboard error:', err);
    res.status(500).json({ message: 'Database error' });
  }
};
