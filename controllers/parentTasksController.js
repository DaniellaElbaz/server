const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
/**
 * GET /parent-tasks/leaderboard/week?family_key=&start=YYYY-MM-DD
 * סכום נקודות לשבוע (א׳–ש׳) סביב התאריך שנשלח.
 */
exports.weeklyLeaderboard = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const startDate  = req.query.start; // יום כלשהו בשבוע הרצוי
  if (!family_key || !startDate) {
    return res.status(400).json({ message: 'family_key and start are required' });
  }
  try {
    // מחשבים תחילת שבוע (יום ראשון) וסופו
    const q = `
      WITH base AS (
        SELECT $1::date AS d
      ),
      span AS (
        SELECT
          (d - ((EXTRACT(DOW FROM d)::int) % 7))::date AS d0,  -- Sunday
          (d - ((EXTRACT(DOW FROM d)::int) % 7) + 7)::date AS d1
        FROM base
      )
      SELECT
        c.child_id,
        c.child_name AS name,
        c.avatar_url,
        COALESCE(SUM(p.points), 0) AS points
      FROM children c
      LEFT JOIN pointsledger p
        ON p.family_key = $2
       AND p.child_id   = c.child_id
       AND p.created_at >= (SELECT d0 FROM span)
       AND p.created_at <  (SELECT d1 FROM span)
      WHERE c.family_key = $2
      GROUP BY c.child_id, c.child_name, c.avatar_url
      ORDER BY points DESC, LOWER(c.child_name)
      LIMIT 10
    `;
    const { rows } = await pool.query(q, [startDate, family_key]);
    return res.json({ items: rows });
  } catch (err) {
    console.error('weeklyLeaderboard error:', err.stack || err);
    return res.status(500).json({ message: 'Database error', detail: String(err.message || err) });
  }
};
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
 * GET /parent-tasks/review?family_key=&date=YYYY-MM-DD
 * מחזיר לכל ילד את רשימת ה"משימות" של אותו היום + סטטוס
 *   status: 0=pending, 1=child_done, 2=approved, 3=rejected
 */
exports.reviewDay = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const date = req.query.date;
  if (!family_key || !date) {
    return res.status(400).json({ message: 'family_key and date are required' });
  }

  try {
    const q = `
      WITH win AS (
        SELECT ($1::date)::timestamptz AS d0,
               ($1::date + INTERVAL '1 day')::timestamptz AS d1
      ),
      kids AS (
        SELECT child_id, child_name, avatar_url
        FROM children
        WHERE family_key = $2
      ),
      eligible AS (
        -- "מרחיבים" כל אירוע לכל ילד רלוונטי לפי ה-targets
        SELECT e.event_id, e.title, k.child_id
        FROM events e
        CROSS JOIN kids k
        CROSS JOIN win w
        WHERE e.family_key = $2
          AND e.start_at < w.d1
          AND COALESCE(e.end_at, e.start_at) >= w.d0
          AND EXISTS (
            SELECT 1
            FROM eventtargets t
            WHERE t.event_id = e.event_id
              AND t.family_key = $2
              AND (
                t.target_type IN ('family','all_kids') OR
                (t.target_type='child' AND t.child_id = k.child_id)
              )
          )
      )
      SELECT
        k.child_id,
        k.child_name AS name,
        k.avatar_url,
        COALESCE(
          json_agg(
            json_build_object(
              'task_id', el.event_id,
              'title',   el.title,
              'status',  COALESCE(s.status, 0)
            )
            ORDER BY el.event_id
          ) FILTER (WHERE el.event_id IS NOT NULL),
          '[]'
        ) AS tasks
      FROM kids k
      LEFT JOIN eligible el
        ON el.child_id = k.child_id
      LEFT JOIN childtaskevents s
        ON s.family_key = $2
       AND s.event_id   = el.event_id
       AND s.child_id   = k.child_id
       AND s.task_date  = $1::date
      GROUP BY k.child_id, k.child_name, k.avatar_url
      ORDER BY LOWER(k.child_name);
    `;
    const { rows } = await pool.query(q, [date, family_key]);

    // אופציונלי: להסתיר ילדים בלי משימות באותו יום
    const items = rows
      .map(r => ({ ...r, tasks: r.tasks || [] }))
      .filter(k => k.tasks.length > 0);

    return res.json({ items });
  } catch (err) {
    console.error('reviewDay error:', err.stack || err);
    return res.status(500).json({ message: 'Database error', detail: String(err.message || err) });
  }
};

