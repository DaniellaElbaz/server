const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/**
 * FAMILY REGISTER — מתקנת את הבדיקה: מונע כפילות לפי family_name בלבד
 * (מומלץ גם אילוץ UNIQUE ב-DB על Families(family_name) בהזדמנות).
 */
const registerFamily = async (req, res) => {
  const { family_name, password } = req.body;

  if (!family_name || !password) {
    return res.status(400).json({ message: 'family_name and password are required' });
  }

  try {
    const checkQuery = `SELECT 1 FROM Families WHERE family_name = $1`;
    const checkResult = await pool.query(checkQuery, [family_name]);

    if (checkResult.rows.length > 0) {
      return res.status(409).json({ message: 'Family name already exists. Please choose a different name.' });
    }

    const insertQuery = `INSERT INTO Families (family_name, password) VALUES ($1, $2) RETURNING family_key`;
    const insertResult = await pool.query(insertQuery, [family_name, password]);

    res.json({
      message: 'Family registered successfully!',
      family_key: insertResult.rows[0].family_key
    });

  } catch (err) {
    console.error("Database error (registerFamily):", err);
    res.status(500).json({ message: 'Database error' });
  }
};

/**
 * BACKWARD-COMPAT — הורה אחד + ילד אחד, עם Transaction ויצירת קישור (אם קיימת טבלת קישורים).
 * תומך גם בשדות החדשים אם יישלחו, אבל לא מחייב אותם.
 */
