-- A secret link for each task request.
--
-- Someone without an account reads and answers their request through a link in
-- an email. That link used to carry their email address, and the address was the
-- only thing checked — so anyone who knew a requester's address could read their
-- requests and the team's replies, and post into the thread as them.
--
-- Each request now has its own random token and the link carries that instead.
-- Existing requests are given one here so the next email sent about them has a
-- working link; links already sitting in inboxes used the address and stop working.
--
-- Runs once. The runner records this file by name and never runs it again, and
-- it would not survive a second run: since card 2006 (2026-10-12) "duplicate
-- column" is tolerated only in a fixed list of older files, and this is not one
-- of them. The backfill only fills rows that have no token; the runner repeats
-- it on every start and after a restore, for rows that arrive later without
-- one. The index is IF NOT EXISTS.
ALTER TABLE `task_requests` ADD COLUMN `access_token` text;
--> statement-breakpoint
UPDATE `task_requests` SET `access_token` = lower(hex(randomblob(32))) WHERE `access_token` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `task_requests_access_token_idx` ON `task_requests` (`access_token`);
