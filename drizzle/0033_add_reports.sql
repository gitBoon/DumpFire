-- Report schedules table
CREATE TABLE IF NOT EXISTS report_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'board',  -- 'board' | 'category' | 'all'
  scope_id INTEGER,                     -- boardId or categoryId, NULL for 'all'
  frequency TEXT NOT NULL DEFAULT 'weekly',  -- 'weekly' | 'monthly'
  day_of_week INTEGER NOT NULL DEFAULT 1,   -- 0-6 (Sunday-Saturday), used for weekly
  day_of_month INTEGER NOT NULL DEFAULT 1,  -- 1-28, used for monthly
  time_of_day TEXT NOT NULL DEFAULT '09:00', -- HH:MM (24h format)
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generated reports table
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id INTEGER REFERENCES report_schedules(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'board',
  scope_id INTEGER,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
