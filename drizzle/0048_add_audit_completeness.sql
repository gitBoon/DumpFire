-- Make the activity log a complete record of board activity.
--
-- Three gaps, all found while building a 30-day management activity report
-- from the API and cross-checking it against the cards themselves:
--
-- 1. Only API-originated actions were ever written. Everything done in the web
--    UI — including moving a card to Complete — left no trace at all. 42 of 145
--    completions in one 30-day window had no event, so anything trusting the
--    log under-counted delivered work by roughly 30%.
-- 2. There was no card-creation event and no record of who created a card, so
--    "raised but not yet touched" work could neither be found nor attributed.
-- 3. A truncated audit page gave no signal that it was truncated.
--
-- `source` marks where an action came from. It is nullable on purpose: existing
-- rows are not backfilled, because the prefix on their action name already
-- says which they were ('api:' means api, anything else means ui) and a guessed
-- column is worse than a derived one. Readers resolve it the same way.
ALTER TABLE activity_log ADD COLUMN source TEXT;
-->statement-breakpoint
-- Who raised the card. Nullable: cards created before this have no author and
-- must read as unknown rather than being attributed to whoever looks plausible.
ALTER TABLE cards ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
-->statement-breakpoint
-- The audit log is queried by board, by user and by window, and the report
-- endpoint does all three at once over 30 days.
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_activity_log_board_created ON activity_log(board_id, created_at);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_activity_log_card ON activity_log(card_id);
