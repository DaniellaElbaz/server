// controllers/kidsTriviaController.js
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// סוד לחתימה (מומלץ להגדיר ב-ENV)
const TRIVIA_SECRET = process.env.TRIVIA_SECRET || 'dev-secret';

// -------- helpers --------
function hmac(obj) {
  const s = JSON.stringify(obj);
  return crypto.createHmac('sha256', TRIVIA_SECRET).update(s).digest('hex');
}
function pickN(arr, n, exceptIdx = -1) {
  const a = arr.map((v,i)=>({v,i})).filter(x=>x.i!==exceptIdx);
  for (let i=a.length-1;i>0;i--) { const j = Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a.slice(0, n).map(x=>x.v);
}
function shuffle(a){
  for (let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
const fmtDM = (iso) => new Date(iso).toLocaleDateString(undefined, {day:'2-digit', month:'2-digit'});

// מחזיר true אם כבר נפטרה היום ע"י מישהו במשפחה
async function familySolvedToday(family_key, dateISO) {
  const q = `SELECT 1
               FROM TriviaDaily
              WHERE family_key=$1 AND trivia_date=$2::date AND correct = true
              LIMIT 1`;
  const r = await pool.query(q, [family_key, dateISO]);
  return r.rowCount > 0;
}

// מחזיר כל בני המשפחה (ילדים+הורים) עם תאריכי לידה
async function listFamilyMembers(family_key) {
  const q = `
    SELECT 'child' AS type, child_id AS id, child_name AS name, birth_date
      FROM Children WHERE family_key=$1
    UNION ALL
    SELECT 'parent' AS type, parent_id AS id, parent_name AS name, birth_date
      FROM Parents  WHERE family_key=$1
  `;
  const { rows } = await pool.query(q, [family_key]);
  return rows;
}

// ---- גנרטורים מבוססי DB ----

// 1) למי יש היום יום הולדת
async function genBirthdayToday(family_key, dateISO){
  const members = await listFamilyMembers(family_key);
  const todayMD = (d) => `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const today = new Date(dateISO);
  const md = todayMD(today);

  const todayOnes = members.filter(m => m.birth_date && todayMD(new Date(m.birth_date)) === md);
  if (!todayOnes.length) return null;

  const answer = todayOnes[0]; // אם יש כמה – נבחר ראשון
  const poolNames = members.filter(m => m.name && m.id !== answer.id).map(m => m.name);
  const distractors = pickN(poolNames, 3);
  const choices = shuffle([answer.name, ...distractors]);
  const correct_index = choices.indexOf(answer.name);

  const seed = Math.random().toString(36).slice(2);
  return {
    id: `fam:${family_key}:${dateISO}:bday-today:${answer.type}:${answer.id}`,
    source: 'birthday_today',
    text: 'Whose birthday is today?',
    choices,
    correct_index,
    meta: { kind: 'birthday_today' , date: dateISO },
    token: hmac({ family_key:Number(family_key), date:dateISO, correct_index, seed }),
    seed
  };
}

// 2) למי יש יום הולדת בתאריך הקרוב הבא (DD/MM)
async function genNextBirthday(family_key, dateISO){
  const q = `
  WITH m AS (
    SELECT 'child' AS type, child_id AS id, child_name AS name, birth_date
      FROM Children WHERE family_key=$1 AND birth_date IS NOT NULL
    UNION ALL
    SELECT 'parent' AS type, parent_id AS id, parent_name AS name, birth_date
      FROM Parents  WHERE family_key=$1 AND birth_date IS NOT NULL
  ), ref AS (
    SELECT $2::date AS today
  ), norm AS (
    SELECT m.*, 
           make_date(EXTRACT(YEAR FROM ref.today)::int, EXTRACT(MONTH FROM m.birth_date)::int, EXTRACT(DAY FROM m.birth_date)::int) AS this_year,
           CASE 
             WHEN make_date(EXTRACT(YEAR FROM ref.today)::int, EXTRACT(MONTH FROM m.birth_date)::int, EXTRACT(DAY FROM m.birth_date)::int) < ref.today
                  THEN make_date(EXTRACT(YEAR FROM ref.today)::int + 1, EXTRACT(MONTH FROM m.birth_date)::int, EXTRACT(DAY FROM m.birth_date)::int)
             ELSE make_date(EXTRACT(YEAR FROM ref.today)::int,     EXTRACT(MONTH FROM m.birth_date)::int, EXTRACT(DAY FROM m.birth_date)::int)
           END AS next_bday
      FROM m, ref
  )
  SELECT * FROM norm
  ORDER BY next_bday ASC
  LIMIT 1;
  `;
  const { rows } = await pool.query(q, [family_key, dateISO]);
  if (!rows.length) return null;

  const target = rows[0];
  const allNames = (await listFamilyMembers(family_key))
    .filter(x=>x.id !== target.id && x.name)
    .map(x=>x.name);

  const distractors = pickN(allNames, 3);
  const choices = shuffle([target.name, ...distractors]);
  const correct_index = choices.indexOf(target.name);

  const seed = Math.random().toString(36).slice(2);
  return {
    id: `fam:${family_key}:${dateISO}:bday-next:${target.type}:${target.id}`,
    source: 'birthday_next',
    text: `Who has the next birthday on ${fmtDM(target.next_bday)}?`,
    choices,
    correct_index,
    meta: { kind:'birthday_next', date: target.next_bday },
    token: hmac({ family_key:Number(family_key), date:dateISO, correct_index, seed }),
    seed
  };
}

// 3) מי השלים אתמול משימה (מאושרת)
async function genTaskYesterday(family_key, dateISO){
  const q = `
    SELECT s.event_id, s.child_id, ch.child_name AS name, e.title
      FROM ChildTaskEvents s
      JOIN Children ch ON ch.child_id = s.child_id
      JOIN Events   e  ON e.event_id  = s.event_id
     WHERE s.family_key=$1
       AND s.task_date = ($2::date - INTERVAL '1 day')::date
       AND s.status = 2
     ORDER BY s.confirmed_at DESC NULLS LAST
     LIMIT 1;
  `;
  const { rows } = await pool.query(q, [family_key, dateISO]);
  if (!rows.length) return null;

  const hit = rows[0];
  // מסיחים: ילדים אחרים במשפחה
  const kidsQ = `SELECT child_name AS name FROM Children WHERE family_key=$1 AND child_id <> $2 AND child_name IS NOT NULL`;
  const others = (await pool.query(kidsQ, [family_key, hit.child_id])).rows.map(r=>r.name);

  const choices = shuffle([hit.name, ...pickN(others, 3)]);
  const correct_index = choices.indexOf(hit.name);

  const seed = Math.random().toString(36).slice(2);
  return {
    id: `fam:${family_key}:${dateISO}:task-yesterday:${hit.event_id}`,
    source: 'task_yesterday',
    text: `Who completed the task “${hit.title}” yesterday?`,
    choices,
    correct_index,
    meta: { kind:'task_yesterday', event_id: hit.event_id },
    token: hmac({ family_key:Number(family_key), date:dateISO, correct_index, seed }),
    seed
  };
}

// ---- נפילות (Fallbacks) ----

// 4) חיצוני: QuizAPI.io (דורש API Key ב-ENV: QUIZAPI_KEY)
async function genExternal() {
  const KEY = process.env.QUIZAPI_KEY;
  if (!KEY) return null;
  try {
    const u = new URL('https://quizapi.io/api/v1/questions');
    u.searchParams.set('apiKey', KEY);
    u.searchParams.set('limit', '1');
    u.searchParams.set('difficulty', 'Easy');
    u.searchParams.set('tags', 'general,geography,science');

    const f = await fetch(u.toString());
    if (!f.ok) return null;
    const arr = await f.json();
    if (!Array.isArray(arr) || !arr.length) return null;

    const q = arr[0];
    const choices = Object.values(q.answers || {}).filter(Boolean);
    const correctKey = Object.entries(q.correct_answers || {}).find(([k,v]) => v === 'true')?.[0] || '';
    const correctIdx = correctKey ? choices.findIndex((c,i)=>('answer_'+String.fromCharCode(97+i)+'_correct')===correctKey) : 0;

    const seed = Math.random().toString(36).slice(2);
    return {
      id: `external:quizapi:${q.id || ''}`,
      source: 'external_quizapi',
      text: q.question || 'Question',
      choices,
      correct_index: Math.max(0, correctIdx),
      meta: { kind:'external' },
      token: hmac({ family_key:0, date:'', correct_index:Math.max(0, correctIdx), seed }),
      seed
    };
  } catch { return null; }
}

// 5) פנימי: מאגר סטטי “לכל גיל”
function genStatic(){
  const pool = [
    { q:'Which season comes after Spring?', a:['Summer','Autumn','Winter','Spring'], idx:0 },
    { q:'How many days are in a week?', a:['5','6','7','8'], idx:2 },
    { q:'What color do you get when you mix blue and yellow?', a:['Green','Purple','Orange','Brown'], idx:0 },
    { q:'Which animal says “Moo”?', a:['Cat','Cow','Dog','Lion'], idx:1 },
  ];
  const item = pool[Math.floor(Math.random()*pool.length)];
  const seed = Math.random().toString(36).slice(2);
  return {
    id: `static:${seed}`,
    source: 'static',
    text: item.q,
    choices: item.a,
    correct_index: item.idx,
    meta: { kind:'static' },
    token: hmac({ family_key:0, date:'', correct_index:item.idx, seed }),
    seed
  };
}

// --------- PUBLIC: GET /kids/trivia/today ----------
exports.getTodayQuestion = async (req, res) => {
  const family_key = Number(req.query.family_key);
  const child_id   = Number(req.query.child_id);
  const date       = req.query.date; // YYYY-MM-DD

  if (!family_key || !child_id || !date) {
    return res.status(400).json({ message:'family_key, child_id, date are required' });
  }

  try {
    // נועל אם המשפחה כבר פתרה היום
    if (await familySolvedToday(family_key, date)) {
      return res.status(423).json({ message:'already_solved_by_family' });
    }

    let q = await genBirthdayToday(family_key, date);
    if (!q) q = await genNextBirthday(family_key, date);
    if (!q) q = await genTaskYesterday(family_key, date);
    if (!q) q = await genExternal();
    if (!q) q = genStatic();

    return res.json(q);
  } catch (e) {
    console.error('getTodayQuestion error:', e);
    return res.status(500).json({ message:'Database error' });
  }
};

// --------- PUBLIC: POST /kids/trivia/answer ----------
/**
 * body: { family_key, child_id, date, choice, token }
 * לא צריך question_id מצד השרת כי ה-token מקודד את המדד הנכון.
 */
exports.submitAnswer = async (req, res) => {
  const { family_key, child_id, date, choice, token } = req.body || {};
  if (!family_key || !child_id || !date || typeof choice !== 'number' || !token) {
    return res.status(400).json({ message:'family_key, child_id, date, choice, token are required' });
  }
  try {
    // אם כבר נפתר – חוסמים
    if (await familySolvedToday(family_key, date)) {
      return res.status(423).json({ message:'already_solved_by_family' });
    }

    // מגלים את correct_index מתוך החתימה:
    // ננסה לשחזר לפי כל seed סביר? אין לנו seed פה.
    // לכן נדרוש מהלקוח לשלוח גם 'seed' (נוסף קטן—בטוח כי החתימה מגנה על correct_index+seed).
    const seed = req.body.seed || '';
    // נבדוק את ארבעת המדדים האפשריים (0..3) — פשוט ויעיל:
    let correct_index = null;
    for (let ci=0; ci<4; ci++){
      const sig = hmac({ family_key:Number(family_key), date, correct_index:ci, seed });
      if (sig === token) { correct_index = ci; break; }
    }
    if (correct_index === null) {
      return res.status(400).json({ message:'bad token' });
    }

    const isCorrect = Number(choice) === Number(correct_index);

    // רושמים תוצאה רק אם נכונה כדי לנעול את היום (כדרישתך: “אחרי שמישהו ענה נכון — נגמר לכולם”)
    if (isCorrect) {
      await pool.query(
        `INSERT INTO TriviaDaily (family_key, child_id, trivia_date, correct, points_awarded)
         VALUES ($1,$2,$3::date,true,5)
         ON CONFLICT (child_id, trivia_date)
         DO UPDATE SET correct=true, points_awarded=5`,
        [family_key, child_id, date]
      );
    }

    return res.json({ correct: isCorrect });
  } catch (e) {
    console.error('submitAnswer error:', e);
    return res.status(500).json({ message:'Database error' });
  }
};
