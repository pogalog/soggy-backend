BEGIN;

ALTER TABLE cart
  ADD COLUMN IF NOT EXISTS line_id text,
  ADD COLUMN IF NOT EXISTS variant_id text,
  ADD COLUMN IF NOT EXISTS variant_label text,
  ADD COLUMN IF NOT EXISTS option_summary text;

UPDATE cart
SET line_id = CONCAT('cartln_', md5(session_id || ':' || product_id || ':' || COALESCE(last_updated::text, now()::text)))
WHERE line_id IS NULL;

ALTER TABLE cart
  ALTER COLUMN line_id SET NOT NULL;

ALTER TABLE cart DROP CONSTRAINT IF EXISTS cart_pkey;
ALTER TABLE cart ADD CONSTRAINT cart_pkey PRIMARY KEY (line_id);

CREATE INDEX IF NOT EXISTS idx_cart_session_id ON cart(session_id);
CREATE INDEX IF NOT EXISTS idx_cart_last_updated ON cart(last_updated);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_session_simple_product
  ON cart(session_id, product_id)
  WHERE variant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cart_session_variant_product
  ON cart(session_id, product_id, variant_id)
  WHERE variant_id IS NOT NULL;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS line_id text,
  ADD COLUMN IF NOT EXISTS variant_id text,
  ADD COLUMN IF NOT EXISTS variant_label text,
  ADD COLUMN IF NOT EXISTS option_summary text;

UPDATE order_items
SET line_id = COALESCE(line_id, product_id)
WHERE line_id IS NULL;

ALTER TABLE order_items
  ALTER COLUMN line_id SET NOT NULL;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_pkey;
ALTER TABLE order_items ADD CONSTRAINT order_items_pkey PRIMARY KEY (order_id, line_id);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);

COMMIT;
