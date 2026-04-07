CREATE TABLE IF NOT EXISTS card_dependencies (
	blocker_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
	blocked_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	PRIMARY KEY (blocker_card_id, blocked_card_id)
);
