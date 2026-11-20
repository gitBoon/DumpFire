-- A request whose mail to its requester is held, and its last release (card 3020, 2026-11-20).
--
-- task_requests.mail_held_because: NULL for none, otherwise why, in words. A
-- restore of a backup whose seal did not verify writes it, as it is or as a
-- working copy, for each request with an address that this server did not hold
-- as it is: the request, its card and the card's board, and the requester's
-- account the same here (holdUnsealedRequestMail in
-- src/lib/server/db/restore.ts); for a request it did hold as it is, it writes
-- this server's own value, never the file's. While it is set,
-- requesterMailAddress (src/lib/server/request-access.ts) answers null and
-- progress mail passes the request by, so no mail, link or report goes to the
-- requester. It is cleared by an administrator's release with a password and a
-- code (POST /api/requests/held).
--
-- Other writers clear it too: a restore of a backup whose seal verified
-- brings it as the backup holds it, which for a backup made before this file
-- is NULL, and Reset Everything deletes every request with it.
--
-- task_requests.mail_released_at, mail_released_by, mail_released_by_name:
-- who released the last hold, and when, in the stored form; the name kept as
-- it was, since the account may be deleted (its key then empties, ON DELETE
-- SET NULL).
--
-- The index is card 2106's rule, that every foreign key column leads an
-- index, named idx_<table>_<column> and declared in
-- src/lib/server/db/schema.ts under the same name. SQLite takes ADD COLUMN
-- with a foreign key when the column's default is NULL. Changes no row: every
-- request already stored is mailed as before, all four columns NULL, so
-- nothing is declared in tests/rehearsal/one-offs.ts.
--
-- No IF NOT EXISTS, as 0072: a column or an index of these names already in a
-- database would be one this file did not make, and the file fails rather
-- than record itself over it.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "duplicate column" is tolerated only
-- in a fixed list of older files, and this is not one of them.
--
-- Shipped alone (card 3020, R15). Going back to an older image: the older
-- image does not read mail_held_because, so every held request is mailed
-- there. Before going back, run the commands in docs/deployment.md. Keep the
-- columns, and do not drop them: the older image's schema check reports them
-- as columns it does not know, and leaves them.

ALTER TABLE `task_requests` ADD COLUMN `mail_held_because` text;
--> statement-breakpoint
ALTER TABLE `task_requests` ADD COLUMN `mail_released_at` text;
--> statement-breakpoint
ALTER TABLE `task_requests` ADD COLUMN `mail_released_by` integer REFERENCES `users`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE `task_requests` ADD COLUMN `mail_released_by_name` text;
--> statement-breakpoint
CREATE INDEX `idx_task_requests_mail_released_by` ON `task_requests` (`mail_released_by`);