const registerParentsChildren = async (req, res) => {
  const {
    family_key,

    parent_name,
    parent_password,        // לשמירת תאימות: אם לא יגיע pin נשתמש בזה
    parent_birthdate,
    parent_nickname,        // חדש – לא חובה
    parent_pin_code,        // חדש – לא חובה

    child_name,
    child_birthdate,
    child_nickname,         // חדש – לא חובה
    child_pin_code          // חדש – לא חובה
  } = req.body;

  if (!family_key || !parent_name || !child_name) {
    return res.status(400).json({ message: 'family_key, parent_name and child_name are required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const parentResult = await client.query(
      `INSERT INTO Parents (family_key, parent_name, password, nickname, birth_date, pin_code)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING parent_id`,
      [
        family_key,
        parent_name,
        parent_password ?? parent_pin_code ?? '0000',  // Parents.password היה NOT NULL בסכמה המקורית
        parent_nickname ?? null,
        parent_birthdate ?? null,
        parent_pin_code ?? null
      ]
    );

    const childResult = await client.query(
      `INSERT INTO Children (family_key, child_name, nickname, birth_date, pin_code)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING child_id`,
      [
        family_key,
        child_name,
        child_nickname ?? null,
        child_birthdate ?? null,
        child_pin_code ?? null
      ]
    );

    // יצירת קישור הורה↔ילד (אם קיימת טבלת ParentChildLinks)
    try {
      await client.query(
        `INSERT INTO ParentChildLinks (parent_id, child_id, family_key)
         VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [parentResult.rows[0].parent_id, childResult.rows[0].child_id, family_key]
      );
    } catch (e) {
      // אם הטבלה/האילוץ עדיין לא קיימים – לא נפיל את כל הבקשה.
      console.warn('Link insert skipped (ParentChildLinks missing?):', e.message);
    }

    await client.query('COMMIT');

    res.json({
      message: 'Parent and Child registered successfully!',
      parent_id: parentResult.rows[0].parent_id,
      child_id: childResult.rows[0].child_id
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Database error (registerParentsChildren):", err);
    res.status(500).json({ message: 'Database error' });
  } finally {
    client.release();
  }
};


const registerMembers = async (req, res) => {
  const { family_key, parents = [], children = [], links } = req.body;

  if (!family_key) {
    return res.status(400).json({ message: 'family_key is required' });
  }
  if (!Array.isArray(parents) || !Array.isArray(children)) {
    return res.status(400).json({ message: 'parents and children must be arrays' });
  }

  const client = await pool.connect();
  try {
    // וידוא משפחה קיימת
    const fam = await client.query('SELECT 1 FROM Families WHERE family_key = $1', [family_key]);
    if (fam.rowCount === 0) {
      client.release();
      return res.status(404).json({ message: 'Family not found' });
    }

    await client.query('BEGIN');

    // הורים
    const insertedParents = [];
    for (const p of parents) {
      const { name, nickname = null, birth_date = null, pin_code = null, password = null } = p || {};
      if (!name) continue;

      const pr = await client.query(
        `INSERT INTO Parents (family_key, parent_name, password, nickname, birth_date, pin_code)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING parent_id, family_key`,
        [family_key, name, password ?? pin_code ?? '0000', nickname, birth_date, pin_code]
      );
      insertedParents.push(pr.rows[0]);
    }

    // ילדים
    const insertedChildren = [];
    for (const c of children) {
      const { name, nickname = null, birth_date = null, pin_code = null } = c || {};
      if (!name) continue;

      const cr = await client.query(
        `INSERT INTO Children (family_key, child_name, nickname, birth_date, pin_code)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING child_id, family_key`,
        [family_key, name, nickname, birth_date, pin_code]
      );
      insertedChildren.push(cr.rows[0]);
    }

    // קישורים
    const pairs = [];
    if (Array.isArray(links) && links.length > 0) {
      for (const l of links) {
        const p = insertedParents[l.parent_index];
        const c = insertedChildren[l.child_index];
        if (p && c) pairs.push({ parent_id: p.parent_id, child_id: c.child_id, relationship: l.relationship ?? null });
      }
    } else {
      // ברירה: כל הורה ↔ כל ילד
      for (const p of insertedParents) {
        for (const c of insertedChildren) {
          pairs.push({ parent_id: p.parent_id, child_id: c.child_id, relationship: null });
        }
      }
    }

    if (pairs.length) {
      const values = [];
      const params = [];
      let i = 1;
      for (const pr of pairs) {
        values.push(`($${i++}, $${i++}, $${i++}, $${i++})`);
        params.push(pr.parent_id, pr.child_id, family_key, pr.relationship);
      }

      try {
        await client.query(
          `INSERT INTO ParentChildLinks (parent_id, child_id, family_key, relationship)
           VALUES ${values.join(',')}
           ON CONFLICT DO NOTHING`,
          params
        );
      } catch (e) {
        console.warn('Links batch insert skipped (ParentChildLinks missing?):', e.message);
      }
    }

    await client.query('COMMIT');

    return res.json({
      message: 'Members created',
      parents: insertedParents,
      children: insertedChildren,
      links_created: pairs.length
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('registerMembers error:', err);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
};

/** LOGIN — נשאר כמו שהוא */
const login = async (req, res) => {
  const { family_name, password } = req.body;
  if (!family_name || !password) {
    return res.status(400).json({ message: 'family_name and password are required' });
  }
  try {
    const q = `SELECT family_key FROM Families WHERE family_name = $1 AND password = $2`;
    const r = await pool.query(q, [family_name, password]);

    if (r.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    return res.json({
      message: 'Login successful',
      family_key: r.rows[0].family_key
    });
  } catch (err) {
    console.error('Database error (login):', err);
    return res.status(500).json({ message: 'Database error' });
  }
};
// מחזיר את כל הילדים למשפחה
const listChildren = async (req, res) => {
  const family_key = Number(req.query.family_key);
  if (!family_key) return res.status(400).json({ message: 'family_key is required' });

  try {
    const r = await pool.query(
      `SELECT child_id AS id, child_name AS name, nickname, birth_date
         FROM Children
        WHERE family_key = $1
        ORDER BY child_name ASC`,
      [family_key]
    );
    res.json({ items: r.rows });
  } catch (err) {
    console.error('listChildren error:', err);
    res.status(500).json({ message: 'Database error' });
  }
};

// מחזיר את כל ההורים למשפחה
const listParents = async (req, res) => {
  const family_key = Number(req.query.family_key);
  if (!family_key) return res.status(400).json({ message: 'family_key is required' });

  try {
    const r = await pool.query(
      `SELECT parent_id AS id, parent_name AS name, nickname, birth_date
         FROM Parents
        WHERE family_key = $1
        ORDER BY parent_name ASC`,
      [family_key]
    );
    res.json({ items: r.rows });
  } catch (err) {
    console.error('listParents error:', err);
    res.status(500).json({ message: 'Database error' });
  }
};

module.exports = {
  registerFamily,
  registerParentsChildren, // נשאר לשמירה לאחור
  registerMembers,         
  login,
  listChildren,      
  listParents 
};
