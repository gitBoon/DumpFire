-- Decision records: the people directory, the decisions and their record,
-- and a Product Owner on each board (card 2673, milestone 35, 2026-11-03).
--
-- The whole data model of the decision records feature, in one file, as the
-- design ruled (docs/planning/card-2625-decision-records.md, section 4.3, with
-- its review in section 6; this card's plan is
-- docs/planning/card-2673-decision-model.md):
--
-- - people, people_groups and people_group_members: the directory of who can
--   be consulted or informed, with or without an account. people.user_id
--   links a person to an account, one each.
-- - boards.product_owner_user_id: the board's Product Owner, the default
--   decider. NULL until somebody sets it.
-- - decisions: one row each, with its board, author, decider and status.
-- - decision_options, decision_versions and decision_participants: what was
--   asked, each published version of it, and who was asked, as they were when
--   they were included.
-- - decision_responses, decision_questions, decision_rulings and
--   decision_events: the record. The application only inserts into them.
-- - decision_card_links: the cards a decision is about.
--
-- Why each key does what it does:
--
-- - Every reference to users is ON DELETE SET NULL, with the name kept beside
--   it, so the record never depends on an account still being there.
-- - decisions.board_id is SET NULL: a decision outlives its board, and keeps
--   the board's name in board_name. supersedes_id and replaces_id are SET NULL
--   on their own tables.
-- - decision_participants.person_id is SET NULL: the participant keeps the
--   name, email, job title and groups it was included with. Its user_id is a
--   snapshot of people.user_id at inclusion, never made to follow the person;
--   its key to users only empties it when that account is deleted.
-- - Every table under a decision CASCADEs from it, and the two link tables
--   CASCADE from both ends, so deleting a draft or withdrawn decision, or a
--   card, removes what hangs from it and nothing else.
-- - The six references from the record to participants and options are NO
--   ACTION: responses to both, questions and events to participants, and
--   rulings to options. The database refuses to delete a participant or an
--   option the record mentions, rather than quietly orphaning a response or
--   turning a ruling for option A into a ruling for none of them. After a
--   decision opens, participants are only marked removed and options only
--   retired, so normal use never meets the refusal. NO ACTION is checked at
--   the end of the statement, after every cascade, so deleting the whole
--   decision still works.
--
-- Status, kind, role, via and source columns are free text checked in code,
-- not a CHECK, and there are no triggers: the start-up model check sees
-- neither, and boards, one of the tables the runner rebuilds from the model,
-- refuses a CHECK. Every foreign key column leads an index, card 2106's rule,
-- named idx_<table>_<column> (the two drizzle .unique() indexes keep drizzle's
-- names) and declared in src/lib/server/db/schema.ts under the same name; IF
-- NOT EXISTS, as every index migration since 0040.
--
-- Changes no row and backfills nothing: the twelve tables start empty, and
-- every board's Product Owner is NULL. So nothing is declared to the
-- rehearsal in tests/rehearsal/one-offs.ts.
--
-- What people see: nothing yet, apart from productOwnerUserId, null, in every
-- board answer. Later cards of the milestone write the tables.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and it would not survive a second run: "already exists" and "duplicate
-- column" are tolerated only in a fixed list of older files, and this is not
-- one of them. A backup made before this file restores with the twelve tables
-- empty and every board's Product Owner NULL.
--
-- Going back to an older image keeps these tables, the column and their rows:
-- the older build runs no migration that drops them, its model check reports
-- them at every start as differences it does not act on, and its rebuild
-- leaves boards alone, because a column on one side only is never rebuilt
-- away. The older build neither reads nor writes any of it, so nothing is lost
-- and nothing is maintained meanwhile. Going forward again, 0061 is already
-- recorded and is not run, and everything is where it was left.

