CREATE TABLE IF NOT EXISTS `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`emoji` text DEFAULT '👤',
	`role` text NOT NULL DEFAULT 'user',
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
-->statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`);
-->statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_email_unique` ON `users` (`email`);
-->statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
-->statement-breakpoint
CREATE TABLE IF NOT EXISTS `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`emoji` text DEFAULT '🏢',
	`created_at` text NOT NULL DEFAULT (datetime('now'))
);
-->statement-breakpoint
CREATE TABLE IF NOT EXISTS `team_members` (
	`team_id` integer NOT NULL REFERENCES `teams`(`id`) ON DELETE CASCADE,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`role` text NOT NULL DEFAULT 'member',
	PRIMARY KEY (`team_id`, `user_id`)
);
-->statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_members` (
	`board_id` integer NOT NULL REFERENCES `boards`(`id`) ON DELETE CASCADE,
	`user_id` integer NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`role` text NOT NULL DEFAULT 'viewer',
	PRIMARY KEY (`board_id`, `user_id`)
);
-->statement-breakpoint
CREATE TABLE IF NOT EXISTS `board_teams` (
	`board_id` integer NOT NULL REFERENCES `boards`(`id`) ON DELETE CASCADE,
	`team_id` integer NOT NULL REFERENCES `teams`(`id`) ON DELETE CASCADE,
	`role` text NOT NULL DEFAULT 'viewer',
	PRIMARY KEY (`board_id`, `team_id`)
);
-->statement-breakpoint
ALTER TABLE `boards` ADD COLUMN `created_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL;
-->statement-breakpoint
ALTER TABLE `activity_log` ADD COLUMN `user_id` integer REFERENCES `users`(`id`) ON DELETE SET NULL;
