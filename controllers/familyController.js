const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../FamilyTasks.db');
const db = new sqlite3.Database(dbPath);

const registerFamily = (req, res) => {
    const { family_name, password } = req.body;

    const query = `INSERT INTO Families (family_name, password) VALUES (?, ?)`;

    db.run(query, [family_name, password], function(err) {
        if (err) {
            console.error(err.message);
            res.status(500).json({ message: 'Database error' });
        } else {
            res.json({
                message: 'Family registered successfully!',
                family_key: this.lastID
            });
        }
    });
};

module.exports = {
    registerFamily
};
