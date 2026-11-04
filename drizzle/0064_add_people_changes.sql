-- Every change to the people directory and its groups, kept for good (card 2681, 2026-11-04).
--
-- people_changes holds one row for each change to a person or a group, made on
-- the People page or through an administrator's API key: who made it and how
-- (`source`, 'ui' or 'api'), what it was about (`subject`, 'person' or 'group',
-- and `subject_id`), what kind of change it was (`kind`: created, updated,
-- deleted or members_set), and what the changed fields held before and after,
-- as JSON (src/lib/server/people.ts, `recordChange`). It is the record an
-- administrator puts a change back from: a key that replaced a group's members
-- or a person's groups leaves the set it replaced here.
--
-- Why a table and not the system log alone (the code review's S1): the PEOPLE
-- line of the system log says the same, but the log is pruned, by age and by
-- count (src/lib/server/logger.ts), so a change made through a stolen key
-- could outlive the only record of what it replaced. This table is never
-- pruned and the application only inserts into it; nothing updates or deletes
-- a row (tests/decision-record.test.ts reads the source for that rule, as it
-- does for the decision record). The PEOPLE line is still written beside it.
--
-- `before` and `after` hold names, job titles, descriptions, statuses and the
-- ids of groups or people: never an email address and never an account id. A
-- change of address or account says only that it changed. `subject_id` is a
-- plain integer with no foreign key, so a person's or a group's delete leaves
-- its rows, the delete's own among them. `actor_user_id` references users ON
-- DELETE SET NULL, with `actor_name` kept beside it, as every reference from
-- the decision record to users is (0061), so the row never depends on an
-- account still being there. Its index leads with the key, card 2106's rule;
-- the second index finds a person's or a group's changes. No IF NOT EXISTS,
-- as 0063 (card 2685's code review, S5): a table or index of these names
-- already in a database would be one this file did not make.
--
-- people_changes is new, so it is not one of the tables the runner rebuilds
-- from the model (RECONCILED_TABLES in src/lib/server/db/migrate.ts): this
-- file alone makes it.
--
-- Changes no row and backfills nothing: the table starts empty, and changes
-- made before this file are in the system log alone. So nothing is declared to
-- the rehearsal in tests/rehearsal/one-offs.ts.
--
-- What people see: nothing. Administrators read the rows from a backup or the
-- database itself until a later card shows them.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "already exists" is tolerated only in
-- a fixed list of older files, and this is not one of them.
-- A backup made before this file restores with the table empty.
--
-- Going back to an older image keeps the table and its rows: the older build
-- runs no migration that drops it, its model check reports "people_changes:
-- the table is not in the model" at every start and does not act on it, and
-- it neither reads nor writes it, so changes made meanwhile are in the system
-- log alone. Going forward again, 0064 is already recorded and is not run, and
-- the rows are where they were left.

CREATE TABLE `people_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`actor_user_id` integer,
	`actor_name` text NOT NULL,
	`source` text NOT NULL,
	`subject` text NOT NULL,
	`subject_id` integer NOT NULL,
	`kind` text NOT NULL,
	`before` text,
	`after` text,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_people_changes_actor_user_id` ON `people_changes` (`actor_user_id`);
--> statement-breakpoint
CREATE INDEX `idx_people_changes_subject_subject_id` ON `people_changes` (`subject`,`subject_id`);
