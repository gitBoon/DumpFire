-- Add next_recurrence to cards
ALTER TABLE cards ADD COLUMN next_recurrence TEXT;
-->statement-breakpoint
-- Create webhooks table
CREATE TABLE IF NOT EXISTS webhooks (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	secret TEXT NOT NULL DEFAULT '',
	events TEXT NOT NULL DEFAULT '[]',
	active INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- REMOVED 2026-09-11: a legacy card_dependencies conversion that destroyed data
-- on every restart of any database created from scratch.
--
-- This migration used to rebuild card_dependencies from the pre-0029 column
-- names (blocker_card_id / blocked_card_id) into the modern shape, via
-- INSERT ... SELECT into a _v2 table, then DROP the original and RENAME.
--
-- On a fresh database that sequence is not merely unnecessary, it is harmful.
-- Migration 0005 already creates card_dependencies with the modern shape, so:
--
--   1. the INSERT ... SELECT fails with "no such column: blocked_card_id";
--   2. the runner does not tolerate that error, so this migration is never
--      recorded as applied and is retried on every single boot;
--   3. the DROP and RENAME that follow it in the same file DO run, because the
--      runner continues past a failed statement — so each boot dropped the real
--      card_dependencies table and renamed an empty _v2 over the top of it.
--
-- Nothing read card_dependencies until the critical-path planning work, so the
-- table was always empty and the wipe was invisible. Verified by running every
-- migration against an empty database, recording two dependencies, and running
-- the migrations again: both rows were gone.
--
-- Removing the conversion is safe in every direction:
--   - Databases that genuinely had the legacy shape have already run and
--     recorded this migration, so editing the file cannot re-run it there.
--   - Databases that have not recorded it are, by the ordering above,
--     necessarily fresh ones that already have the modern shape from 0005 and
--     have nothing to convert.
--
-- The migration now completes cleanly, records itself, and stops running.
-- ─────────────────────────────────────────────────────────────────────────────
