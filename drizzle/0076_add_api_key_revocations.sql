-- Every API key ended on this server, by its row id and its SHA-256 (card 2995, 2026-11-19).
--
-- A row says that the key with this `key_id` and this `key_hash` was ended
-- here: revoked, ended with its account's access, deleted with its account,
-- cleared by Reset Everything, or gone before this record existed. `key_hash`
-- is the SHA-256 the gate checks a key by, never the key. Every ender writes
-- its row in the transaction that deletes the key (`endApiKeys`,
-- src/lib/server/key-revocations.ts), and no write deletes, changes or
-- replaces a row.
--
-- No foreign key: a row outlives its key and its account.
--
-- The watermark (key_hash 'watermark'): W, the larger of the api_keys id
-- counter and the largest id held. Admin > Vacuum and Reset deleted the
-- counters before c6ed310, so the counter alone can be below the largest id
-- issued. A seed row (key_hash '') names a key by its id only where that id
-- is at most W.
--
-- The seed, once: every id from 1 to W that api_keys does not hold, its hash
-- not known, 'before record'. Changes no existing row. Nothing is declared in
-- tests/rehearsal/one-offs.ts.
--
-- A restore keeps this table, as it keeps the system log, and adds the
-- backup's rows to it; Reset Everything keeps it. Going back to an older image
-- leaves it unwritten there, and that image's restore clears and refills it
-- from the backup: see docs/deployment.md.
--
-- The guard first (card 2995's code review, FP5): one row per id, never a
-- range, so where W less the keys held is more than 1,000,000 (a counter set
-- far above every key) the file fails on the guard's CHECK, whose name says
-- why, and nothing of it is applied.

CREATE TEMP TABLE `migration_0076_guard` (
	`seed_rows` integer NOT NULL CONSTRAINT `migration 0076 would record more than 1,000,000 API key ids this server no longer holds: the api_keys id counter in sqlite_sequence is far above every key; see docs/deployment.md, card 2995` CHECK (`seed_rows` <= 1000000)
);
--> statement-breakpoint
INSERT INTO temp.`migration_0076_guard` (`seed_rows`)
SELECT max(coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'api_keys'), 0), coalesce((SELECT max(id) FROM api_keys), 0)) - (SELECT count(*) FROM api_keys);
--> statement-breakpoint
DROP TABLE temp.`migration_0076_guard`;
--> statement-breakpoint
CREATE TABLE `api_key_revocations` (
	`key_id` integer NOT NULL,
	`key_hash` text NOT NULL,
	`revoked_at` text NOT NULL,
	`revoked_because` text NOT NULL,
	PRIMARY KEY(`key_hash`, `key_id`)
);
--> statement-breakpoint
INSERT INTO `api_key_revocations` (`key_id`, `key_hash`, `revoked_at`, `revoked_because`)
SELECT max(coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'api_keys'), 0), coalesce((SELECT max(id) FROM api_keys), 0)), 'watermark', datetime('now'), 'before record';
--> statement-breakpoint
INSERT INTO `api_key_revocations` (`key_id`, `key_hash`, `revoked_at`, `revoked_because`)
WITH RECURSIVE ids(id) AS (
	SELECT 1 WHERE (SELECT key_id FROM api_key_revocations WHERE key_hash = 'watermark') >= 1
	UNION ALL
	SELECT id + 1 FROM ids WHERE id < (SELECT key_id FROM api_key_revocations WHERE key_hash = 'watermark')
)
SELECT id, '', datetime('now'), 'before record' FROM ids WHERE id NOT IN (SELECT id FROM api_keys);
