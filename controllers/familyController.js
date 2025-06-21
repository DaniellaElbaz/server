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

module.exports = { registerFamily };