/**
 * POST /parent-tasks/approve
 * body: { family_key, parent_id, child_id, task_id (== event_id), date, points?=1 }
 * מאשר משימה (status=2), מעניק נקודה, ומוסיף לרשומת PointsLedger (אם לא הוענקה לפני כן).
 */
exports.approveTask = async (req, res) => {
  const { family_key, parent_id, child_id, task_id, date, points = 1 } = req.body || {};
  if (!family_key || !child_id || !task_id || !date) {
    return res.status(400).json({ message: 'family_key, child_id, task_id and date are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // מה הסטטוס הנוכחי?
    const prev = await client.query(
      `SELECT status FROM childtaskevents
       WHERE family_key=$1 AND event_id=$2 AND child_id=$3 AND task_date=$4::date`,
      [family_key, task_id, child_id, date]
    );
    const prevStatus = prev.rows[0]?.status ?? null;

    // עדכון/יצירה ל-APPROVED
    await client.query(
      `INSERT INTO childtaskevents
         (family_key, event_id, child_id, task_date, status, child_marked_at,
          parent_id_confirmed, confirmed_at, points_awarded)
       VALUES($1,$2,$3,$4::date,2, COALESCE(NULL, now()), $5, now(), $6)
       ON CONFLICT (event_id, child_id, task_date)
       DO UPDATE SET
         status=2,
         parent_id_confirmed=$5,
         confirmed_at=now(),
         points_awarded=$6
      `,
      [family_key, task_id, child_id, date, parent_id || null, points]
    );

    // נזכה בנקודה רק אם זה עובר ל-2 עכשיו (ולא כבר היה 2)
    if (prevStatus !== 2) {
      await client.query(
        `INSERT INTO pointsledger (family_key, child_id, points, source, ref_event_id)
         VALUES ($1,$2,$3,'task',$4)`,
        [family_key, child_id, points, task_id]
      );
    }

    await client.query('COMMIT');
    return res.json({ message: 'Approved', awarded: prevStatus === 2 ? 0 : points });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('approveTask error:', err.stack || err);
    return res.status(500).json({ message: 'Database error', detail: String(err.message || err) });
  } finally {
    client.release();
  }
};
/**
 * POST /parent-tasks/reject
 * body: { family_key, child_id, task_id, date }
 * דוחה משימה (status=3) ולא מעניק נקודות. (לא מוחק נקודות שכבר ניתנו; אם תרצי – נוסיף ביטול)
 */
exports.rejectTask = async (req, res) => {
  const { family_key, child_id, task_id, date } = req.body || {};
  if (!family_key || !child_id || !task_id || !date) {
    return res.status(400).json({ message: 'family_key, child_id, task_id and date are required' });
  }
  try {
    await pool.query(
      `INSERT INTO childtaskevents (family_key, event_id, child_id, task_date, status)
       VALUES ($1,$2,$3,$4::date,3)
       ON CONFLICT (event_id, child_id, task_date)
       DO UPDATE SET status=3, points_awarded=0`,
      [family_key, task_id, child_id, date]
    );
    return res.json({ message: 'Rejected' });
  } catch (err) {
    console.error('rejectTask error:', err.stack || err);
    return res.status(500).json({ message: 'Database error', detail: String(err.message || err) });
  }
};

