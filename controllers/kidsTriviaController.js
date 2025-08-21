// controllers/kidsTriviaController.js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// עוזר קטן
function shuffle(arr){ return arr.map(v=>[Math.random(),v]).sort((a,b)=>a[0]-b[0]).map(x=>x[1]); }
function uniq(arr){ return [...new Set(arr.filter(Boolean))]; }
const crypto = require('crypto');

function signCorrectText(txt) {
  const secret = process.env.TRIVIA_SECRET || 'dev-secret';
  return crypto.createHash('sha256').update(`${txt}|${secret}`).digest('hex');
}

// מביא שאלה מ-API חיצוני וממפה לפורמט האחיד שלנו
async function fetchExternalQuestion() {
  // 1) quizapi.io עם מפתח (מומלץ)
  const token = process.env.QUIZ_API_TOKEN;
  try {
    if (token) {
      const r = await fetch('https://quizapi.io/api/v1/questions?limit=1&tags=general_knowledge', {
        headers: { 'X-Api-Key': token }
      });
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr) && arr[0]) {
          const q = arr[0];
          // תשובות מגיעות כאובייקט answer_a..f ו-correct_answers.answer_a_correct = "true"/"false"
          const all = Object.entries(q.answers || {})
            .filter(([,v]) => v) // רק תשובות קיימות
            .map(([k,v]) => ({ key: k.slice(-1), text: v }));
          // מי נכונה?
          const correctEntry = Object.entries(q.correct_answers || {})
            .find(([,flag]) => flag === 'true');
          let correctKey = correctEntry ? correctEntry[0].match(/answer_([a-z])_correct/i)?.[1] : null;
          // ערבוב ותרגום למפתחי a/b/c/d
          const options = all.slice(0,4).map((opt, i) => ({ key: ['a','b','c','d'][i], text: opt.text }));
          const correctText = all.find(o => o.key === correctKey)?.text || options[0]?.text || 'Blue';

          return {
            source: 'EXT',
            text: q.question || 'General knowledge',
            options,
            correct_token: signCorrectText(correctText), // יישלח חזרה בעת בדיקה
            correct_text: correctText                    // לא מציגים ב-UI; הקליינט ישלח חזרה לבדיקה
          };
        }
      }
    }
  } catch (_) { /* נמשיך לפלוא הבא */ }

  // 2) Open Trivia DB (ללא מפתח)
  try {
    const r = await fetch('https://opentdb.com/api.php?amount=1&type=multiple');
    if (r.ok) {
      const j = await r.json();
      const q = j?.results?.[0];
      if (q) {
        const decode = s => (s || '')
          .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&amp;/g,'&')
          .replace(/&lt;/g,'<').replace(/&gt;/g,'>');
        const correctText = decode(q.correct_answer);
        const optionsTexts = [correctText, ...(q.incorrect_answers || []).map(decode)];
        // ערבוב + חיתוך ל-4
        const shuffled = optionsTexts.sort(() => Math.random() - .5).slice(0,4);
        const options = shuffled.map((t,i) => ({ key: ['a','b','c','d'][i], text: t }));
        return {
          source: 'EXT',
          text: decode(q.question),
          options,
          correct_token: signCorrectText(correctText),
          correct_text: correctText
        };
      }
    }
  } catch (_) { /* נמשיך לפלוא הבא */ }

  return null; // לא הצלחנו להביא מבחוץ
}

