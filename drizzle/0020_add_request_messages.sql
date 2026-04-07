CREATE TABLE IF NOT EXISTS request_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	request_id INTEGER NOT NULL REFERENCES task_requests(id) ON DELETE CASCADE,
	sender_type TEXT NOT NULL DEFAULT 'admin',
	sender_name TEXT NOT NULL,
	message TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
