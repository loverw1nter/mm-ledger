-- Multi-account support. Existing data belongs to user 1 ("main").
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO users (id, username, password_hash, salt, role)
VALUES (1, 'main', '', '', 'admin');

ALTER TABLE bills ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE categories ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE savings ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;

DROP INDEX IF EXISTS idx_categories_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique
  ON categories(user_id, type, COALESCE(parent_id, 0), name);
CREATE INDEX IF NOT EXISTS idx_categories_user_parent
  ON categories(user_id, parent_id);

DROP INDEX IF EXISTS idx_bills_external;
CREATE UNIQUE INDEX IF NOT EXISTS idx_bills_external
  ON bills(user_id, external_id) WHERE external_id IS NOT NULL;
DROP INDEX IF EXISTS idx_bills_date;
DROP INDEX IF EXISTS idx_bills_category;
DROP INDEX IF EXISTS idx_bills_subcategory;
CREATE INDEX IF NOT EXISTS idx_bills_user_date ON bills(user_id, date);
CREATE INDEX IF NOT EXISTS idx_bills_user_category ON bills(user_id, category_id);
CREATE INDEX IF NOT EXISTS idx_bills_user_subcategory ON bills(user_id, subcategory_id);

DROP INDEX IF EXISTS idx_savings_date;
CREATE INDEX IF NOT EXISTS idx_savings_user_date ON savings(user_id, date);

CREATE TABLE app_settings_v2 (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
INSERT INTO app_settings_v2 (user_id, key, value)
  SELECT 1, key, value FROM app_settings;
DROP TABLE app_settings;
ALTER TABLE app_settings_v2 RENAME TO app_settings;
INSERT OR IGNORE INTO app_settings (user_id, key, value)
  VALUES (1, 'savings_goal_cents', '0');

CREATE TABLE fanzhuo_state_v2 (
  user_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO fanzhuo_state_v2 (user_id, data, updated_at)
  SELECT 1, data, updated_at FROM fanzhuo_state WHERE id = 1;
DROP TABLE fanzhuo_state;
ALTER TABLE fanzhuo_state_v2 RENAME TO fanzhuo_state;