//
// GET /kids/trivia/today?family_key=&child_id=&date=YYYY-MM-DD
//
exports.getTodayQuestion = async (req,res)=>{
  const family_key = Number(req.query.family_key);
  const child_id   = Number(req.query.child_id);
  const date       = req.query.date; // YYYY-MM-DD
  if(!family_key || !child_id || !date) {
    return res.status(400).json({message:'family_key, child_id, date are required'});
  }

  try {
    // אם כבר מישהו במשפחה פתר נכון – אין שאלה היום
    const solved = await pool.query(`
      SELECT 1 FROM TriviaDaily
      WHERE family_key=$1 AND trivia_date=$2::date AND correct=TRUE
      LIMIT 1
    `,[family_key,date]);
    if (solved.rowCount) return res.status(204).end();

    // אם הילד הזה כבר ניסה היום (נכון/לא נכון) – לא מאפשרים שוב
    const tried = await pool.query(`
      SELECT 1 FROM TriviaDaily
      WHERE family_key=$1 AND child_id=$2 AND trivia_date=$3::date
      LIMIT 1
    `,[family_key, child_id, date]);
    if (tried.rowCount) return res.status(204).end();

    // === נסיון 1: "איזו משימה לא הופיעה אתמול?" ===
    const y = await pool.query(`
      WITH win AS (
        SELECT ($1::date - INTERVAL '1 day')::timestamptz AS d0,
               ($1::date)::timestamptz                     AS d1
      )
      SELECT DISTINCT e.title
      FROM Events e
      CROSS JOIN win w
      WHERE e.family_key=$2
        AND e.start_at < w.d1
        AND COALESCE(e.end_at, e.start_at) >= w.d0
        AND EXISTS (
          SELECT 1 FROM EventTargets t
          WHERE t.event_id=e.event_id AND t.family_key=$2
            AND (t.target_type='family' OR t.target_type='all_kids' OR (t.target_type='child' AND t.child_id=$3))
        )
      LIMIT 12
    `,[date, family_key, child_id]);
    const yesterdayTitles = uniq(y.rows.map(r=>r.title));

    if (yesterdayTitles.length >= 2) {
      // נאתר "מסיח" שלא הופיע אתמול (30 ימים אחורה, לא אתמול)
      const n = await pool.query(`
        WITH rng AS (
          SELECT ($1::date - INTERVAL '30 days')::timestamptz AS d0,
                 ($1::date + INTERVAL '1 day')::timestamptz   AS d2,
                 ($1::date - INTERVAL '1 day')::timestamptz   AS y0,
                 ($1::date)::timestamptz                       AS y1
        )
        SELECT DISTINCT e.title
        FROM Events e, rng r
        WHERE e.family_key=$2
          AND e.start_at < r.d2
          AND COALESCE(e.end_at, e.start_at) >= r.d0
          AND NOT (e.start_at < r.y1 AND COALESCE(e.end_at, e.start_at) >= r.y0)
        LIMIT 50
      `,[date, family_key]);

      // מאגר מסיחים בסיסי אם אין כמעט דאטה
      const fallbackDistractors = ['Walk the dog','Water the plants','Read a book','Do homework','Tidy your room','Brush your teeth'];

      const poolWrong = uniq([...n.rows.map(r=>r.title), ...fallbackDistractors])
        .filter(tt => !yesterdayTitles.includes(tt));

      // בוחרים תשובה נכונה ("לא הופיעה אתמול") ועוד 3 שהופיעו אתמול
      const correctText = shuffle(poolWrong)[0] || 'Read a book';
      const wrongFromYesterday = shuffle(yesterdayTitles).slice(0,3);
      const optionsTexts = shuffle([correctText, ...wrongFromYesterday]).slice(0,4);

      const keys = ['a','b','c','d'];
      const options = optionsTexts.map((t,i)=>({ key: keys[i], text: t }));

      return res.json({
        question_id: `Y1-${family_key}-${date}`,  // מזהה מסוג "אתמול"
        text: 'Which of the following tasks did NOT appear in the tasks yesterday?',
        options
        // לא מחזירים תשובה נכונה ללקוח; נבדוק בצד שרת לפי הטקסט שנבחר
      });
    }

    // === נסיון 2 (fallback DB): "מי מהבאים שייך למשפחה?" ===
    const kids = await pool.query(`
      SELECT child_name FROM Children WHERE family_key=$1 LIMIT 50
    `,[family_key]);
    const kidNames = uniq(kids.rows.map(r=>r.child_name)).filter(Boolean);

    if (kidNames.length >= 1) {
      const correctText = shuffle(kidNames)[0];
      const poolWrong   = ['Alex','Maya','Tom','Chris','Liam','Emma','Noah','Olivia']
        .filter(n => !kidNames.includes(n));
      const wrongs = shuffle(poolWrong).slice(0,3);
      const optionsTexts = shuffle([correctText, ...wrongs]);

      const keys = ['a','b','c','d'];
      const options = optionsTexts.map((t,i)=>({ key: keys[i], text: t }));

      return res.json({
        question_id: `C1-${family_key}-${date}`,
        text: 'Which of these names belongs to your family?',
        options
      });
    }
    // === נסיון 3: API חיצוני ===
    const ext = await fetchExternalQuestion();
    if (ext) {
      return res.json({
        question_id: `EXT-${family_key}-${date}`, // מזהה "חיצוני"
        text: ext.text,
        options: ext.options,
        correct_token: ext.correct_token, // לא מציגים ב-UI; יוחזר ב-POST לבדיקה
        // לא נחזיר correct_text ללקוח בתשובה הסופית אם לא רוצים; אפשר להשמיטו כאן.
      });
    }

    // === נסיון 4 (fallback כללי מאוד) ===
    return res.json({
      question_id: `G1-${family_key}-${date}`,
      text: 'What color is the clear daytime sky?',
      options: [
        {key:'a', text:'Blue'}, {key:'b', text:'Green'}, {key:'c', text:'Red'}, {key:'d', text:'Yellow'}
      ]
    });

  } catch (err) {
    console.error('getTodayQuestion error:', err.stack || err);
    return res.status(500).json({ message:'Database error' });
  }
};

