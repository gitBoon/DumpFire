-- Where two-step sign-in keeps its second factors (card 2768, 2026-11-05).
--
-- mfa_factors holds each account's authenticators: the app's secret only as
-- AES-256-GCM ciphertext (`secret_ciphertext`, with its tag) and the nonce it
-- was sealed with, under a key that is kept in a file outside the database
-- and outside every backup (MFA_KEY_FILE, src/lib/server/mfa-key.ts); never
-- the secret itself and never the key. `key_id` names the key that sealed it,
-- `factor_uid` is bound into the sealing with the account's id, and
-- `last_step` is the last time step spent, so no code is taken twice.
-- mfa_recovery_codes holds each account's ten single-use recovery codes, each
-- only as the SHA-256 hash of the code bound to the account's id, never the
-- code. This card writes both (src/lib/server/mfa-store.ts); card 2769 is the
-- first to call it, when an account sets up two-step sign-in.
--
-- sign_in_challenges holds a sign-in waiting for its second factor, and
-- enrolment_links a link that lets one account set up its authenticator:
-- both only as the SHA-256 hash of the token sent. Card 2769 issues and takes
-- them; this card ends them on a password set and on an email or role
-- change, and leaves them out of every backup and every restore.
--
-- users gains eleven columns: the consecutive wrong codes and the pause of
-- each lane (the remembered browser's, every other, and recovery codes), the
-- last sign-in and where it came from, the wrong codes since it, and the
-- banner that tells the owner someone else holds the password, with when it
-- was last raised. Every moment is a `*_at` column, so the conversion at every
-- start finds it (src/lib/server/db/schema.ts). users is not one of the tables
-- the runner rebuilds from the model (RECONCILED_TABLES in
-- src/lib/server/db/migrate.ts), so this file alone changes it; the four
-- tables are new, so this file alone makes them. Every key to users is ON
-- DELETE CASCADE, and each leads an index, card 2106's rule.
--
-- No IF NOT EXISTS, as 0063 (card 2685's code review, S5): a table or an
-- index of these names already in a database would be one this file did not
-- make, and the file fails rather than record itself over it.
--
-- Changes no value a row held: the tables start empty, and ADD COLUMN with a
-- constant default gives every account its counters at 0 and the rest NULL,
-- which is what an account that has never used a second factor has. So
-- nothing is declared to the rehearsal in tests/rehearsal/one-offs.ts.
--
-- What people see: nothing. No account has a second factor until card 2769
-- lets one be set up.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "already exists" and "duplicate
-- column" are tolerated only in a fixed list of older files, and this is not
-- one of them.
--
-- A backup made before this file holds no MFA table and restores as any
-- other: an account that is still here keeps this server's second factors and
-- recovery codes, and one that is not has none and is named by the restore
-- once two-step sign-in is in use.
--
-- Going back to an older image keeps the tables and the columns: the older
-- build runs no migration that drops them, its model check reports them at
-- every start and does not act on them, its backups carry the challenge and
-- link rows, and its restore copies the MFA tables as any other table, so a
-- restore made on the older image ignores this card's rules. Going forward
-- again, 0065 is already recorded and is not run.

CREATE TABLE `enrolment_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`issued_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mfa_factors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`factor_uid` text NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`key_id` text NOT NULL,
	`secret_ciphertext` text NOT NULL,
	`secret_nonce` text NOT NULL,
	`last_step` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_used_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mfa_recovery_codes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sign_in_challenges` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`short_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`purpose` text NOT NULL,
	`stage` text,
	`lane` text NOT NULL,
	`password_hash` text NOT NULL,
	`key_id` text,
	`enrol_ciphertext` text,
	`enrol_nonce` text,
	`remembered_nonce` text,
	`wrong_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mfa_factors_factor_uid_unique` ON `mfa_factors` (`factor_uid`);
--> statement-breakpoint
CREATE UNIQUE INDEX `mfa_recovery_codes_code_hash_unique` ON `mfa_recovery_codes` (`code_hash`);
--> statement-breakpoint
CREATE INDEX `idx_enrolment_links_user_id` ON `enrolment_links` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_mfa_factors_user_id` ON `mfa_factors` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_mfa_recovery_codes_user_id` ON `mfa_recovery_codes` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_sign_in_challenges_user_id` ON `sign_in_challenges` (`user_id`);
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `mfa_known_wrong` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `mfa_other_wrong` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `mfa_known_resumes_at` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `mfa_other_resumes_at` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `mfa_recovery_wrong` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `mfa_recovery_resumes_at` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `last_sign_in_at` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `last_sign_in_from` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `failed_codes_since_sign_in` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `security_banner` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `security_banner_at` text;
