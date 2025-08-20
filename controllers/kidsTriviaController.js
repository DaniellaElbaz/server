const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// בניית חלון זמן של "אתמול" (עבור family_key + date)
const YESTERDAY_TITLES_SQL = `
WITH day_window AS (
  SELECT
    ($2::date - INTERVAL '1 day')::timestamptz AS d_start,
    ($2::date)::timestamptz                     AS d_end
)
SELECT DISTINCT e.title
FROM events e
CROSS JOIN day_window dw
WHERE e.family_key = $1
  AND e.start_at < dw.d_end
  AND COALESCE(e.end_at, e.start_at) >= dw.d_start
  AND e.title IS NOT NULL AND e.title <> ''
ORDER BY 1;
`;

// כותרות של אירועים בימים אחרים (דיסטרקטורים)
const OTHER_TITLES_SQL = `
WITH day_window AS (
  SELECT
    ($2::date - INTERVAL '1 day')::timestamptz AS d_start,
    ($2::date)::timestamptz                     AS d_end
)
SELECT DISTINCT e.title
FROM events e
CROSS JOIN day_window dw
WHERE e.family_key = $1
  AND NOT (e.start_at < dw.d_end AND COALESCE(e.end_at, e.start_at) >= dw.d_start)
  AND e.title IS NOT NULL AND e.title <> ''
ORDER BY random()
LIMIT 10;
`;

// GET /kids/trivia/today?family_key=&child_id=&date=YYYY-MM-DD
exports.getTodayQuestion = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const date = (req.query.date || new Date().toISOString().slice(0,10));

  if (!family_key) return res.status(400).json({ message: 'family_key is required' });

  try {
    // אם כבר נענתה נכון היום – נחזיר 409 כדי להציג "נענתה כבר"
    const lockQ = `
      SELECT 1 FROM triviadaily
      WHERE family_key=$1 AND trivia_date=$2::date AND correct=TRUE
      LIMIT 1`;
    const lock = await pool.query(lockQ, [family_key, date]);
    if (lock.rowCount) {
      return res.status(409).json({ message: 'Trivia already answered today', date });
    }

    // אוספים כותרות מאתמול
    const y = await pool.query(YESTERDAY_TITLES_SQL, [family_key, date]);
    const yesterday = y.rows.map(r => r.title);

    // אם אין מספיק מידע – אין שאלה להיום
    if (yesterday.length === 0) {
      return res.status(204).json({ message: 'Not enough data for a question', available: false });
    }

    // אוספים דיסטרקטורים (כותרות שלא הופיעו אתמול)
    const o = await pool.query(OTHER_TITLES_SQL, [family_key, date]);
    const others = o.rows.map(r => r.title).filter(t => !yesterday.includes(t));
    if (others.length === 0) {
      return res.status(204).json({ message: 'Not enough data for options', available: false });
    }

    // בוחרים תשובה נכונה אחת (שלא הופיעה אתמול) + עד 3 שהופיעו אתמול
    const decoy = others[0];
    const shuffledY = yesterday.sort(() => Math.random() - 0.5).slice(0, 3);

    // מרכיבים 4 אפשרויות ומערבבים
    const options = [...shuffledY, decoy].sort(() => Math.random() - 0.5);

    return res.json({
      date,
      type: 'not_in_yesterday',
      text: 'Which of the following tasks did not appear in the tasks yesterday?',
      options
    });
  } catch (err) {
    console.error('getTodayQuestion error:', err.stack || err);
    return res.status(500).json({ message: 'Database error', detail: String(err.message || err) });
  }
};

// POST /kids/trivia/answer  { family_key, child_id, date, choice }
exports.submitAnswer = async (req, res) => {
  const { family_key, child_id, date, choice } = req.body || {};
  if (!family_key || !child_id || !date || !choice) {
    return res.status(400).json({ message: 'family_key, child_id, date and choice are required' });
  }

  const client = await pool.connect();
  try {
    // אם כבר נענתה נכון היום – ננעל
    const lockQ = `
      SELECT 1 FROM triviadaily
      WHERE family_key=$1 AND trivia_date=$2::date AND correct=TRUE
      LIMIT 1`;
    const lock = await client.query(lockQ, [family_key, date]);
    if (lock.rowCount) {
      return res.status(409).json({ message: 'Trivia already answered today', date });
    }

    // בודקים אם ה־choice הופיע אתמול (אם כן – התשובה שגויה)
    const y = await client.query(YESTERDAY_TITLES_SQL, [family_key, date]);
    const yesterday = new Set(y.rows.map(r => r.title));
    const isCorrect = !yesterday.has(choice);

    await client.query('BEGIN');

    // רשומת טריוויה יומית (unique על child_id,trivia_date)
    const points = isCorrect ? 5 : 0;
    await client.query(`
      INSERT INTO triviadaily (family_key, child_id, trivia_date, correct, points_awarded)
      VALUES ($1,$2,$3::date,$4,$5)
      ON CONFLICT (child_id, trivia_date)
      DO UPDATE SET correct=EXCLUDED.correct, points_awarded=EXCLUDED.points_awarded
    `, [family_key, child_id, date, isCorrect, points]);

    // אם נכונה – מוסיפים גם ל־PointsLedger
    if (isCorrect) {
      await client.query(`
        INSERT INTO pointsledger (family_key, child_id, points, source, trivia_date)
        VALUES ($1,$2,$3,'trivia',$4::date)
      `, [family_key, child_id, points, date]);
    }

    await client.query('COMMIT');
    return res.json({ correct: isCorrect, points });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('submitAnswer error:', err.stack || err);
    return res.status(500).json({ message: 'Database error', detail: String(err.message || err) });
  } finally {
    client.release();
  }
};
