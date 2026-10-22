-- Who set where the mail settings, the App URL and each backup destination send (card 2397, 2026-10-22).
--
-- setting_setters holds, for each setting that sends mail or backups
-- somewhere, the account that first put it at each place it has been: `mail`
-- for the smtp_* rows of settings, taken as one (the password goes with the
-- host), `app_url`, and `backup_destination:<name>` for each destination in
-- the backup_config row, found by its name as everything else finds it.
-- `place` is a SHA-256 digest of what decides where it sends (the mail host,
-- port, user and way out; the App URL; a destination's type and every field
-- that says which account and place), so no host, user name or key ID is
-- copied here. The setting's setter is the account recorded for the place it
-- is at now: a setting changed and changed back is its first setter's again
-- (the second code review). `user_id` NULL is a place recorded as nobody's:
-- where a setting saved before this file is first moved, the place it leaves
-- is recorded so, and moved back there it is nobody's again (the third
-- review). One row per account per setting. PUT /api/admin/smtp, PUT /api/admin/backup and a
-- Google Drive Connect write it; demoting that account to user, or deleting
-- it, removes what it set, in the same transaction
-- (src/lib/server/setting-setters.ts). Since card 2395 every administrator
-- can point mail and backups at a server of their own, and before this a
-- demoted one's server went on receiving both.
--
-- A table of its own, and not a column: the destinations are one JSON row, so
-- a column on settings could not name a setter for each, and settings is one
-- of the six tables the runner rebuilds whenever it differs from the model.
--
-- ON DELETE CASCADE: deleteUser removes the settings first, so the key only
-- takes the setter rows (a row naming nobody names no account to cascade from). The index is card 2106's rule, that every foreign key
-- column leads an index, named idx_<table>_<column> and declared in
-- src/lib/server/db/schema.ts under the same name. IF NOT EXISTS, as every
-- index migration since 0040.
--
-- Changes no row. Every setting already stored has no setter, because nothing
-- recorded who saved it: it stays in force, unattributed, until somebody next
-- changes it. So nothing is declared to the rehearsal in
-- tests/rehearsal/one-offs.ts.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "already exists" is tolerated only in
-- a fixed list of older files, and this is not one of them. A backup made
-- before this file has no such table: a restore of it leaves the table empty,
-- and every setting it brings unattributed.

CREATE TABLE `setting_setters` (
	`setting` text NOT NULL,
	`place` text NOT NULL,
	`user_id` integer,
	PRIMARY KEY(`setting`, `place`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_setting_setters_user_id` ON `setting_setters` (`user_id`);
