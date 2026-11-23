-- A participant's objections and requests to talk, and the decider's replies (card 2684, 2026-11-21).
--
-- While a decision is open or waiting for its ruling, anyone included in it
-- may object (a reason required) or ask to talk to the decider (a note
-- optional). The decider answers each objection and records the outcome of
-- each conversation, once (docs/planning/card-2684-decision-objections-and-need-to-talk.md).
--
-- decision_flags holds both, one row each, `kind` `objection` or `talk`: the
-- participant, the reason, the version it was raised under and how (`via`),
-- and the reply, settled once as decision_questions holds a question and its
-- answer. Kind and via are free text checked in code, as the schema's header
-- rules for every decision table. ON DELETE CASCADE from its decision, as
-- every table under a decision; the participant with no ON DELETE action, as
-- the record names one, so a place a flag names is never deleted, only marked
-- removed (src/lib/server/db/decision-place-namers.ts); `replied_by` SET NULL
-- with the name kept beside it, as every reference to `users`. Each foreign
-- key column leads an index, card 2106's rule, named idx_<table>_<column> and
-- declared in src/lib/server/db/schema.ts under the same name.
--
-- What people see: nothing until someone objects or asks to talk. Changes no
-- row: the new table is empty, so nothing is declared in
-- tests/rehearsal/one-offs.ts. It is not one of the tables the runner
-- rebuilds from the model (RECONCILED_TABLES in src/lib/server/db/migrate.ts),
-- so this file alone makes it.
--
-- No IF NOT EXISTS, as 0063 and 0082: a table or an index of these names
-- already in a database would be one this file did not make, and the file
-- fails rather than record itself over it.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: the table is already there.
--
-- A backup made before this file holds no flag: the restore copies the
-- tables both sides have, and the table is left empty.
--
-- Going back to an older image keeps the table: that image's model check
-- reports it at every start and does not act on it, and it reads nothing of
-- it. Before going back to 332634f, have the decider answer every objection
-- on a decision still open or waiting for its ruling, as the older image lets
-- a ruling through with an objection unanswered and shows nobody the flags
-- (the read-only query in section 6 of the card's plan lists the decisions
-- that hold one). Never drop the table: nothing
-- needs dumping, its cascade from decisions still holds there, and going
-- forward again uses it. Going forward again, 0083 is already recorded and is
-- not run.

CREATE TABLE `decision_flags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`participant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`version_number` integer NOT NULL,
	`via` text NOT NULL,
	`raised_at` text NOT NULL,
	`reply` text,
	`replied_by` integer,
	`replied_by_name` text,
	`replied_at` text,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `decision_participants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replied_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_decision_flags_decision_id` ON `decision_flags` (`decision_id`);
--> statement-breakpoint
CREATE INDEX `idx_decision_flags_participant_id` ON `decision_flags` (`participant_id`);
--> statement-breakpoint
CREATE INDEX `idx_decision_flags_replied_by` ON `decision_flags` (`replied_by`);
