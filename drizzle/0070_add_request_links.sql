-- Where a requester's links are kept, only as hashes (card 2870, 2026-11-17;
-- its end of every link held in plain taken out by card 3064, 2026-11-24).
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
-- As written for card 2870 this file also set every access_token to NULL,
-- ending every link mailed before the deploy. Card 3064, the compatibility
-- release, took that statement out before the file ever ran on live: it ran
-- before 0084, and so would have ended, on live, the links 0084 keeps. 0084
-- moves each token into request_links as its hash, with a SHA-256 the
-- migration runner provides, and then empties the column; the start's scrub
-- takes the plain token out of the file's free pages and its WAL before the
-- server listens. A database that ran this file in its earlier form lost
-- those links then. This file changes no row.
--
-- What people see: nothing. A requester link mailed before the deploy works
-- as it did (0084). Requests and their messages are untouched.
--
-- Declares nothing to the rehearsal: it makes a table and two indexes, and
-- takes or rewrites no row.
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
