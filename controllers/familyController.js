const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const registerFamily = async (req, res) => {
  const { family_name, password } = req.body;

  try {
    const result = await pool.query(
      'INSERT INTO Families (family_name, password) VALUES ($1, $2) RETURNING family_key',
      [family_name, password]
    );

    res.json({
      message: 'Family registered successfully!',
      family_key: result.rows[0].family_key
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Database error' });
  }
};

module.exports = { registerFamily };