//
// POST /kids/trivia/answer { family_key, child_id, date, question_id, choice, choice_text? }
//
exports.submitAnswer = async (req,res)=>{
  const { family_key, child_id, date, question_id, choice, choice_text } = req.body || {};
  if(!family_key || !child_id || !date || !question_id || !choice){
    return res.status(400).json({message:'family_key, child_id, date, question_id, choice are required'});
  }
  const choiceText = (choice_text || '').trim();

  const client = await pool.connect();
  try{
    await client.query('BEGIN');

    // אם כבר נרשמה תשובה לילד – לעצור
    const tried = await client.query(`
      SELECT 1 FROM TriviaDaily
      WHERE family_key=$1 AND child_id=$2 AND trivia_date=$3::date
      LIMIT 1
    `,[family_key, child_id, date]);
    if (tried.rowCount){
      await client.query('ROLLBACK');
      return res.status(409).json({ message:'Already answered today' });
    }

    // אם כבר מישהו במשפחה פתר נכון – לעצור
    const solved = await client.query(`
      SELECT 1 FROM TriviaDaily
      WHERE family_key=$1 AND trivia_date=$2::date AND correct=TRUE
      LIMIT 1
    `,[family_key, date]);
    if (solved.rowCount){
      await client.query('ROLLBACK');
      return res.status(409).json({ message:'Already solved today' });
    }

    // הכרעת תשובה לפי סוג השאלה
    const kind = String(question_id).split('-')[0]; // Y1 / C1 / G1
    let correct = false;

    if (kind === 'Y1') {
      // אנו מצפים לקבל מהקליינט גם correct_token שחזר בשאלה
      const tokenFromClient = (req.body.correct_token || '').trim();
      if (!tokenFromClient) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: 'correct_token is required for external questions' });
      }
      // בדיקה קריפטוגרפית: מחשבים hash(choiceText+secret) ומשווים לטוקן שהוחזר עם השאלה
      const expect = signCorrectText(choiceText);
      correct = (expect === tokenFromClient);
     
    }
    else if (kind === 'C1') {
      const k = await client.query(`SELECT child_name FROM Children WHERE family_key=$1`,[family_key]);
      const names = new Set(k.rows.map(r=>r.child_name));
      correct = names.has(choiceText);
    }
      else if (kind === 'EXT') {
       const y = await client.query(`
        WITH win AS (
          SELECT ($1::date - INTERVAL '1 day')::timestamptz AS d0,
                 ($1::date)::timestamptz                     AS d1
        )
        SELECT DISTINCT e.title
        FROM Events e CROSS JOIN win w
        WHERE e.family_key=$2
          AND e.start_at < w.d1
          AND COALESCE(e.end_at, e.start_at) >= w.d0
          AND EXISTS (
            SELECT 1 FROM EventTargets t
            WHERE t.event_id=e.event_id AND t.family_key=$2
              AND (t.target_type='family' OR t.target_type='all_kids' OR (t.target_type='child' AND t.child_id=$3))
          )
      `,[date, family_key, child_id]);
      const yesterday = new Set(y.rows.map(r=>r.title));
      // תשובה נכונה אם הטקסט שנבחר *לא* הופיע אתמול
      correct = choiceText && !yesterday.has(choiceText);
    }

    else { // G1
      correct = (choiceText.toLowerCase() === 'blue');
    }

    const points = correct ? 5 : 0;

    await client.query(`
      INSERT INTO TriviaDaily (family_key, child_id, trivia_date, correct, points_awarded)
      VALUES ($1,$2,$3::date,$4,$5)
    `,[family_key, child_id, date, correct, points]);

    if (correct) {
      await client.query(`
        INSERT INTO PointsLedger (family_key, child_id, points, source, trivia_date)
        VALUES ($1,$2,$3,'trivia',$4::date)
      `,[family_key, child_id, points, date]);
    }

    await client.query('COMMIT');
    return res.json({ correct, points_awarded: points });
  }catch(err){
    await client.query('ROLLBACK');
    console.error('submitAnswer error:', err.stack || err);
    return res.status(500).json({ message:'Database error' });
  }finally{
    client.release();
  }
};
