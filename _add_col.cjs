const Database = require('better-sqlite3');
const db = new Database('dumpfire.db');
try {
  db.exec(`ALTER TABLE cards ADD COLUMN next_recurrence TEXT`);
  console.log('next_recurrence column added');
} catch (e) {
  console.log('Column may already exist:', e.message);
}
