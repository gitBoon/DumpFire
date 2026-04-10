-- Add email recipients to report_schedules and drop stored reports table
ALTER TABLE report_schedules ADD COLUMN recipients TEXT NOT NULL DEFAULT '';
-->statement-breakpoint
DROP TABLE IF EXISTS reports;
