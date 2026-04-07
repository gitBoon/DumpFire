CREATE TABLE IF NOT EXISTS board_favourites (
	user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (user_id, board_id)
);
