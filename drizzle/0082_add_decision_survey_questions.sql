-- A decision's survey questions, and the answers given with a response (card 2683, 2026-11-21).
--
-- An author may add questions of their own to a decision: pick one of these
-- choices, a whole number on a scale, or a short written answer. A decision
-- may hold questions and no options at all, a survey, worked out and never
-- stored (docs/planning/card-2683-decision-survey-questions.md, R4).
--
-- decision_survey_questions is the shape of decision_options without a label:
-- a question's id, its decision, its place, and the versions that first
-- published and retired it. Its words (its kind, prompt, help, whether it must
-- be answered, its choices or its scale) live in the working content and in
-- each version's content under `surveyQuestions`, keyed by `questionId`, as an
-- option's words do. Ids are AUTOINCREMENT and never reused, so an answer
-- keyed by a question's id means one question for ever. ON DELETE CASCADE
-- from its decision, as every table under a decision; nothing refers to it by
-- a foreign key. The index is card 2106's rule, that every foreign key column
-- leads an index, named idx_<table>_<column> and declared in
-- src/lib/server/db/schema.ts under the same name.
--
-- decision_responses.answers holds the answers given with that response, as
-- JSON keyed by survey question id (a choice's 0-based index, a scale's whole
-- number, a written answer's text); NULL for none. The table is insert-only
-- in code, so a response carries its own answers, as it carries its scores
-- and option comments. No foreign key: the ids are inside the JSON.
--
-- What people see: nothing until a decision asks a question. Changes no row:
-- every response already stored has NULL answers, and the new table is empty,
-- so nothing is declared in tests/rehearsal/one-offs.ts. Neither is one of the
-- tables the runner rebuilds from the model (RECONCILED_TABLES in
-- src/lib/server/db/migrate.ts), so this file alone makes them.
--
-- No IF NOT EXISTS, as 0063: a table, an index or a column of these names
-- already in a database would be one this file did not make, and the file
-- fails rather than record itself over it.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "duplicate column" is tolerated only
-- in a fixed list of older files, and this is not one of them.
--
-- A backup made before this file has neither: the restore copies the columns
-- both sides have, so its responses come in with NULL answers, and it holds
-- no survey question.
--
-- Going back to an older image keeps both: that image's model check reports
-- the table and the column at every start and does not act on them, and it
-- reads neither. Before going back to 332634f, settle every decision still
-- taking responses that has never put an option to a vote (rule on it or
-- withdraw it), as the older image cannot show a survey: it accepts a vote
-- with no scores on a decision with no live option, misses an `answered`
-- response (people who answered are reminded and listed as waiting), and drops
-- the survey questions and their agent flags from a working copy at its next
-- save. Never drop the table or empty the column: nothing needs dumping, and
-- going forward again uses them. Going forward again, 0082 is already
-- recorded and is not run.

CREATE TABLE `decision_survey_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`position` real NOT NULL,
	`added_in_version` integer,
	`retired_in_version` integer,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_decision_survey_questions_decision_id` ON `decision_survey_questions` (`decision_id`);
--> statement-breakpoint
ALTER TABLE `decision_responses` ADD `answers` text;
