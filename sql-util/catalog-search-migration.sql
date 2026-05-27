BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_products_search_title_trgm
  ON products USING gin (lower(COALESCE(search_title, title)) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_title_trgm
  ON products USING gin (lower(title) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_tags_name_trgm
  ON tags USING gin (lower(name) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_tags_slug_trgm
  ON tags USING gin (lower(slug) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_catalog_browse
  ON products (status, is_visible, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_products_catalog_price
  ON products (status, is_visible, base_price_cents, id);

CREATE INDEX IF NOT EXISTS idx_products_catalog_lead_time
  ON products (status, is_visible, lead_time_days_max, id);

COMMIT;
