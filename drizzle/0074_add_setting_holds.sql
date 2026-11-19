-- The settings held for the superadmin's review (card 2922, 2026-11-19).
--
-- When an account's access ends with its API keys (an administrator's password
-- set, an invite used, a two-step reset in the app or on the host, the holder's
-- own change that ends keys), every place the account is recorded as having
-- put the mail settings, the App URL or a backup destination at
-- (setting_setters, migration 0059) is copied here. A setting is held while it
-- is at a place this table holds: no mail is sent through held mail settings,
-- no link begins with a held App URL, and no backup is sent to, pruned at,
-- tested at or connected for a held destination
-- (src/lib/server/setting-holds.ts). Only the superadmin's Keep deletes a row;
-- a removal leaves it, so a setting saved or restored at that place again is
-- held again.
--
-- No foreign key to users: a hold outlives the account whose ending made it.
-- set_by_name is the account's username when it was held, for the review
-- list once the account is gone.
--
-- Changes no row. Nothing is declared in tests/rehearsal/one-offs.ts.
--
-- A backup made before this file has no holds: a restore carries this
-- server's over it (db/restore.ts `carrySettingHolds`).
--
-- Going back to an older image ignores the table: every held setting is in
-- force again. Keep or remove each first (the start names them at WARN). See
-- docs/deployment.md.

CREATE TABLE `setting_holds` (
	`setting` text NOT NULL,
	`place` text NOT NULL,
	`held_because` text NOT NULL,
	`held_at` text NOT NULL,
	`set_by` integer,
	`set_by_name` text,
	PRIMARY KEY(`setting`, `place`)
);
