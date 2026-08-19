CREATE TABLE IF NOT EXISTS `daily_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer NOT NULL,
	`column_id` integer NOT NULL,
	`date` text NOT NULL,
	`card_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `columns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_daily_snapshots_board_date` ON `daily_snapshots` (`board_id`, `date`);
