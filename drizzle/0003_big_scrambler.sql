CREATE TABLE `backup_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`destination_type` text NOT NULL,
	`destination_name` text NOT NULL,
	`filename` text NOT NULL,
	`size_bytes` integer,
	`status` text NOT NULL,
	`error` text,
	`duration_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `board_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `card_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `columns` ADD `show_add_card` integer DEFAULT false NOT NULL;