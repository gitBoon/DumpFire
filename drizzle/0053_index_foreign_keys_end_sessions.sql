-- An index on every foreign key column, and every session ended once (card 2106, 2026-10-15).
--
-- Part 1: the indexes. 39 foreign key columns were the first column of no
-- index. Deleting a row makes SQLite look up every row that refers to it, in
-- every child table, and with no index each look-up reads the whole child
-- table. Deleting a board of 2,000 cards was measured at 9.4 s with the
-- indexes the model had, holding the write lock throughout, and at 48 ms with
-- these. The same columns are read whenever a board or a card is opened.
--
-- One index per column, named idx_<table>_<column>, each declared in
-- src/lib/server/db/schema.ts under the same name. IF NOT EXISTS, as every
-- index migration since 0040: a database altered with `drizzle-kit push`
-- already has them. One statement to a block, so that a failure names its
-- index.
--
-- Part 2, a one-off change to data: every session is deleted, the last
-- statement of the file. Backups made before card 2135 hold the session id of
-- everybody signed in when they were made, some of them already copied to
-- destinations outside this server, and a session that goes on being used
-- never expires. Ending every session once makes those ids worthless.
--
-- What people see: everybody is signed out once, on the start that applies
-- this file, and signs in again. API keys, invites and requesters' links are
-- untouched. It must not be deployed before card 2135, which takes sessions
-- out of backups; otherwise sessions made in between leave in the next backup.
--
-- Harmless where it finds nothing: a new database has no sessions. It is
-- declared to the rehearsal in tests/rehearsal/one-offs.ts, which then expects
-- `sessions` to lose its rows.
--
-- Runs once. The runner records this file by name and never runs it again,
-- and nothing repeats the delete at start-up or after a restore: a restore
-- already brings in no session.

-- Children of cards.
CREATE INDEX IF NOT EXISTS `idx_subtasks_card_id` ON `subtasks` (`card_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_comments_card_id` ON `card_comments` (`card_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_attachments_card_id` ON `card_attachments` (`card_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_labels_card_id` ON `card_labels` (`card_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_boards_parent_card_id` ON `boards` (`parent_card_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_requests_resolved_card_id` ON `task_requests` (`resolved_card_id`);
--> statement-breakpoint
-- Children of columns.
CREATE INDEX IF NOT EXISTS `idx_cards_column_id` ON `cards` (`column_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_daily_snapshots_column_id` ON `daily_snapshots` (`column_id`);
--> statement-breakpoint
-- Children of boards.
CREATE INDEX IF NOT EXISTS `idx_columns_board_id` ON `columns` (`board_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_board_favourites_board_id` ON `board_favourites` (`board_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_templates_board_id` ON `card_templates` (`board_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_categories_board_id` ON `categories` (`board_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_labels_board_id` ON `labels` (`board_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_milestones_board_id` ON `milestones` (`board_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_requests_desired_board_id` ON `task_requests` (`desired_board_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_webhooks_board_id` ON `webhooks` (`board_id`);
--> statement-breakpoint
-- Children of users.
CREATE INDEX IF NOT EXISTS `idx_activity_log_user_id` ON `activity_log` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_api_keys_user_id` ON `api_keys` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_board_members_user_id` ON `board_members` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_boards_created_by` ON `boards` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_assignees_user_id` ON `card_assignees` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_attachments_uploaded_by` ON `card_attachments` (`uploaded_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_comments_user_id` ON `card_comments` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_dependencies_created_by_user_id` ON `card_dependencies` (`created_by_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_templates_created_by` ON `card_templates` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cards_created_by` ON `cards` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_invite_tokens_user_id` ON `invite_tokens` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_milestones_created_by` ON `milestones` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_report_schedules_user_id` ON `report_schedules` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_user_id` ON `sessions` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_requests_requester_user_id` ON `task_requests` (`requester_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_requests_resolved_by` ON `task_requests` (`resolved_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_team_members_user_id` ON `team_members` (`user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_token_usage_reported_by_user_id` ON `token_usage` (`reported_by_user_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_work_dependencies_created_by_user_id` ON `work_dependencies` (`created_by_user_id`);
--> statement-breakpoint
-- Children of teams, labels, categories and task_requests.
CREATE INDEX IF NOT EXISTS `idx_board_teams_team_id` ON `board_teams` (`team_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_card_labels_label_id` ON `card_labels` (`label_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cards_category_id` ON `cards` (`category_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_request_messages_request_id` ON `request_messages` (`request_id`);
--> statement-breakpoint
-- The one-off (part 2 above): every session ends, once.
DELETE FROM `sessions`;
