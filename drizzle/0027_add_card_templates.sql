CREATE TABLE IF NOT EXISTS card_templates (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	title TEXT NOT NULL DEFAULT '',
	description TEXT DEFAULT '',
	priority TEXT NOT NULL DEFAULT 'medium',
	subtasks_json TEXT DEFAULT '[]',
	labels_json TEXT DEFAULT '[]',
	created_by INTEGER REFERENCES users(id),
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
