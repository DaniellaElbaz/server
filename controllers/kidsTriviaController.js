const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false} });

/** כלי עזר: "אקראי דטרמיניסטי" לפי seed */
function seededRand(seed) {
  let x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}
function pickOne(arr, seed) {
  if (!arr.length) return null;
  const i = Math.floor(seededRand(seed) * arr.length);
  return arr[i];
}
exports.triviaToday = async (req, res) => {
  try {
    const family_key = Number(req.query.family_key);
    if (!family_key) {
      return res.status(400).json({ message: 'family_key is required' });
    }
    const date = (req.query.date || new Date().toISOString().slice(0,10)); // YYYY-MM-DD

    // בדיקה אם כבר יש רשומה נכונה להיום (מישהו במשפחה ענה נכון)
    const q = `
      SELECT EXISTS (
        SELECT 1
        FROM triviadaily
        WHERE family_key = $1
          AND trivia_date = $2::date
          AND correct = TRUE
      ) AS answered
    `;
    const { rows } = await pool.query(q, [family_key, date]);

    if (rows[0]?.answered) {
      return res.status(409).json({ message: 'Trivia already answered today', date });
    }
    return res.json({ available: true, date });
  } catch (err) {
    console.error('triviaToday error:', err.stack || err);
    return res.status(500).json({ message: 'Database error', detail: String(err.message || err) });
  }
};
/** בונה שאלה דטרמיניסטית למשפחה/תאריך (כולם יקבלו אותה שאלה) */
async function buildQuestion(family_key, date) {
  // seed קבוע: YYYYMMDD + family_key
  const seed = Number(String(date).replace(/-/g,'')) * 1000 + Number(family_key);

  // נאסוף קנדידטים
  const client = await pool.connect();
  try {
    // 1) ימי הולדת
    const bq = await client.query(
      `SELECT child_id, child_name AS name, birth_date
         FROM Children WHERE family_key=$1 AND birth_date IS NOT NULL`,
      [family_key]
    );
    const kids = bq.rows;

    // 2) כותרות "משימות ילדים" מאתמול
    const y = date; // מגיע מהלקוח כ-YYYY-MM-DD; לא עושים המרה ל-timestamptz
    const tq = await client.query(
      `SELECT DISTINCT e.title
         FROM Events e
         JOIN EventTargets t ON t.event_id=e.event_id
        WHERE e.family_key=$1
          AND (e.start_at::date) <= $2::date
          AND (COALESCE(e.end_at, e.start_at)::date) >= $2::date
          AND t.target_type IN ('all_kids','child')`,
      [family_key, y]
    );
    const yesterdayTitles = tq.rows.map(r => r.title);

    // מועמדים לצק־אוף – כותרות אחרות (לא מאתמול)
    const dq = await client.query(
      `SELECT DISTINCT e.title
         FROM Events e
        WHERE e.family_key=$1
          AND e.title <> ALL($2)
        ORDER BY e.start_at DESC
        LIMIT 30`,
      [family_key, yesterdayTitles.length ? yesterdayTitles : ['__none__']]
    );
    const otherTitles = dq.rows.map(r => r.title);

    // החלטה על סוג שאלה לפי seed כדי לגוון
    const useBirthday = kids.length >= 2 && seededRand(seed) < 0.5;

    if (useBirthday) {
      // ---- שאלה על ימי הולדת: "למי יש יום הולדת בחודש <X>?"
      const kid = pickOne(kids, seed);                     // נכון
      const month = new Date(kid.birth_date).toLocaleString('en', { month:'long' });

      // מסיחים – ילדים מחודשים אחרים
      const distract = kids.filter(k => (
        new Date(k.birth_date).getMonth() !== new Date(kid.birth_date).getMonth()
      ));

      const optionsPool = distract.slice(0, 10);
      while (optionsPool.length < 3 && kids.length > optionsPool.length+1) {
        // אם חסרים מסיחים, נוסיף ילדים אקראיים נוספים
        const extra = pickOne(kids, seed + optionsPool.length + 1);
        if (extra.child_id !== kid.child_id && !optionsPool.find(x=>x.child_id===extra.child_id)) {
          optionsPool.push(extra);
        } else break;
      }
      const opts = [kid, ...optionsPool].slice(0,4)
        .sort((a,b)=> a.name.localeCompare(b.name));       // סדר יציב

      const correctIndex = opts.findIndex(o => o.child_id === kid.child_id);

      return {
        question_id: `B-${seed}`,
        type: 'birthday_month',
        text: `Whose birthday is in ${month}?`,
        options: opts.map(o => o.name),
        correctIndex
      };
    }

    // ---- שאלה על משימות אתמול: "מה לא הופיע אתמול?"
    // אם אין לנו כותרות מאתמול או אין מסיחים – ניפול חזרה לשאלת יומולדת.
    if (yesterdayTitles.length && otherTitles.length) {
      const inYesterday = [...yesterdayTitles].sort((a,b)=> a.localeCompare(b));
      const notYesterday = pickOne(otherTitles, seed);     // זה הנכון (לא הופיע)
      // ניקח עד 3 כותרות מאתמול + המסיח (שהוא הנכון)
      const shown = inYesterday.slice(0, 3);
      const opts = [...shown, notYesterday]
        .slice(0,4)
        .sort((a,b)=> a.localeCompare(b));
      const correctIndex = opts.findIndex(t => t === notYesterday);

      return {
        question_id: `T-${seed}`,
        type: 'missing_task_yesterday',
        text: 'Which of the following tasks did not appear in the tasks yesterday?',
        options: opts,
        correctIndex
      };
    }

    // אם אין נתונים לשאלה על משימות – תמיד נשאל על יומולדת (אם יש לפחות ילד אחד)
    if (kids.length >= 1) {
      const kid = pickOne(kids, seed + 42);
      const month = new Date(kid.birth_date).toLocaleString('en', { month:'long' });
      const others = kids.filter(k => k.child_id !== kid.child_id).slice(0,3);
      const opts = [kid, ...others].map(o=>o.name).slice(0,4).sort();
      const correctIndex = opts.findIndex(n => n === kid.name);
      return {
        question_id: `B-${seed}`,
        type: 'birthday_month',
        text: `Whose birthday is in ${month}?`,
        options: opts,
        correctIndex
      };
    }

    // אין Kids / אין כלום: נחזיר null
    return null;
  } finally {
    client.release();
  }
}

