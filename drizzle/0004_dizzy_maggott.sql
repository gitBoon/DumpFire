CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`name` text NOT NULL,
	`user_id` integer NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `board_favourites` (
	`user_id` integer NOT NULL,
	`board_id` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`user_id`, `board_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `card_attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`uploaded_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `card_templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer,
	`name` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '',
	`priority` text DEFAULT 'medium' NOT NULL,
	`subtasks_json` text DEFAULT '[]',
	`labels_json` text DEFAULT '[]',
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `daily_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`column_id` integer NOT NULL,
	`date` text NOT NULL,
	`card_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `columns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `report_schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`scope` text DEFAULT 'board' NOT NULL,
	`scope_id` integer,
	`frequency` text DEFAULT 'weekly' NOT NULL,
	`day_of_week` integer DEFAULT 1 NOT NULL,
	`day_of_month` integer DEFAULT 1 NOT NULL,
	`time_of_day` text DEFAULT '09:00' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`recipients` text DEFAULT '' NOT NULL,
	`period_days` integer DEFAULT 7 NOT NULL,
	`last_run_at` text,
	`next_run_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `request_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` integer NOT NULL,
	`sender_type` text DEFAULT 'admin' NOT NULL,
	`sender_name` text NOT NULL,
	`message` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `task_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `cards` ADD `archived_at` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `cover_url` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `recurrence_rule` text;--> statement-breakpoint
ALTER TABLE `columns` ADD `wip_limit` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `notification_prefs` text DEFAULT '{}';