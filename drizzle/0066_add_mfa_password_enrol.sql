-- What the release of two-step sign-in needs stored first (card 2769, 2026-11-13).
--
-- users.mfa_password_enrol is 1 when the account may set up its
-- authenticator on its password alone. It is honoured only where no mail
-- host is configured, and only for 14 days from `two_step_released_at`
-- (below): an accepted risk (R1), closed by date. It is set back to 0 when
-- the account sets up two-step sign-in, by an administrator's reset of its
-- two-step sign-in (resetTwoStep in src/lib/server/mfa-store.ts), and by the
-- host's reset script (scripts/mfa-reset.mjs). An account made after this
-- file gets 0, the default, and needs a set-up link or an invite.
--
-- The one UPDATE, last in the file, gives 1 to every account that has no
-- second factor and no enrolment link. An account with a factor has nothing
-- to set up. An account with any enrolment link row, an expired one
-- included, keeps 0: its two-step sign-in was reset by an administrator
-- before this release, and that reset must not be undone by the release.
-- It is declared to the rehearsal in tests/rehearsal/one-offs.ts as a
-- one-off that keeps its rows (keepsRows on users).
--
-- sessions.two_step is 1 when the session was made after a second factor.
-- createSession (src/lib/server/auth.ts) writes 1; findSession refuses a
-- session with 0, deletes it and logs it. Every session there now is given 0,
-- so this image refuses each of them (0067 deletes them anyway), and so it
-- refuses every session an older image makes from here on, since that image
-- writes no value to the column.
--
-- sign_in_challenges.enrol_grant names what lets an enrol challenge set up a
-- factor ('password', 'link', 'invite' or 'setup'), and
-- sign_in_challenges.enrolment_link_hash the enrolment link it came from,
-- taken with the factor. Both NULL on a verify challenge; the table is empty
-- before card 2769 issues any.
--
-- The setting two_step_released_at, the moment this file runs, starts the
-- 14 days. A missing or unreadable setting is read as the 14 days over.
--
-- None of these is a foreign key, and none is a moment kept in a `*_at`
-- column. users and sessions are not tables the runner rebuilds from the
-- model (RECONCILED_TABLES in src/lib/server/db/migrate.ts), so this file
-- alone changes them.
--
-- No IF NOT EXISTS, as 0063 (card 2685's code review, S5): a column of
-- these names already in a database would be one this file did not make, and
-- the file fails rather than record itself over it.
--
-- What people see: nothing until they sign in. Then a right password asks
-- for a second step.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "duplicate column" is tolerated only
-- in a fixed list of older files, and this is not one of them.
--
-- A backup made before this file restores with no two_step_released_at, so
-- the 14 days are over, and every flag 0 but those of accounts still on this
-- server, which keep this server's own (src/lib/server/mfa-backup.ts).
--
-- Going back to an older image keeps the columns and the setting, unread:
-- the older build runs no migration that drops them and its model check
-- reports them at every start without acting on them. That image signs
-- people in on a password alone, which is a security event. Its sessions
-- (two_step 0) and its remembered-browser cookies (signed under the older
-- MAC domain) are refused when this image runs again.

ALTER TABLE `users` ADD COLUMN `mfa_password_enrol` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD COLUMN `two_step` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `sign_in_challenges` ADD COLUMN `enrol_grant` text;
--> statement-breakpoint
ALTER TABLE `sign_in_challenges` ADD COLUMN `enrolment_link_hash` text;
--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`) VALUES ('two_step_released_at', datetime('now'))
  ON CONFLICT (`key`) DO NOTHING;
--> statement-breakpoint
UPDATE `users` SET `mfa_password_enrol` = 1
WHERE NOT EXISTS (SELECT 1 FROM `mfa_factors` WHERE `mfa_factors`.`user_id` = `users`.`id`)
  AND NOT EXISTS (SELECT 1 FROM `enrolment_links` WHERE `enrolment_links`.`user_id` = `users`.`id`);
