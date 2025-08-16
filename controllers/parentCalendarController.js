const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/** ---------- GET /parent-calendar/events ---------- */
const listEvents = async (req, res) => {
  const family_key = parseInt(req.query.family_key, 10);
  const { from, to } = req.query;
  if (Number.isNaN(family_key) || !from || !to) {
    return res.status(400).json({ message: 'family_key, from, to are required' });
  }
  try {
    const q = `
      SELECT
        e.event_id AS id, e.title, e.notes, e.location,
        e.start_at, e.end_at, e.all_day, e.priority, e.status,
        c.category_id, c.name AS category_name, c.color AS category_color,
        COALESCE(
          json_agg(
            CASE WHEN t.target_type IS NULL THEN NULL ELSE
              json_build_object(
                'type', t.target_type,
                'child_id', t.child_id,
                'parent_id', t.parent_id,
                'child_name', ch.child_name,
                'parent_name', pr.parent_name
              )
            END
          ) FILTER (WHERE t.target_type IS NOT NULL),
          '[]'
        ) AS targets
      FROM events e
      LEFT JOIN eventcategories c ON c.category_id = e.category_id
      LEFT JOIN eventtargets t     ON t.event_id = e.event_id
      LEFT JOIN children ch        ON ch.child_id = t.child_id
      LEFT JOIN parents  pr        ON pr.parent_id = t.parent_id
      WHERE e.family_key = $1
        AND tstzrange(e.start_at, COALESCE(e.end_at, e.start_at))
            && tstzrange($2::timestamptz, $3::timestamptz)
      GROUP BY e.event_id, c.category_id, c.name, c.color
      ORDER BY e.start_at ASC
    `;
    const { rows } = await pool.query(q, [family_key, from, to]);
    return res.json({ items: rows });
  } catch (err) {
    console.error('listEvents error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};

/** ---------- POST /parent-calendar/events ----------
 * body:
 * {
 *   family_key, title, notes?, location?,
 *   all_day? (default true),
 *   start_at? / end_at?  (אם all_day=true אפשר גם "date": 'YYYY-MM-DD'),
 *   priority? (0..3), category_id?,
 *   created_by_type? ('parent'|'child'), created_by_id?,
 *   targets?: [ { type:'all_kids'|'family'|'child'|'parent', child_id?, parent_id? }, ... ]
 * }
 */
const createEvent = async (req, res) => {
  console.log('createEvent payload:', req.body);
  const {
    family_key, title, notes = null, location = null,
    all_day = true, start_at, end_at = null, date,
    priority = 0, category_id = null,
    created_by_type = null, created_by_id = null,
    targets = []
  } = req.body || {};

  if (!family_key || !title || (!start_at && !date)) {
    return res.status(400).json({ message: 'family_key, title and (start_at or date) are required' });
  }

  // נבנה טווח תאריכים עבור All-Day
  let startISO = start_at, endISO = end_at;
  if (!startISO && date) {
    const base = new Date(`${date}T00:00:00`);
    startISO = base.toISOString();
    endISO   = new Date(`${date}T23:59:00`).toISOString();
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const ins = await client.query(
      `INSERT INTO events
        (family_key, title, notes, location, start_at, end_at, all_day, priority, category_id,
         created_by_type, created_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING event_id AS id`,
      [
        family_key, title, notes, location,
        startISO, endISO, all_day, priority, category_id,
        created_by_type, created_by_id
      ]
    );
    const eventId = ins.rows[0].id;

    // Targets: אם לא נשלח כלום – ברירת מחדל 'family'
    const arr = Array.isArray(targets) && targets.length ? targets : [{ type:'family' }];
    for (const t of arr) {
      const { type, child_id = null, parent_id = null } = t || {};
      await client.query(
        `INSERT INTO eventtargets (event_id, family_key, target_type, child_id, parent_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [eventId, family_key, type, child_id, parent_id]
      );
    }

    await client.query('COMMIT');
    return res.json({ message: 'Event created', id: eventId });
  } catch (err) {
  await client.query('ROLLBACK');
  console.error('createEvent error:', err.stack || err);
  return res.status(500).json({
    message: 'Database error',
    detail: String(err.message || err)   // <-- זה מה שנראה ב-Network
  });
  }finally {
      client.release();
    }
};

/** ---------- PATCH /parent-calendar/events/:id ----------
 * מעדכן שדות שנשלחו בלבד. אם נשלח targets – נחליף את כולם.
 */
const updateEvent = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });

  const {
    title, notes, location, start_at, end_at, all_day, priority, category_id, status,
    targets
  } = req.body || {};

  const fields = [];
  const params = [];
  let i = 1;

  function push(field, value){
    fields.push(`${field} = $${i++}`);
    params.push(value);
  }
  if (title !== undefined)      push('title', title);
  if (notes !== undefined)      push('notes', notes);
  if (location !== undefined)   push('location', location);
  if (start_at !== undefined)   push('start_at', start_at);
  if (end_at !== undefined)     push('end_at', end_at);
  if (all_day !== undefined)    push('all_day', all_day);
  if (priority !== undefined)   push('priority', priority);
  if (category_id !== undefined)push('category_id', category_id);
  if (status !== undefined)     push('status', status);
  push('updated_at', new Date().toISOString());

  if (fields.length === 1) {
    // רק updated_at – אין מה לעדכן
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (fields.length) {
      const q = `UPDATE events SET ${fields.join(', ')} WHERE event_id = $${i} RETURNING event_id`;
      params.push(id);
      const r = await client.query(q, params);
      if (r.rowCount === 0) throw new Error('Not found');
    }

    if (Array.isArray(targets)) {
      await client.query(`DELETE FROM eventtargets WHERE event_id = $1`, [id]);
      // ננסה להשיג את family_key מהאירוע
      const fkR = await client.query(`SELECT family_key FROM events WHERE event_id = $1`, [id]);
      const fk = fkR.rows[0]?.family_key;
      const arr = targets.length ? targets : [{ type: 'family' }];
      for (const t of arr) {
        const { type, child_id = null, parent_id = null } = t || {};
        await client.query(
          `INSERT INTO eventtargets (event_id, family_key, target_type, child_id, parent_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [id, fk, type, child_id, parent_id]
        );
      }
    }

    await client.query('COMMIT');
    return res.json({ message: 'Event updated', id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('updateEvent error:', err);
    return res.status(500).json({ message: 'Database error' });
  } finally {
    client.release();
  }
};

/** ---------- DELETE /parent-calendar/events/:id ---------- */
const deleteEvent = async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) return res.status(400).json({ message: 'Invalid id' });
  try {
    const r = await pool.query(`DELETE FROM events WHERE event_id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ message: 'Not found' });
    return res.json({ message: 'Event deleted', id });
  } catch (err) {
    console.error('deleteEvent error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};

/** ---------- GET /parent-calendar/categories?family_key= ---------- */
const listCategories = async (req, res) => {
  const family_key = parseInt(req.query.family_key, 10);
  if (Number.isNaN(family_key)) return res.status(400).json({ message: 'family_key is required' });
  try {
    const q = `SELECT category_id AS id, name, color FROM eventcategories WHERE family_key = $1 ORDER BY sort_order, LOWER(name)`;
    const { rows } = await pool.query(q, [family_key]);
    return res.json({ items: rows });
  } catch (err) {
    console.error('listCategories error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};

/** ---------- POST /parent-calendar/categories ---------- */
const createCategory = async (req, res) => {
  const { family_key, name, color = '#5AA9FF', sort_order = 100 } = req.body || {};
  if (!family_key || !name) return res.status(400).json({ message: 'family_key and name are required' });
  try {
    const q = `
      INSERT INTO eventcategories (family_key, name, color, sort_order)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (family_key, name) DO NOTHING
      RETURNING category_id AS id
    `;
    const { rows } = await pool.query(q, [family_key, name, color, sort_order]);
    if (!rows.length) return res.status(409).json({ message: 'Category already exists' });
    return res.json({ message: 'Category created', id: rows[0].id });
  } catch (err) {
    console.error('createCategory error:', err);
    return res.status(500).json({ message: 'Database error' });
  }
};
/** ---------- GET /parent-calendar/events/:id ---------- */
const getEventById = async (req, res) => {
  const id = Number(req.params.id);
  const family_key = Number(req.query.family_key);
  if (!id || !family_key) return res.status(400).json({ message:'id and family_key are required' });

  const q = `
    SELECT e.event_id AS id, e.title, e.notes, e.location,
           e.start_at, e.end_at, e.all_day, e.priority,
           e.category_id, c.name AS category_name, c.color AS category_color,
           COALESCE(json_agg(
             CASE WHEN t.target_type IS NULL THEN NULL ELSE
               json_build_object('type',t.target_type,'child_id',t.child_id,'parent_id',t.parent_id)
             END
           ) FILTER (WHERE t.target_type IS NOT NULL), '[]') AS targets
    FROM events e
    LEFT JOIN eventcategories c ON c.category_id = e.category_id
    LEFT JOIN eventtargets t     ON t.event_id    = e.event_id
    WHERE e.event_id=$1 AND e.family_key=$2
    GROUP BY e.event_id, c.name, c.color
    LIMIT 1`;
  const { rows } = await pool.query(q, [id, family_key]);
  if (!rows.length) return res.status(404).json({ message:'Event not found' });
  res.json(rows[0]);
};
module.exports = {
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  listCategories,
  getEventById,
  createCategory
};
