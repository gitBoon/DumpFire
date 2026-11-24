-- The compatibility release: every session, pending invite, requester link,
-- API key and webhook a server from before two-step sign-in holds keeps
-- working through the start that applies this file (card 3064, 2026-11-24).
--
-- Why. 0066 to 0083 were written for a server that had already had the
-- releases of two-step sign-in, hashed sessions, invites and requester links,
-- API key deadlines and webhook holds one at a time. A server that meets them
-- all in one start (live, at 0060) would sign everybody out, end every invite
-- and requester link, give every API key a deadline and hold or stop its
-- webhooks. 0067, 0068 and 0070 no longer delete what this file keeps; this
-- file takes back the data lines of 0066, 0069 and 0071 in the same start.
--
-- What it does, in order:
--  1. The release moment, the setting compatibility_release_at, written once.
--     Kept sessions are dated from it, the old cookie name is read only for
--     30 days after it, and requester links of requests settled before it get
--     their 90 days from it. A restore keeps this server's.
--  2. sessions.kept_at_release: 1 for a session this file keeps and nobody
--     has used by the old cookie name since, 2 once swapped to a new code
--     under the secure name (its last 60 seconds), 0 for every other.
--  3. Sessions: every row still held in plain is hashed in place (SHA-256,
--     the digest's 32 bytes as a BLOB, the form src/lib/server/auth.ts looks a
--     session up by), marked kept, dated from the release, and its expiry
--     capped at 30 days from now, written in the stored form. An expiry in
--     another form is read as the moment it names; one that names no moment
--     is left as it is, and the start's clean-up deletes it. A row already a
--     32-byte BLOB is a session this image made, and is untouched.
--  4. Invites: every unused invite still held in plain is hashed in place, as
--     src/lib/server/invites.ts hashes one. The mailed link works unchanged.
--  5. Requester links: each request's one token moves into request_links, as
--     its SHA-256 in hex (source 'mail', dated from the release), and the
--     column is emptied. The mailed link works unchanged.
--  6. API keys: 0069's deadline taken back from every key, and its setting
--     deleted. A later, planned event applies one (E4 in docs/deployment.md).
--  7. Two-step sign-in: 0066's release moment deleted and its leave to set up
--     on a password taken back from every account. Two-step sign-in is
--     dormant until the superadmin requires it, which writes both again.
--  8. Webhooks: every webhook set up before keys were recorded (set_with_key
--     NULL) is marked as set with none (0), so that no key ending stops it
--     (card 2893's rule) until E4 restores the rule for them.
--  9. The six first-run flags, each written unless already there, so that
--     each first-run pass takes its steady state at this start: nothing held
--     once, nothing re-keyed, nothing mailed, no stored image rewritten.
-- 10. The one-shot leave to keep a backup seal key held in plain as 64 hex,
--     backup_seal_key_keep_once (the code review's CS-M2): the start that
--     follows this file keeps such a key, sealed in place, so that the
--     backups it sealed still verify, and deletes the leave in the same
--     transaction. Every later start replaces a plain seal key, as card 2943
--     does. A restore keeps this server's, never a backup's.
-- 11. The scrub's marker, secrets_scrub_pending, written unless already
--     there (the code review's CS-L4), as an ISO time as the start writes
--     it: the plain text this file's UPDATEs overwrite is scrubbed before the
--     server listens, and the scrub says so, whatever else the start seals.
--
-- SQLite has no SHA-256: runMigrations (src/lib/server/db/migrate.ts) gives
-- the connection it migrates sha256_blob and sha256_hex before the first
-- file, and only this file calls them. The plain text the UPDATEs overwrite is
-- scrubbed from the file's free pages and its WAL at this same start, before
-- the server listens (scrubStoredSecrets in src/lib/server/startup-checks.ts),
-- by the marker step 11 writes.
--
-- What people see: nothing. Nobody is signed out, no invite or requester link
-- stops working, no API key is given an end date, no webhook stops or has its
-- secret changed. Remembered browsers are forgotten once (0067).
--
-- On a database with nothing in plain (one that has run 0067, 0068 and 0070
-- as they were before this card, or a new one) it hashes, moves and marks
-- nothing, and still writes the settings and takes back the deadlines, the
-- leave and the release moment. Declared to the rehearsal in
-- tests/rehearsal/one-offs.ts: keepsRows on sessions, invite_tokens,
-- task_requests, api_keys, users and webhooks, and settings losing the two
-- rows taken back (and gaining the release moment, the six flags, the leave
-- and the marker, which the rehearsal notes as rows a migration put there).
--
-- Steps 10 and 11 were added by card 3064's code review, before this file
-- reached any server but test databases and perhaps a developer's own: a
-- development database whose server applied the file before then has neither
-- the leave nor the marker. That is accepted: such a database holds no plain
-- seal key from live (its start replaces any plain key, as card 2943 does),
-- and its scrub ran or runs by the start's own marker.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "duplicate column" is tolerated only
-- in a fixed list of older files, and this is not one of them.
--
-- A backup before it: take the cold copy of the whole volume before the start
-- that applies this file (docs/deployment.md). Sessions are never restored,
-- so a backup without kept_at_release restores as before.
--
-- Going back to an older image after it: that image cannot read a hashed
-- session, invite or link (everybody is signed out there, and invites and
-- requester links do not work), and ignores the column. Going back is the
-- cold copy taken before the start, not this database.

-- The moment of the compatibility release: kept sessions are dated from it, the old cookie name is read only for
-- 30 days after it, and 2902's 90 days run from it at the earliest. A restore keeps this server's.
INSERT INTO `settings` (`key`, `value`) VALUES ('compatibility_release_at', datetime('now'))
  ON CONFLICT (`key`) DO NOTHING;
--> statement-breakpoint
-- Sessions kept at the release are marked (1), so that the old cookie name is read for them and no other: 2 once
-- swapped to a new code under the secure name (its last 60 seconds), 0 for every other session.
ALTER TABLE `sessions` ADD COLUMN `kept_at_release` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Sessions (C2): every row still in plain, hashed in place, marked kept, dated from the release, its expiry capped at
-- 30 days and written in the stored form (an ISO-form expiry is read as the moment it names; one that names none is
-- left for the start's clean-up to delete).
UPDATE `sessions`
   SET `id` = sha256_blob(`id`),
       `kept_at_release` = 1,
       `created_at` = (SELECT `value` FROM `settings` WHERE `key` = 'compatibility_release_at'),
       `expires_at` = CASE
           WHEN datetime(`expires_at`) IS NULL THEN `expires_at`
           WHEN datetime(`expires_at`) > datetime('now', '+30 days') THEN datetime('now', '+30 days')
           ELSE datetime(`expires_at`)
         END
 WHERE typeof(`id`) <> 'blob' OR length(`id`) <> 32;
--> statement-breakpoint
-- Invites (C3): every unused invite still in plain, hashed in place; its mailed link works unchanged.
UPDATE `invite_tokens` SET `token` = sha256_blob(`token`)
 WHERE `used` = 0 AND (typeof(`token`) <> 'blob' OR length(`token`) <> 32);
--> statement-breakpoint
-- Requester links (C3): each request's one link moved into request_links as its hash, then the column emptied.
INSERT INTO `request_links` (`token_hash`, `request_id`, `source`, `created_at`)
SELECT sha256_hex(`access_token`), `id`, 'mail',(SELECT `value` FROM `settings` WHERE `key` = 'compatibility_release_at')
  FROM `task_requests` WHERE `access_token` IS NOT NULL AND `access_token` <> '' ORDER BY `id`;
--> statement-breakpoint
UPDATE `task_requests` SET `access_token` = NULL WHERE `access_token` IS NOT NULL;
--> statement-breakpoint
-- API keys (C4): 0069's deadline taken back; a later event (E4, within 60 days of E3) applies one.
UPDATE `api_keys` SET `deadline_at` = NULL WHERE `deadline_at` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `settings` WHERE `key` = 'api_key_deadline';
--> statement-breakpoint
-- Two-step sign-in (C1): 0066's release moment and leave taken back; the superadmin's switch writes both again.
DELETE FROM `settings` WHERE `key` = 'two_step_released_at';
--> statement-breakpoint
UPDATE `users` SET `mfa_password_enrol` = 0 WHERE `mfa_password_enrol` <> 0;
--> statement-breakpoint
-- Webhooks (C5): none set before keys were recorded is stopped by its setter's keys (2893) until E4 restores the rule.
UPDATE `webhooks` SET `set_with_key` = 0 WHERE `set_with_key` IS NULL;
--> statement-breakpoint
-- The six first-run flags (C5): each pass takes its steady state at the first start.
INSERT INTO `settings` (`key`, `value`) VALUES
  ('webhooks_already_off_held', datetime('now')),
  ('webhooks_readable_by_disabled_held', datetime('now')),
  ('webhook_reveals_seeded', datetime('now')),
  ('webhooks_before_keys_announced', datetime('now')),
  ('report_schedules_announced', datetime('now')),
  ('stored_images_rechecked', datetime('now'))
  ON CONFLICT (`key`) DO NOTHING;
--> statement-breakpoint
-- The one-shot leave to keep a backup seal key held in plain (CS-M2): spent by the next start, kept or not.
INSERT INTO `settings` (`key`, `value`) VALUES ('backup_seal_key_keep_once', datetime('now'))
  ON CONFLICT (`key`) DO NOTHING;
--> statement-breakpoint
-- The scrub's marker (CS-L4), an ISO time as the start writes it, so that the start scrubs before the server listens.
INSERT INTO `settings` (`key`, `value`) VALUES ('secrets_scrub_pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT (`key`) DO NOTHING;
