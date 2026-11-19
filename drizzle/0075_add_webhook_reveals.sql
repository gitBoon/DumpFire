-- Which API key was given which webhook's signing secret (card 2947, 2026-11-19).
--
-- A webhook's secret leaves the server only in an answer to an API key under
-- /api/v1 (the two GETs, and the PUT or POST that set or replaced it). Each
-- such answer writes a row here, in the transaction that gives the secret
-- (`answerWebhook`, src/lib/server/webhooks.ts): this key was given this
-- webhook's secret as it is now. `revealed_at` is the first time since the
-- secret last changed; NULL marks a row the once-only seed wrote for a key
-- used before reads were recorded. A PUT that writes a new secret deletes the
-- webhook's rows. Revoking a key, or its expiry or deadline (a sweep at every
-- start and every five minutes), holds every webhook it was given the secret
-- of as 'setter access ended', so that switching it on gives it a new secret;
-- ending an account's access holds those of all its keys.
--
-- Both foreign keys cascade: a row goes with its key and with its webhook.
--
-- Changes no row. Nothing is declared in tests/rehearsal/one-offs.ts.
--
-- A backup made before this file has no rows: a restore carries this
-- server's over it, for the webhooks whose secret it fills from here
-- (db/restore.ts), and the seed runs.
--
-- Going back to an older image leaves the table unread and unwritten: a
-- revoke or an expiry there holds nothing its key was given, and reveals made
-- there are not recorded. See docs/deployment.md.

CREATE TABLE `webhook_reveals` (
	`webhook_id` integer NOT NULL,
	`key_id` integer NOT NULL,
	`revealed_at` text,
	PRIMARY KEY(`webhook_id`, `key_id`),
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`key_id`) REFERENCES `api_keys`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_webhook_reveals_key_id` ON `webhook_reveals` (`key_id`);
