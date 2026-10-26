-- Upstream and the commitment point: an Options role for a column, an ideas
-- kind for a board, and when and by whom each card was committed or discarded
-- (milestone 22, cards 2459-2465, 2026-10-26).
--
-- The Kanban Method splits a board's work at the commitment point. Upstream
-- of it are options: ideas that may or may not be done. Downstream is work
-- somebody has committed to. Until now every column was downstream, and an
-- idea parked on a board counted in its lead time, its burndown, its WIP and
-- its reports exactly as committed work did. This file is the whole data
-- model of the milestone:
--
-- - columns.role: NULL for an ordinary column, whose title still decides
--   whether it is To Do, On Hold or Complete, or 'options' for the board's
--   Options column, upstream of the commitment point.
-- - boards.kind: 'delivery', the default and every existing board, or
--   'ideas', a board whose every column is upstream.
-- - cards.committed_at and committed_by: when the card crossed the commitment
--   point and who moved it across. NULL while it is an option.
-- - cards.discarded_at and discarded_by: when an option was archived, which
--   discards it, and by whom. Cleared by a restore.
--
-- role and kind are free text checked in code, not a CHECK: columns and
-- boards are two of the tables the runner rebuilds from the model, and the
-- rebuild refuses a table with a CHECK naming it. The two user columns are ON
-- DELETE SET NULL, as cards.created_by is: losing an account must never lose
-- the work. Each leads an index, card 2106's rule, named idx_<table>_<column>
-- and declared in src/lib/server/db/schema.ts under the same name; IF NOT
-- EXISTS, as every index migration since 0040.
--
-- The UPDATE commits every existing card that is not upstream, archived ones
-- included, at the moment it was created and by whoever created it. Before
-- this file there was no upstream, so every card was created into a committed
-- column and has been committed ever since: that is the value a card created
-- in a committed column is given from this build, and not a guess. Where
-- created_by is NULL (cards from before authorship was recorded) committed_by
-- stays NULL: not recorded. No card is upstream yet, because no column has a
-- role and no board is an ideas board, so that is every card on a column of a
-- board that is there. updated_at is left as it is, because nobody edited the
-- cards, and no activity entry is written.
--
-- What people see: nothing changes. No board has an Options column or is an
-- ideas board until somebody makes one. Once the milestone ships, lead time
-- runs from committed_at, which equals created_at for every existing card, so
-- no figure moves. It is declared to the rehearsal in
-- tests/rehearsal/one-offs.ts as a one-off that keeps every row of cards.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "duplicate column" is tolerated only
-- in a fixed list of older files, and this is not one of them. The runner
-- repeats the UPDATE as a backfill (runBackfills in
-- src/lib/server/db/migrate.ts, COMMITTED_BEFORE_UPSTREAM) at every start and
-- after every restore, beside two that clear a commitment on an upstream card
-- and a discard mark on a card that is not archived; a test holds the two
-- copies of the UPDATE to the same text. A backup made before this file
-- restores with every role NULL, every board a delivery board, nothing
-- discarded, and every card committed by that backfill.
--
-- Going back to an older image keeps these columns and their values: the
-- older build runs no migration that drops them, and a restore copies every
-- column both sides have. What is lost meanwhile is their upkeep. The older
-- build's own writes do not maintain them: a card it creates has no
-- commitment, and a card it moves out of an Options column is not stamped.
-- Going forward again, the backfill commits both from created_at, which for a
-- card that waited in Options makes its lead time longer than it was.

ALTER TABLE `columns` ADD COLUMN `role` text;
--> statement-breakpoint
ALTER TABLE `boards` ADD COLUMN `kind` text DEFAULT 'delivery' NOT NULL;
--> statement-breakpoint
ALTER TABLE `cards` ADD COLUMN `committed_at` text;
--> statement-breakpoint
ALTER TABLE `cards` ADD COLUMN `committed_by` integer REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
ALTER TABLE `cards` ADD COLUMN `discarded_at` text;
--> statement-breakpoint
ALTER TABLE `cards` ADD COLUMN `discarded_by` integer REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cards_committed_by` ON `cards` (`committed_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cards_discarded_by` ON `cards` (`discarded_by`);
--> statement-breakpoint
UPDATE `cards` SET `committed_at` = `created_at`, `committed_by` = `created_by`
WHERE `committed_at` IS NULL
  AND EXISTS (SELECT 1 FROM `columns` `c` JOIN `boards` `b` ON `b`.`id` = `c`.`board_id`
              WHERE `c`.`id` = `cards`.`column_id` AND `c`.`role` IS NOT 'options' AND `b`.`kind` IS NOT 'ideas');
