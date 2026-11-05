ALTER TABLE categories ADD COLUMN parent_id INTEGER;
ALTER TABLE bills ADD COLUMN subcategory_id INTEGER;

DROP INDEX IF EXISTS idx_categories_name_type;
CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_unique ON categories(type, COALESCE(parent_id, 0), name);
CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_bills_subcategory ON bills(subcategory_id);

INSERT OR IGNORE INTO categories (name, type, emoji, hidden, sort, parent_id)
SELECT '团购', 1, '🛒', 0, 0, id
FROM categories
WHERE type = 1 AND name = '购物' AND parent_id IS NULL;