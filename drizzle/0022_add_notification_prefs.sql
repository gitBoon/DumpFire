-- User email notification preferences (JSON object)
ALTER TABLE users ADD COLUMN notification_prefs TEXT DEFAULT '{}';
