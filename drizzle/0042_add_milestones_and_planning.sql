-- Milestones: the second (and last) planning fact recorded by hand.
-- board_id is nullable so a goal can span several projects; deleting a
-- board takes its milestones with it, but deleting a milestone must never
-- take cards with it (the delete handler nulls cards.milestone_id instead).
CREATE TABLE IF NOT EXISTS milestones (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	target_date TEXT,
	status TEXT NOT NULL DEFAULT 'open',
	created_by INTEGER REFERENCES users(id),
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-->statement-breakpoint
-- One milestone per card: a card belongs to at most one goal.
-- SQLite cannot add a column with a REFERENCES clause carrying ON DELETE to
-- an existing table, so the null-out is done by the delete handler instead.
ALTER TABLE cards ADD COLUMN milestone_id INTEGER;
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cards_milestone ON cards(milestone_id);
-->statement-breakpoint
-- Who recorded the dependency. Present from here on so the milestone view can
-- show provenance; existing rows keep NULL.
ALTER TABLE card_dependencies ADD COLUMN created_by_user_id INTEGER REFERENCES users(id);
-->statement-breakpoint
-- The only statement in this migration that removes anything.
--
-- Before this migration the duplicate check was in the request handler, not the
-- database, so identical (card_id, depends_on_card_id) pairs were possible and
-- CREATE UNIQUE INDEX below would fail on them. This keeps MIN(id) of each pair
-- and removes only the redundant copies, so **every distinct dependency
-- survives** — grouping is on exactly the columns the index covers, which makes
-- "lost a dependency" unrepresentable: a pair can only be deleted when another
-- row with the same pair is kept.
--
-- On any database where the app wrote dependencies through the API this deletes
-- nothing, because the handler already rejected duplicates.
DELETE FROM card_dependencies WHERE id NOT IN (
	SELECT MIN(id) FROM card_dependencies GROUP BY card_id, depends_on_card_id
);
-->statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_card_dep_pair
	ON card_dependencies(card_id, depends_on_card_id);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_card_dep_blocker
	ON card_dependencies(depends_on_card_id);
