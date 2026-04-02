-- Add public board toggle
ALTER TABLE boards ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
