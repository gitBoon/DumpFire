-- When a card was completed for the first time, kept for good.
--
-- `completed_at` used to do two jobs: it said when the card was finished, and
-- because nothing ever cleared it, it also said "this card has been completed
-- before", which is what stops XP being awarded twice for dragging a card out of
-- Complete and back in. Reopening a card now clears `completed_at`, as it always
-- should have — a reopened card is not complete — so the second job needs a
-- column of its own.
--
-- Runs once. The runner records this file by name and never runs it again, and
-- it would not survive a second run: since card 2006 (2026-10-12) "duplicate
-- column" is tolerated only in a fixed list of older files, and this is not one
-- of them. The backfill below only touches rows it has not already filled; the
-- runner repeats it on every start and after a restore, for rows that arrive
-- later without a value.
ALTER TABLE `cards` ADD COLUMN `first_completed_at` text;
--> statement-breakpoint
UPDATE `cards` SET `first_completed_at` = `completed_at`
WHERE `first_completed_at` IS NULL AND `completed_at` IS NOT NULL;
