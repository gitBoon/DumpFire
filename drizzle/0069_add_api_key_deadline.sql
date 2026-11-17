-- A deadline for every API key made before this release, and the moment of
-- each account's latest security signal (card 2772, 2026-11-17).
--
-- api_keys.deadline_at is the moment by which the key's holder must keep it,
-- in the stored form of a moment. A key whose deadline has passed is refused
-- as an expired key is (deadlinePassed in src/lib/server/auth.ts), and a set
-- deadline that cannot be read counts as passed. NULL means no deadline: a key
-- made after this file, or one its holder kept. It is not the holder's
-- expiry: expires_at is left as the holder chose it.
--
-- Who sets it: this file, once, and the restore of a backup made before this
-- file (restoreFromBackup in src/lib/server/db/restore.ts), which gives that
-- backup's keys this server's deadline. Who clears it: the holder, with
-- Keep this key on the Account page (POST /api/account/api-keys/[id]/keep),
-- which asks for the password and a code. Nothing ever sets it again on a
-- key, and a key past its deadline is never revived.
--
-- Why: until two-step sign-in, a key was made on a password alone, and so
-- may have been made by whoever held the password. The cut-off is this
-- release, not two_step_released_at: keys made between those two releases
-- were made on a session and no code, and that setting can be absent after a
-- restore. A key made after two-step sign-in costs its holder one Keep.
--
-- The setting api_key_deadline is the moment this file runs plus 60 days,
-- written once and kept. The UPDATE gives it to every key with no expiry or
-- an expiry later than it, comparing as text: every stored expiry is in the
-- stored form since card 2095. A key that ends before the deadline anyway is
-- left alone. Declared to the rehearsal in tests/rehearsal/one-offs.ts as a
-- one-off that keeps its rows (keepsRows on api_keys).
--
-- No IF NOT EXISTS, as 0063: a column of this name already in a database
-- would be one this file did not make, and the file fails rather than record
-- itself over it. Not a foreign key; no index.
--
-- What people see: each key so marked shows its date and Keep this key on
-- the Account page, and stops working on that date unless it is kept. The
-- holders of these keys are told before the release (docs/deployment.md).
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "duplicate column" is tolerated only
-- in a fixed list of older files, and this is not one of them.
--
-- A backup made before this file has the deadline applied by the restore:
-- its keys with no expiry, or one later than this server's deadline, are
-- given that deadline, and the setting is written back where the backup held
-- none. A backup made after this file is restored as it is, so a key kept
-- there stays kept.
--
-- Going back to an older image keeps the column and the setting, unread: that
-- image ignores deadline_at, so keys past their deadline work again there. A
-- rollback past this card is a security event.
--
-- users.security_signal_last_at is the moment of the account's latest
-- stolen-password signal, in the stored form of a moment (card 2772's code
-- review, CS1). raiseSignal (src/lib/server/sign-in-challenges.ts) sets it on
-- every signal; it raises the banner and mails the owner at most once an hour,
-- by security_banner_at, which a signal inside that hour leaves alone. That
-- was me on the Account page sends the moment the page showed and clears the
-- banner only while this column, or security_banner_at where this one is
-- NULL, still holds it; so a signal the page did not show is never cleared
-- unseen. That was me and the account's own password change clear all three
-- columns. NULL on every account here: a banner raised before this file is
-- read by its security_banner_at, as a backup made before it is restored. Not
-- a foreign key; no index. Going back to an older image keeps the column,
-- unread: that image compares on security_banner_at alone.

ALTER TABLE `api_keys` ADD COLUMN `deadline_at` text;
--> statement-breakpoint
INSERT INTO `settings` (`key`, `value`) VALUES ('api_key_deadline', datetime('now', '+60 days'))
  ON CONFLICT (`key`) DO NOTHING;
--> statement-breakpoint
UPDATE `api_keys` SET `deadline_at` = (SELECT `value` FROM `settings` WHERE `key` = 'api_key_deadline')
WHERE `expires_at` IS NULL
   OR `expires_at` > (SELECT `value` FROM `settings` WHERE `key` = 'api_key_deadline');
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `security_signal_last_at` text;
