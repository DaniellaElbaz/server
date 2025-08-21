const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * GET /parent-tasks/review?family_key=&date=YYYY-MM-DD
 * מחזיר את כל ChildTaskEvents של היום במצב 1 (הילד סימן שסיים) עם פרטי הילד והאירוע.
 */
exports.listForReview = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const date = req.query.date;
  if (!family_key || !date) {
    return res.status(400).json({ message: 'family_key and date are required' });
  }

  try {
    const q = `
      SELECT
        s.event_id,
        s.child_id,
        ch.child_name,
        e.title,
        e.priority,
        ec.name  AS category_name,
        ec.color AS category_color,
        s.status,
        s.child_marked_at
      FROM childtaskevents s
      JOIN children ch       ON ch.child_id = s.child_id AND ch.family_key = $1
      JOIN events   e        ON e.event_id  = s.event_id  AND e.family_key  = $1
      LEFT JOIN eventcategories ec ON ec.category_id = e.category_id
      WHERE s.family_key = $1
        AND s.task_date  = $2::date
        AND s.status     = 1              -- ילד סימן "בוצע"
      ORDER BY s.child_marked_at DESC, e.title;
    `;
    const { rows } = await pool.query(q, [family_key, date]);
    return res.json({ items: rows });
  } catch (err) {
    console.error('listForReview error:', err.stack || err);
    return res.status(500).json({ message: 'Database error' });
  }
};

/**
 * POST /parent-tasks/approve
 * body: { family_key, event_id, child_id, date, parent_id?, points?=1 }
 * מאשר משימה ומעניק נקודות (מוסיף לרישום הנקודות).
 */
exports.approveOne = async (req, res) => {
  const { family_key, event_id, child_id, date, parent_id = null, points = 1 } = req.body || {};
  if (!family_key || !event_id || !child_id || !date) {
    return res.status(400).json({ message: 'family_key, event_id, child_id, date are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // עדכון סטטוס לאושר
    const up = await client.query(
      `UPDATE childtaskevents
         SET status = 2,
             points_awarded = $6,
             parent_id_confirmed = $5,
             confirmed_at = now()
       WHERE family_key = $1
         AND event_id    = $2
         AND child_id    = $3
         AND task_date   = $4::date
         AND status      = 1
       RETURNING event_id`,
      [family_key, event_id, child_id, date, parent_id, points]
    );
    if (up.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Not found or already processed' });
    }

    // רישום הנקודות (כדי להזין ל־Leaderboard שבועי)
    await client.query(
      `INSERT INTO pointsledger (family_key, child_id, points, source, ref_event_id, created_at)
       VALUES ($1,$2,$3,'task',$4, now())`,
      [family_key, child_id, points, event_id]
    );

    await client.query('COMMIT');
    return res.json({ message: 'Approved', points });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('approveOne error:', err.stack || err);
    return res.status(500).json({ message: 'Database error' });
  } finally {
    client.release();
  }
};

/**
 * POST /parent-tasks/reject
 * body: { family_key, event_id, child_id, date }
 * דחיית משימה – לא מעניקה נקודות.
 */
exports.rejectOne = async (req, res) => {
  const { family_key, event_id, child_id, date } = req.body || {};
  if (!family_key || !event_id || !child_id || !date) {
    return res.status(400).json({ message: 'family_key, event_id, child_id, date are required' });
  }

  try {
    const q = `
      UPDATE childtaskevents
         SET status = 3, confirmed_at = now(), points_awarded = 0
       WHERE family_key = $1 AND event_id = $2 AND child_id = $3 AND task_date = $4::date AND status IN (0,1)
    `;
    const r = await pool.query(q, [family_key, event_id, child_id, date]);
    if (!r.rowCount) return res.status(404).json({ message: 'Not found or already processed' });
    return res.json({ message: 'Rejected' });
  } catch (err) {
    console.error('rejectOne error:', err.stack || err);
    return res.status(500).json({ message: 'Database error' });
  }
};
