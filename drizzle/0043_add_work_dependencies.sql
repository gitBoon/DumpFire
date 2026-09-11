-- Dependencies between any two pieces of work, not just between cards.
--
-- One polymorphic table rather than three (card→card, subtask→subtask, and the
-- two mixed directions) so the planning engine walks ONE graph regardless of
-- node type. Three tables would mean three near-identical traversals that can
-- drift apart, and the whole point of this feature is that the derived answers
-- cannot disagree with each other. The cost is losing per-column foreign keys
-- on the polymorphic ids; orphan cleanup is handled in code instead, where the
-- type discriminator can be read.
--
-- `*_type` is 'card' or 'subtask'. Direction matches card_dependencies: the
-- BLOCKED end waits on the BLOCKER end.
CREATE TABLE IF NOT EXISTS work_dependencies (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	blocked_type TEXT NOT NULL DEFAULT 'card',
	blocked_id INTEGER NOT NULL,
	blocker_type TEXT NOT NULL DEFAULT 'card',
	blocker_id INTEGER NOT NULL,
	created_by_user_id INTEGER REFERENCES users(id),
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-->statement-breakpoint
-- The pair, in full. Enforces one row per ordering decision per direction.
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_dep_pair
	ON work_dependencies(blocked_type, blocked_id, blocker_type, blocker_id);
-->statement-breakpoint
-- Both directions are walked constantly (what blocks me / what do I block).
CREATE INDEX IF NOT EXISTS idx_work_dep_blocked
	ON work_dependencies(blocked_type, blocked_id);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_work_dep_blocker
	ON work_dependencies(blocker_type, blocker_id);
-->statement-breakpoint
-- Carry every existing card dependency across as a (card, card) pair.
--
-- INSERT OR IGNORE against the unique index above makes this safe to re-run,
-- and the old table is deliberately LEFT IN PLACE rather than dropped: this
-- migration is the one that could lose the ordering decisions already recorded,
-- and a table nothing reads costs nothing. A later migration can drop it once
-- work_dependencies has been in production long enough to trust. (Migration
-- 0036 is the cautionary tale here — see the comment in that file.)
INSERT OR IGNORE INTO work_dependencies
	(blocked_type, blocked_id, blocker_type, blocker_id, created_by_user_id, created_at)
SELECT 'card', card_id, 'card', depends_on_card_id, created_by_user_id, created_at
FROM card_dependencies;
