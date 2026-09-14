-- Token cost ledger.
--
-- Story points guess at effort before the work; tokens measure it afterwards,
-- and unlike points they are an observed quantity rather than an opinion.
--
-- This is a ledger, not a counter, for three reasons: the total has to climb as
-- work proceeds and a ledger makes that accrual visible rather than just a
-- number that changed; a mistaken entry can be reversed with a negative one
-- instead of being permanent; and the per-model breakdown falls out for free.
--
-- Entirely additive. No existing table is altered and no existing row is read
-- or written, so an upgrade cannot disturb a populated board. Cards and
-- subtasks that predate this simply have no rows here, which reads as "not
-- recorded" — deliberately distinct from a recorded zero, because we cannot
-- know what historical work cost and must never imply that we do.
CREATE TABLE IF NOT EXISTS token_usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,

	-- Exactly one of these is set. An entry belongs either to a card directly
	-- (work not broken out into a subtask) or to one specific subtask. A card's
	-- reported total is its own entries plus those of all its subtasks.
	card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
	subtask_id INTEGER REFERENCES subtasks(id) ON DELETE CASCADE,

	-- Signed on purpose: a correction is a negative entry, which keeps the
	-- original report in the history instead of quietly rewriting it.
	tokens INTEGER NOT NULL,

	-- Which model spent them. Nullable because a caller may genuinely not know,
	-- but worth capturing: 80k Opus tokens and 80k Haiku tokens are the same
	-- number and very different money, so a total without a model cannot be
	-- turned into cost or compared fairly between cards.
	model TEXT,

	-- What this entry covers ("applied the fix across 9 sites"). Free text.
	note TEXT,

	reported_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),

	-- Exactly one owner, never both and never neither.
	CHECK ((card_id IS NULL) <> (subtask_id IS NULL))
);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_token_usage_card ON token_usage(card_id);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_token_usage_subtask ON token_usage(subtask_id);
