CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  user_name TEXT DEFAULT '',
  user_emoji TEXT DEFAULT '👤',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
