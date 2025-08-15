const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const registerFamily = async (req, res) => {
  const { family_name, password } = req.body;

  console.log("Received request:", family_name, password);

  try {
    const checkQuery = `SELECT * FROM Families WHERE family_name = $1 AND password = $2`;
    const checkResult = await pool.query(checkQuery, [family_name, password]);

    if (checkResult.rows.length > 0) {
      return res.status(400).json({ message: 'This family name and password combination already exists. Please choose a different password.' });
    }

    const insertQuery = `INSERT INTO Families (family_name, password) VALUES ($1, $2) RETURNING family_key`;
    const insertResult = await pool.query(insertQuery, [family_name, password]);

    res.json({
      message: 'Family registered successfully!',
      family_key: insertResult.rows[0].family_key
    });

  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ message: 'Database error' });
  }
};
const registerParentsChildren = async (req, res) => {
  const {
    family_key,
    parent_name,
    parent_password,
    parent_birthdate,
    child_name,
    child_birthdate
  } = req.body;

  try {
    const insertParentQuery = `
      INSERT INTO Parents (family_key, parent_name, password, birth_date)
      VALUES ($1, $2, $3, $4) RETURNING parent_id
    `;
    const parentResult = await pool.query(insertParentQuery, [
      family_key,
      parent_name,
      parent_password,
      parent_birthdate
    ]);

    const insertChildQuery = `
      INSERT INTO Children (family_key, child_name, birth_date)
      VALUES ($1, $2, $3) RETURNING child_id
    `;
    const childResult = await pool.query(insertChildQuery, [
      family_key,
      child_name,
      child_birthdate
    ]);

    res.json({
      message: 'Parent and Child registered successfully!',
      parent_id: parentResult.rows[0].parent_id,
      child_id: childResult.rows[0].child_id
    });

  } catch (err) {
    console.error("Database error:", err);
    res.status(500).json({ message: 'Database error' });
  }
};
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

module.exports = {
  registerFamily,
  registerParentsChildren,
  login,
};
