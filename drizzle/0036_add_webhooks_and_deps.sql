-- Add next_recurrence to cards
ALTER TABLE cards ADD COLUMN next_recurrence TEXT;
-->statement-breakpoint
-- Create webhooks table
CREATE TABLE IF NOT EXISTS webhooks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	secret TEXT NOT NULL DEFAULT '',
	events TEXT NOT NULL DEFAULT '[]',
	active INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-->statement-breakpoint
-- Recreate card_dependencies with proper schema (id, card_id, depends_on_card_id)
CREATE TABLE IF NOT EXISTS card_dependencies_v2 (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
	depends_on_card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-->statement-breakpoint
-- Migrate any existing data from old card_dependencies table
INSERT OR IGNORE INTO card_dependencies_v2 (card_id, depends_on_card_id, created_at)
	SELECT blocked_card_id, blocker_card_id, created_at FROM card_dependencies;
-->statement-breakpoint
DROP TABLE IF EXISTS card_dependencies;
-->statement-breakpoint
ALTER TABLE card_dependencies_v2 RENAME TO card_dependencies;
