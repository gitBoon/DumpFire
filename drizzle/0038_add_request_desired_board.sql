ALTER TABLE task_requests ADD COLUMN desired_board_id INTEGER REFERENCES boards(id) ON DELETE SET NULL;
