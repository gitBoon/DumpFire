-- Corrected 2026-10-12 (card 2006).
--
-- What changed: `board_id` was declared NOT NULL with ON DELETE cascade. It is
-- now nullable with ON DELETE set null.
--
-- Why: the model (src/lib/server/db/schema.ts) has had it nullable and set null
-- since 2 April 2026 (commit e766d18), because a category that belongs to no
-- board is a shared one, and deleting a board must not delete a category that
-- cards elsewhere still use. From that commit on, a database built from this
-- file disagreed with the model, and a shared category could not be created on
-- it at all.
--
-- No existing database runs this file again: the runner records a migration by
-- file name and skips every name it has recorded. A database that was built
-- from the old statement has its `categories` table rebuilt in this shape by
-- the runner itself (reconcileSchema in src/lib/server/db/migrate.ts).
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer,
	`name` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `cards` ADD COLUMN `category_id` integer REFERENCES `categories`(`id`) ON DELETE SET NULL;
