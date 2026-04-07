CREATE TABLE IF NOT EXISTS `board_categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6366f1' NOT NULL
);
-->statement-breakpoint
ALTER TABLE `columns` ADD `show_add_card` integer DEFAULT false NOT NULL;
