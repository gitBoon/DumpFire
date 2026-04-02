CREATE TABLE IF NOT EXISTS task_requests (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	target_type TEXT NOT NULL DEFAULT 'team',
	target_id INTEGER NOT NULL,
	requester_name TEXT NOT NULL DEFAULT 'Anonymous',
	requester_email TEXT,
	requester_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
	title TEXT NOT NULL,
	description TEXT DEFAULT '',
	priority TEXT NOT NULL DEFAULT 'medium',
	status TEXT NOT NULL DEFAULT 'pending',
	resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
	resolved_card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
	reject_reason TEXT,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	resolved_at TEXT
);
