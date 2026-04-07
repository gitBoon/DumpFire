CREATE TABLE IF NOT EXISTS card_attachments (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
	filename TEXT NOT NULL,
	original_name TEXT NOT NULL,
	mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
	size_bytes INTEGER NOT NULL DEFAULT 0,
	uploaded_by INTEGER REFERENCES users(id),
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