CREATE TABLE `people_groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `people_groups_name_unique` ON `people_groups` (`name`);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`email` text NOT NULL,
	`job_title` text DEFAULT '' NOT NULL,
	`user_id` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`left_at` text,
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `people_email_unique` ON `people` (`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_people_user_id` ON `people` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_people_created_by` ON `people` (`created_by`);
--> statement-breakpoint
CREATE TABLE `people_group_members` (
	`group_id` integer NOT NULL,
	`person_id` integer NOT NULL,
	PRIMARY KEY(`group_id`, `person_id`),
	FOREIGN KEY (`group_id`) REFERENCES `people_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_people_group_members_person_id` ON `people_group_members` (`person_id`);
--> statement-breakpoint
ALTER TABLE `boards` ADD COLUMN `product_owner_user_id` integer REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_boards_product_owner_user_id` ON `boards` (`product_owner_user_id`);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`board_id` integer,
	`board_name` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`vote_mode` text DEFAULT 'single' NOT NULL,
	`working_content` text DEFAULT '{}' NOT NULL,
	`current_version` integer DEFAULT 0 NOT NULL,
	`author_user_id` integer,
	`author_name` text NOT NULL,
	`decider_user_id` integer,
	`decider_name` text,
	`closes_at` text,
	`opened_at` text,
	`closed_at` text,
	`ruled_at` text,
	`withdrawn_at` text,
	`withdrawn_reason` text,
	`supersedes_id` integer,
	`results_released_at` text,
	`results_released_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decider_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`supersedes_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`results_released_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decisions_board_id` ON `decisions` (`board_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decisions_author_user_id` ON `decisions` (`author_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decisions_decider_user_id` ON `decisions` (`decider_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decisions_supersedes_id` ON `decisions` (`supersedes_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decisions_results_released_by` ON `decisions` (`results_released_by`);
--> statement-breakpoint
CREATE TABLE `decision_options` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`label` text NOT NULL,
	`position` real NOT NULL,
	`added_in_version` integer,
	`retired_in_version` integer,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_options_decision_id` ON `decision_options` (`decision_id`);
--> statement-breakpoint
CREATE TABLE `decision_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`number` integer NOT NULL,
	`content` text NOT NULL,
	`change_note` text,
	`asks_again` integer NOT NULL,
	`published_by` integer,
	`published_by_name` text NOT NULL,
	`published_at` text NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_decision_versions_decision_id_number` ON `decision_versions` (`decision_id`,`number`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_versions_published_by` ON `decision_versions` (`published_by`);
--> statement-breakpoint
CREATE TABLE `decision_participants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`person_id` integer,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`job_title` text NOT NULL,
	`groups` text NOT NULL,
	`included_at` text NOT NULL,
	`included_by` integer,
	`included_by_name` text,
	`removed_at` text,
	`removed_by` integer,
	`user_id` integer,
	`link_token_hash` text,
	`link_issued_at` text,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`included_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`removed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_participants_decision_id` ON `decision_participants` (`decision_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_participants_person_id` ON `decision_participants` (`person_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_participants_included_by` ON `decision_participants` (`included_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_participants_removed_by` ON `decision_participants` (`removed_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_participants_user_id` ON `decision_participants` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_decision_participants_link_token_hash` ON `decision_participants` (`link_token_hash`);
--> statement-breakpoint
CREATE TABLE `decision_responses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`participant_id` integer NOT NULL,
	`version_number` integer NOT NULL,
	`round` integer NOT NULL,
	`kind` text NOT NULL,
	`option_id` integer,
	`scores` text,
	`comment` text,
	`option_comments` text,
	`replaces_id` integer,
	`via` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `decision_participants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`option_id`) REFERENCES `decision_options`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replaces_id`) REFERENCES `decision_responses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_responses_decision_id` ON `decision_responses` (`decision_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_responses_participant_id` ON `decision_responses` (`participant_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_responses_option_id` ON `decision_responses` (`option_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_responses_replaces_id` ON `decision_responses` (`replaces_id`);
--> statement-breakpoint
CREATE TABLE `decision_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`participant_id` integer,
	`asker_name` text NOT NULL,
	`question` text NOT NULL,
	`asked_in_version` integer NOT NULL,
	`via` text NOT NULL,
	`asked_at` text NOT NULL,
	`answer` text,
	`answered_by` integer,
	`answered_by_name` text,
	`answered_at` text,
	`answer_agent_drafted` integer DEFAULT false NOT NULL,
	`answer_reviewed_by` integer,
	`answer_reviewed_at` text,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `decision_participants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`answered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`answer_reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_questions_decision_id` ON `decision_questions` (`decision_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_questions_participant_id` ON `decision_questions` (`participant_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_questions_answered_by` ON `decision_questions` (`answered_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_questions_answer_reviewed_by` ON `decision_questions` (`answer_reviewed_by`);
--> statement-breakpoint
CREATE TABLE `decision_rulings` (
	`decision_id` integer PRIMARY KEY NOT NULL,
	`option_id` integer,
	`reason` text NOT NULL,
	`conditions` text,
	`against_responses` integer NOT NULL,
	`early` integer NOT NULL,
	`version_number` integer NOT NULL,
	`ruled_by` integer,
	`ruled_by_name` text NOT NULL,
	`ruled_at` text NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`option_id`) REFERENCES `decision_options`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ruled_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_rulings_option_id` ON `decision_rulings` (`option_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_rulings_ruled_by` ON `decision_rulings` (`ruled_by`);
--> statement-breakpoint
CREATE TABLE `decision_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`decision_id` integer NOT NULL,
	`participant_id` integer,
	`kind` text NOT NULL,
	`version_number` integer,
	`detail` text,
	`actor_user_id` integer,
	`actor_name` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`participant_id`) REFERENCES `decision_participants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_events_decision_id_created_at` ON `decision_events` (`decision_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_events_participant_id` ON `decision_events` (`participant_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_events_actor_user_id` ON `decision_events` (`actor_user_id`);
--> statement-breakpoint
CREATE TABLE `decision_card_links` (
	`decision_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`relation` text DEFAULT 'relates' NOT NULL,
	`created_by` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`decision_id`, `card_id`),
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_card_links_card_id` ON `decision_card_links` (`card_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_decision_card_links_created_by` ON `decision_card_links` (`created_by`);
