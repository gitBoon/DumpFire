-- Where a requester's links are kept, only as hashes, and every link held in
-- plain ended once (card 2870, 2026-11-17).
--
-- request_links holds one row for each mail to a requester that carried a
-- link (the confirmation, a team reply, a progress mail: source 'mail') and
-- for each new link a requester asked for (source 'ask'), each only as the
-- SHA-256 of its token, in hex (src/lib/server/request-tokens.ts). The token
-- is only in the mail. A request keeps its newest 20 mail links and its
-- newest 3 asked-for links, each kind trimmed only among its own. A link is
-- looked up by its hash before the request is read. The key to task_requests
-- is ON DELETE CASCADE and leads an index, card 2106's rule.
--
-- task_requests.access_token held the one token of each request as it was
-- mailed: whoever could read the database file could read every request
-- thread and post into it as the requester, and the links never expired.
-- The column is retired and kept, so that an older image still reads the
-- table; from this release it is always NULL.
--
-- A one-off change to data: the UPDATE sets every access_token to NULL, and
-- request_links starts empty, so every link mailed before the deploy is
-- ended. Hashing in place would leave each token in the file's free pages and
-- its WAL, still working, and SQLite has no SHA-256.
--
-- What people see: every requester link mailed before the deploy stops
-- working, once. The page it opens asks for the address the request was made
-- with and mails a new link, and the next team reply or progress mail brings
-- one by itself. Requests and their messages are untouched.
--
-- Harmless where it finds nothing: a new database has no requests. Declared
-- to the rehearsal in tests/rehearsal/one-offs.ts as a one-off that keeps its
-- rows (keepsRows on task_requests: every access_token ended).
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "already exists" is tolerated only
-- in a fixed list of older files, and this is not one of them. A plain token
-- an older image writes after going back is set to NULL at start-up, and
-- every link is then ended (endPlainRequestLinks in
-- src/lib/server/startup-checks.ts).
--
-- A backup made before this file holds no request token (card 2158) and no
-- request_links table. A restore brings in no link from any backup and reads
-- every access_token as NULL (rowsToRestore in src/lib/server/db/restore.ts),
-- so every link is ended by a restore, as before.
--
-- Going back to an older image: keep request_links, and do not drop it. The
-- older image's schema check reports it as a table it does not know, and
-- leaves it. Its backfill gives every request a new plain token nobody holds,
-- so links this release mailed do not work there and requesters ask for new
-- ones. Coming forward again, 0070 is already recorded and is not run.
--
-- No IF NOT EXISTS, as 0063 (card 2685's code review, S5): a table or an
-- index of these names already in a database would be one this file did not
-- make, and the file fails rather than record itself over it.

CREATE TABLE `request_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`request_id` integer NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `task_requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `request_links_token_hash_unique` ON `request_links` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `idx_request_links_request_id` ON `request_links` (`request_id`);
--> statement-breakpoint
UPDATE `task_requests` SET `access_token` = NULL;
