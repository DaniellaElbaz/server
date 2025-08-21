const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized:false } });

/**
 * GET /parent-tasks/review?family_key=&date=YYYY-MM-DD
 * מחזיר לכל ילד את משימות היום + סטטוס (0 pending, 1 child-done, 2 approved, 3 rejected)
 */
exports.listForReviewDay = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const date = req.query.date; // YYYY-MM-DD מהלקוח (לוקאלי)
  if (!family_key || !date) return res.status(400).json({ message:'family_key and date are required' });

  const q = `
    WITH dw AS (
      SELECT ($2::date)::timestamptz AS d0, ($2::date + INTERVAL '1 day')::timestamptz AS d1
    ),
    evts AS (
      SELECT e.event_id, e.title
      FROM events e
      JOIN dw ON TRUE
      WHERE e.family_key=$1
        AND e.start_at < dw.d1
        AND COALESCE(e.end_at, e.start_at) >= dw.d0
    ),
    targets AS (
      SELECT t.event_id, t.target_type, t.child_id
      FROM eventtargets t
      WHERE t.family_key=$1
    ),
    kids as (
      SELECT c.child_id, c.child_name, c.avatar_url
      FROM children c WHERE c.family_key=$1
    ),
    rows AS (
      -- family / all_kids
      SELECT k.child_id, k.child_name, k.avatar_url, e.event_id, e.title
      FROM evts e
      CROSS JOIN kids k
      WHERE EXISTS (SELECT 1 FROM targets t WHERE t.event_id=e.event_id AND t.target_type IN ('family','all_kids'))
      UNION
      -- child ספציפי
      SELECT k.child_id, k.child_name, k.avatar_url, e.event_id, e.title
      FROM evts e
      JOIN targets t ON t.event_id=e.event_id AND t.target_type='child'
      JOIN kids k    ON k.child_id=t.child_id
    )
    SELECT
      r.child_id, r.child_name, r.avatar_url,
      r.event_id AS task_id, r.title,
      COALESCE(s.status,0)  AS status,
      COALESCE(s.points_awarded,0) AS points_awarded
    FROM rows r
    LEFT JOIN childtaskevents s
           ON s.family_key=$1 AND s.child_id=r.child_id AND s.event_id=r.event_id AND s.task_date=$2::date
    ORDER BY LOWER(r.child_name), r.task_id;
  `;
  try {
    const { rows } = await pool.query(q, [family_key, date]);
    // קיבוץ מצד הסרבר לנוחות ה-UI
    const byChild = {};
    rows.forEach(x => {
      byChild[x.child_id] ||= { child_id:x.child_id, name:x.child_name, avatar_url:x.avatar_url, tasks:[] };
      byChild[x.child_id].tasks.push({
        task_id: x.task_id, title: x.title, status: x.status, points_awarded: x.points_awarded
      });
    });
    res.json({ items: Object.values(byChild) });
  } catch (e) {
    console.error('listForReviewDay error:', e);
    res.status(500).json({ message:'Database error' });
  }
};

/**
 * POST /parent-tasks/approve
 * body: { family_key, parent_id, child_id, task_id, date, points=1 }
 * מעדכן ל-2 (approved) + מעניק נקודות (גם ב-childtaskevents וגם ב-pointsledger).
 */
exports.approveChildTask = async (req, res) => {
  const { family_key, parent_id=null, child_id, task_id, date, points=1 } = req.body || {};
  if (!family_key || !child_id || !task_id || !date)
    return res.status(400).json({ message:'family_key, child_id, task_id, date are required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ניצור/נעדכן אירוע משימה לסטטוס 2 + נקודות
    const up = await client.query(`
      INSERT INTO childtaskevents (family_key, event_id, child_id, task_date, status, child_marked_at, parent_id_confirmed, confirmed_at, points_awarded)
      VALUES ($1,$2,$3,$4::date,2, now(), $5, now(), $6)
      ON CONFLICT (event_id, child_id, task_date)
      DO UPDATE SET status=2, parent_id_confirmed=$5, confirmed_at=now(), points_awarded=$6
      RETURNING status, points_awarded, event_id
    `, [family_key, task_id, child_id, date, parent_id, points]);

    // רישום בפנקס נקודות – רק כאשר מאושרת (ונמנע כפילות על ידי רפרנס ותאריך)
    await client.query(`
      INSERT INTO pointsledger (family_key, child_id, points, source, ref_event_id, created_at)
      VALUES ($1,$2,$3,'task',$4, now())
    `, [family_key, child_id, points, task_id]);

    await client.query('COMMIT');
    res.json({ message:'Approved', points });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('approveChildTask error:', e);
    res.status(500).json({ message:'Database error' });
  } finally {
    client.release();
  }
};

/**
 * POST /parent-tasks/reject
 * body: { family_key, child_id, task_id, date }
 */
exports.rejectChildTask = async (req, res) => {
  const { family_key, child_id, task_id, date } = req.body || {};
  if (!family_key || !child_id || !task_id || !date)
    return res.status(400).json({ message:'family_key, child_id, task_id, date are required' });

  try {
    await pool.query(`
      INSERT INTO childtaskevents (family_key, event_id, child_id, task_date, status, child_marked_at, confirmed_at, points_awarded)
      VALUES ($1,$2,$3,$4::date,3, now(), now(), 0)
      ON CONFLICT (event_id, child_id, task_date)
      DO UPDATE SET status=3, confirmed_at=now(), points_awarded=0
    `, [family_key, task_id, child_id, date]);
    res.json({ message:'Rejected' });
  } catch (e) {
    console.error('rejectChildTask error:', e);
    res.status(500).json({ message:'Database error' });
  }
};

/**
 * GET /parent-tasks/leaderboard/week?family_key=&start=YYYY-MM-DD (אופציונלי)
 * מחזיר סכום נקודות בשבוע (א׳–ש׳) לכל ילד.
 */
exports.weekLeaderboard = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const start = req.query.start; // תאריך בתוך השבוע או תחילת שבוע
  if (!family_key) return res.status(400).json({ message:'family_key is required' });

  const q = `
    WITH base AS (
      SELECT
        ($2::date)::timestamptz AS d0,
        ($2::date + INTERVAL '7 days')::timestamptz AS d1
    )
    SELECT c.child_id, c.child_name AS name, c.avatar_url,
           COALESCE( SUM(pl.points), 0 ) AS points
    FROM children c
    LEFT JOIN pointsledger pl
      ON pl.family_key=c.family_key AND pl.child_id=c.child_id
     AND pl.created_at >= (SELECT d0 FROM base)
     AND pl.created_at <  (SELECT d1 FROM base)
    WHERE c.family_key=$1
    GROUP BY c.child_id, c.child_name, c.avatar_url
    ORDER BY points DESC, LOWER(c.child_name)
    LIMIT 10;
  `;
  try {
    const s = start || new Date().toISOString().slice(0,10); // ברירת מחדל: השבוע של היום
    const { rows } = await pool.query(q, [family_key, s]);
    res.json({ items: rows });
  } catch (e) {
    console.error('weekLeaderboard error:', e);
    res.status(500).json({ message:'Database error' });
  }
};
