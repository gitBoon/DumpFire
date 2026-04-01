ALTER TABLE `cards` ADD COLUMN `due_date` text;
--> statement-breakpoint
ALTER TABLE `subtasks` ADD COLUMN `description` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `subtasks` ADD COLUMN `priority` text DEFAULT 'medium' NOT NULL;
--> statement-breakpoint
ALTER TABLE `subtasks` ADD COLUMN `color_tag` text DEFAULT '';
--> statement-breakpoint
ALTER TABLE `subtasks` ADD COLUMN `due_date` text;
