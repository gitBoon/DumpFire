-- Corrected 2026-10-12 (card 2006). Two statements near the end of this file.
--
-- What changed:
--   boards.parent_card_id  was a bare integer. It now references cards(id)
--                          ON DELETE CASCADE.
--   boards.created_by      referenced users(id) with no ON DELETE action. It is
--                          now ON DELETE SET NULL.
--
-- Why: on a new database this file sorts ahead of the hand-written migrations
-- that add the same two columns (0010_add_sub_boards and
-- 0011_add_user_management), so its versions were the ones kept and theirs were
-- skipped as duplicates. Production, which is older than this file, has the
-- hand-written versions. A new database therefore left sub-boards behind when
-- their card was deleted, and refused to delete a user who had created a board.
-- These two statements now say what 0010 and 0011 say, which is what production
-- has and what the model (src/lib/server/db/schema.ts) declares.
--
-- No existing database runs this file again: the runner records a migration by
-- file name and skips every name it has recorded. A database that already ran
-- the earlier form of this file has its `boards` table rebuilt in this shape by
-- the runner itself, at start-up (reconcileSchema in
-- src/lib/server/db/migrate.ts).
CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`card_id` integer,
	`user_id` integer,
	`action` text NOT NULL,
	`detail` text DEFAULT '',
	`user_name` text DEFAULT '',
	`user_emoji` text DEFAULT '👤',
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `board_members` (
	`board_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	PRIMARY KEY(`board_id`, `user_id`),
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `board_teams` (
	`board_id` integer NOT NULL,
	`team_id` integer NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	PRIMARY KEY(`board_id`, `team_id`),
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `card_assignees` (
	`card_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	PRIMARY KEY(`card_id`, `user_id`),
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `card_labels` (
	`card_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invite_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`used` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subtasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '',
	`priority` text DEFAULT 'medium' NOT NULL,
	`color_tag` text DEFAULT '',
	`due_date` text,
	`completed` integer DEFAULT false NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`team_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	PRIMARY KEY(`team_id`, `user_id`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`emoji` text DEFAULT '🏢',
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_xp` (
	`name` text PRIMARY KEY NOT NULL,
	`xp` integer DEFAULT 0 NOT NULL,
	`emoji` text DEFAULT '👤'
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`emoji` text DEFAULT '👤',
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `boards` ADD `parent_card_id` integer REFERENCES cards(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `boards` ADD `is_public` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `boards` ADD `created_by` integer REFERENCES users(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `category_id` integer REFERENCES categories(id);--> statement-breakpoint
ALTER TABLE `cards` ADD `due_date` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `on_hold_note` text DEFAULT '';--> statement-breakpoint
ALTER TABLE `cards` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `completed_at` text;