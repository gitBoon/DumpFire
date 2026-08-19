CREATE TABLE IF NOT EXISTS `system_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`level` text NOT NULL,
	`context` text NOT NULL,
	`message` text NOT NULL,
	`meta` text,
	`user_id` integer,
	`ip` text
);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_system_logs_timestamp` ON `system_logs` (`timestamp`);
-->statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_system_logs_level` ON `system_logs` (`level`);