/** GET /kids/trivia/today */
exports.getTodayQuestion = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const child_id   = Number(req.query.child_id);
  const date       = req.query.date; // YYYY-MM-DD מהלקוח

  if (!family_key || !child_id || !date) {
    return res.status(400).json({ message: 'family_key, child_id, date are required' });
  }

  try {
    // אם הילד כבר ניסה – נחזיר "answered"
    const r0 = await pool.query(
      `SELECT correct, points_awarded
         FROM TriviaDaily
        WHERE family_key=$1 AND child_id=$2 AND trivia_date=$3::date
        LIMIT 1`,
      [family_key, child_id, date]
    );
    if (r0.rows.length) {
      return res.json({ status: 'answered', you: r0.rows[0] });
    }

    // אם מישהו במשפחה כבר ענה נכון – "closed"
    const r1 = await pool.query(
      `SELECT 1
         FROM TriviaDaily
        WHERE family_key=$1 AND trivia_date=$2::date AND correct=TRUE
        LIMIT 1`,
      [family_key, date]
    );
    if (r1.rows.length) {
      return res.json({ status: 'closed' });
    }

    // אחרת – נבנה שאלה
    const q = await buildQuestion(family_key, date);
    if (!q) return res.json({ status:'no_question' });

    // לא נחשוף correctIndex ללקוח – נשמור רק question_id, text, options
    const { question_id, text, options, type } = q;
    return res.json({ status: 'open', question: { question_id, type, text, options } });
  } catch (e) {
    console.error('getTodayQuestion error:', e);
    res.status(500).json({ message: 'Database error' });
  }
};

/** POST /kids/trivia/answer */
exports.submitAnswer = async (req, res) => {
  const { family_key, child_id, date, question_id, choice } = req.body || {};
  if (!family_key || !child_id || !date || !question_id || typeof choice !== 'number') {
    return res.status(400).json({ message: 'family_key, child_id, date, question_id, choice are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) אם הילד כבר ענה היום – נחסום
    const me = await client.query(
      `SELECT 1 FROM TriviaDaily WHERE family_key=$1 AND child_id=$2 AND trivia_date=$3::date LIMIT 1`,
      [family_key, child_id, date]
    );
    if (me.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'already_answered' });
    }

    // 2) אם כבר יש תשובה נכונה במשפחה – סגור
    const fam = await client.query(
      `SELECT 1 FROM TriviaDaily WHERE family_key=$1 AND trivia_date=$2::date AND correct=TRUE LIMIT 1`,
      [family_key, date]
    );
    if (fam.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'closed' });
    }

    // 3) בונים שוב את השאלה בצד השרת ומוודאים את התשובה
    const q = await buildQuestion(family_key, date);
    if (!q || q.question_id !== question_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'invalid_question' });
    }
    const isCorrect = (choice === q.correctIndex);

    // 4) רושמים ניסיון ב-TriviaDaily
    const points = isCorrect ? 5 : 0;
    await client.query(
      `INSERT INTO TriviaDaily (family_key, child_id, trivia_date, correct, points_awarded)
       VALUES ($1,$2,$3::date,$4,$5)`,
      [family_key, child_id, date, isCorrect, points]
    );

    // 5) אם נכון – נקרדט ב-PointsLedger
    if (isCorrect) {
      await client.query(
        `INSERT INTO PointsLedger (family_key, child_id, points, source, trivia_date)
         VALUES ($1,$2,$3,'trivia',$4::date)`,
        [family_key, child_id, points, date]
      );
    }

    await client.query('COMMIT');
    res.json({ correct: isCorrect, points });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('submitAnswer error:', e);
    res.status(500).json({ message: 'Database error' });
  } finally {
    client.release();
  }
};
