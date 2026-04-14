const db = require('better-sqlite3')('./dumpfire.db');
try {
  db.exec("ALTER TABLE report_schedules ADD COLUMN detail_level TEXT NOT NULL DEFAULT 'detailed'");
  console.log('Column added successfully');
} catch (e) {
  if (e.message.includes('duplicate column')) {
    console.log('Column already exists');
  } else {
    throw e;
  }
}
const cols = db.pragma('table_info(report_schedules)');
console.log('Columns:', cols.map(c => c.name).join(', '));
