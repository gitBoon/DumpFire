-- Every ending of an account on this server: deleted, disabled, enabled, its role changed (card 2996, 2026-11-20).
--
-- A row says what happened to the account with this `user_id` and this
-- creation time (`account_created`, its `created_at` in the stored form):
-- `deleted`, with `credential` a SHA-256 fingerprint of its password hash,
-- never the hash; `disabled`; `enabled`; `role`, with the role after (a raise
-- too, and the role an account was made with). `origin` is `here` for a row
-- this server wrote, `backup` for one a restore brought, and `belt` for one the
-- record's own rule wrote (never evidence against a superadmin). `seq` orders
-- the rows as they were written, so that a disable and an enable in one second
-- still have an order. `stated_ended` is the moment as the row's writer stated
-- it: `ended_at` here, and a backup's own, before any clamp, for a row a
-- restore brought, so that importing the same backup again adds nothing.
--
-- The seed's role rows are dated at the account's creation, and its disables at
-- their own moment (the earliest stamp where either names no moment or one
-- after the migration), so that a dump of the record put back after a host
-- rollback, its later rows, always outranks them. Every writer adds its row in the transaction that makes
-- the change (`recordAccountEnding`, src/lib/server/account-endings.ts), with a
-- plain INSERT, and no write deletes, changes or replaces a row.
--
-- No foreign key: a row outlives its account.
--
-- The watermark (ending 'watermark', user_id W): the larger of the users id
-- counter and the largest id held. Admin > Vacuum and Reset deleted the
-- counters before c6ed310, so the counter alone can be below the largest id
-- issued. A seed row (ending 'deleted', account_created '') names an account by
-- its id only where that id is at most W, and never a superadmin.
--
-- The seed, once: every id from 1 to W that users does not hold, by id alone;
-- and every present account but the superadmin, its role, and its disable
-- where it is disabled, each with its creation time. Changes no existing row.
-- Nothing is declared in tests/rehearsal/one-offs.ts.
--
-- A restore keeps this table, as it keeps the system log, and adds the
-- backup's rows to it; Reset Everything keeps it. Going back to an older image
-- leaves it unwritten there, and that image's restore clears and refills it
-- from the backup: see docs/deployment.md.
--
-- The guard first, as 0076's: one row per id, never a range, so where W less
-- the accounts held is more than 1,000,000 (a counter set far above every
-- account) the file fails on the guard's CHECK, whose name says why, and
-- nothing of it is applied.

CREATE TEMP TABLE `migration_0077_guard` (
	`seed_rows` integer NOT NULL CONSTRAINT `migration 0077 would record more than 1,000,000 account ids this server no longer holds: the users id counter in sqlite_sequence is far above every account; see docs/deployment.md, card 2996` CHECK (`seed_rows` <= 1000000)
);
--> statement-breakpoint
INSERT INTO temp.`migration_0077_guard` (`seed_rows`)
SELECT max(coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'users'), 0), coalesce((SELECT max(id) FROM users), 0)) - (SELECT count(*) FROM users);
--> statement-breakpoint
DROP TABLE temp.`migration_0077_guard`;
--> statement-breakpoint
CREATE TABLE `account_endings` (
	`seq` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`account_created` text NOT NULL,
	`ending` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`credential` text DEFAULT '' NOT NULL,
	`ended_at` text NOT NULL,
	`stated_ended` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'here' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_endings_account` ON `account_endings` (`user_id`,`account_created`,`ending`,`stated_ended`);
--> statement-breakpoint
CREATE INDEX `account_endings_credential` ON `account_endings` (`credential`) WHERE credential <> '';
--> statement-breakpoint
CREATE INDEX `account_endings_watermark` ON `account_endings` (`user_id`) WHERE ending = 'watermark';
--> statement-breakpoint
INSERT INTO `account_endings` (`user_id`, `account_created`, `ending`, `ended_at`, `stated_ended`)
SELECT max(coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'users'), 0), coalesce((SELECT max(id) FROM users), 0)), '', 'watermark', datetime('now'), datetime('now');
--> statement-breakpoint
INSERT INTO `account_endings` (`user_id`, `account_created`, `ending`, `ended_at`, `stated_ended`)
WITH RECURSIVE ids(id) AS (
	SELECT 1 WHERE (SELECT user_id FROM account_endings WHERE ending = 'watermark') >= 1
	UNION ALL
	SELECT id + 1 FROM ids WHERE id < (SELECT user_id FROM account_endings WHERE ending = 'watermark')
)
SELECT id, '', 'deleted', datetime('now'), datetime('now') FROM ids WHERE id NOT IN (SELECT id FROM users);
--> statement-breakpoint
INSERT INTO `account_endings` (`user_id`, `account_created`, `ending`, `ended_at`, `stated_ended`)
SELECT id, created, 'disabled', at, at FROM (
	SELECT id, coalesce(datetime(created_at), created_at) AS created,
		CASE WHEN datetime(disabled_at) IS NOT NULL AND datetime(disabled_at) <= datetime('now') THEN datetime(disabled_at) ELSE '0001-01-01 00:00:00' END AS at
	FROM users WHERE disabled_at IS NOT NULL AND role <> 'superadmin'
) ORDER BY id;
--> statement-breakpoint
INSERT INTO `account_endings` (`user_id`, `account_created`, `ending`, `role`, `ended_at`, `stated_ended`)
SELECT id, created, 'role', role, at, at FROM (
	SELECT id, role, coalesce(datetime(created_at), created_at) AS created,
		CASE WHEN datetime(created_at) IS NOT NULL AND datetime(created_at) <= datetime('now') THEN datetime(created_at) ELSE '0001-01-01 00:00:00' END AS at
	FROM users WHERE role IN ('admin', 'user')
) ORDER BY id;
