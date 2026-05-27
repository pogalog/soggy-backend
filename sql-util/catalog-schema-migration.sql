BEGIN;

-- Shared trigger to keep updated_at current on row updates.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Expand products into the hybrid catalog shape while retaining legacy columns
-- used by the current application code.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS slug text,
  ADD COLUMN IF NOT EXISTS subtitle text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS product_kind text,
  ADD COLUMN IF NOT EXISTS availability_mode text,
  ADD COLUMN IF NOT EXISTS base_price_cents integer,
  ADD COLUMN IF NOT EXISTS compare_at_price_cents integer,
  ADD COLUMN IF NOT EXISTS currency text,
  ADD COLUMN IF NOT EXISTS search_title text,
  ADD COLUMN IF NOT EXISTS search_description text,
  ADD COLUMN IF NOT EXISTS is_featured boolean,
  ADD COLUMN IF NOT EXISTS is_visible boolean,
  ADD COLUMN IF NOT EXISTS inventory_tracking_mode text,
  ADD COLUMN IF NOT EXISTS inventory_qty integer,
  ADD COLUMN IF NOT EXISTS weight_oz numeric(10,2),
  ADD COLUMN IF NOT EXISTS length_in numeric(10,2),
  ADD COLUMN IF NOT EXISTS width_in numeric(10,2),
  ADD COLUMN IF NOT EXISTS height_in numeric(10,2),
  ADD COLUMN IF NOT EXISTS lead_time_days_min numeric(8,2),
  ADD COLUMN IF NOT EXISTS lead_time_days_max numeric(8,2),
  ADD COLUMN IF NOT EXISTS stripe_product_id text,
  ADD COLUMN IF NOT EXISTS stripe_tax_code text;

UPDATE products
SET
  description = COALESCE(description, ''),
  slug = COALESCE(NULLIF(btrim(slug), ''), slug),
  status = COALESCE(NULLIF(status, ''), 'active'),
  product_kind = COALESCE(NULLIF(product_kind, ''), 'repeatable'),
  availability_mode = COALESCE(
    NULLIF(availability_mode, ''),
    CASE
      WHEN COALESCE(days_to_create, 0) > 0 THEN 'made_to_order'
      ELSE 'ready_to_ship'
    END
  ),
  base_price_cents = COALESCE(base_price_cents, sell_price_cents),
  currency = COALESCE(NULLIF(currency, ''), 'USD'),
  search_title = COALESCE(NULLIF(search_title, ''), title),
  search_description = COALESCE(search_description, COALESCE(description, '')),
  is_featured = COALESCE(is_featured, false),
  is_visible = COALESCE(is_visible, true),
  inventory_tracking_mode = COALESCE(NULLIF(inventory_tracking_mode, ''), 'none'),
  lead_time_days_min = COALESCE(lead_time_days_min, days_to_create),
  lead_time_days_max = COALESCE(lead_time_days_max, days_to_create),
  weight_oz = COALESCE(
    weight_oz,
    CASE
      WHEN shipping_weight_lbs IS NOT NULL THEN ROUND((shipping_weight_lbs * 16.0)::numeric, 2)
      ELSE NULL
    END
  ),
  length_in = COALESCE(length_in, shipping_length_in),
  width_in = COALESCE(width_in, shipping_width_in),
  height_in = COALESCE(height_in, shipping_height_in);

WITH slug_source AS (
  SELECT
    id,
    COALESCE(
      NULLIF(
        trim(
          both '-'
          FROM regexp_replace(lower(COALESCE(NULLIF(title, ''), id)), '[^a-z0-9]+', '-', 'g')
        ),
        ''
      ),
      'product'
    ) AS slug_base
  FROM products
),
slug_ranked AS (
  SELECT
    id,
    CASE
      WHEN row_number() OVER (PARTITION BY slug_base ORDER BY id) = 1
        THEN slug_base
      ELSE slug_base || '-' || row_number() OVER (PARTITION BY slug_base ORDER BY id)
    END AS final_slug
  FROM slug_source
)
UPDATE products p
SET slug = s.final_slug
FROM slug_ranked s
WHERE p.id = s.id
  AND (p.slug IS NULL OR btrim(p.slug) = '');

ALTER TABLE products
  ALTER COLUMN slug SET NOT NULL,
  ALTER COLUMN description SET NOT NULL,
  ALTER COLUMN status SET DEFAULT 'active',
  ALTER COLUMN status SET NOT NULL,
  ALTER COLUMN product_kind SET DEFAULT 'repeatable',
  ALTER COLUMN product_kind SET NOT NULL,
  ALTER COLUMN availability_mode SET DEFAULT 'made_to_order',
  ALTER COLUMN availability_mode SET NOT NULL,
  ALTER COLUMN base_price_cents SET NOT NULL,
  ALTER COLUMN currency SET DEFAULT 'USD',
  ALTER COLUMN currency SET NOT NULL,
  ALTER COLUMN is_featured SET DEFAULT false,
  ALTER COLUMN is_featured SET NOT NULL,
  ALTER COLUMN is_visible SET DEFAULT true,
  ALTER COLUMN is_visible SET NOT NULL,
  ALTER COLUMN inventory_tracking_mode SET DEFAULT 'none',
  ALTER COLUMN inventory_tracking_mode SET NOT NULL;

DROP INDEX IF EXISTS products_slug_key;
CREATE UNIQUE INDEX products_slug_key ON products (slug);

CREATE INDEX IF NOT EXISTS idx_products_status_visible
  ON products (status, is_visible);

CREATE INDEX IF NOT EXISTS idx_products_product_kind
  ON products (product_kind);

CREATE INDEX IF NOT EXISTS idx_products_availability_mode
  ON products (availability_mode);

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_stripe_product_id_unique
  ON products (stripe_product_id)
  WHERE stripe_product_id IS NOT NULL;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE products ADD CONSTRAINT products_status_check
  CHECK (status IN ('draft', 'active', 'archived', 'sold_out'));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_kind_check;
ALTER TABLE products ADD CONSTRAINT products_product_kind_check
  CHECK (product_kind IN ('one_of_a_kind', 'repeatable', 'made_to_order', 'commission_template'));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_availability_mode_check;
ALTER TABLE products ADD CONSTRAINT products_availability_mode_check
  CHECK (availability_mode IN ('ready_to_ship', 'made_to_order', 'preorder', 'market_only'));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_base_price_cents_check;
ALTER TABLE products ADD CONSTRAINT products_base_price_cents_check
  CHECK (base_price_cents >= 0);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_compare_at_price_cents_check;
ALTER TABLE products ADD CONSTRAINT products_compare_at_price_cents_check
  CHECK (compare_at_price_cents IS NULL OR compare_at_price_cents >= base_price_cents);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_inventory_tracking_mode_check;
ALTER TABLE products ADD CONSTRAINT products_inventory_tracking_mode_check
  CHECK (inventory_tracking_mode IN ('none', 'per_product', 'per_variant'));

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_inventory_qty_check;
ALTER TABLE products ADD CONSTRAINT products_inventory_qty_check
  CHECK (inventory_qty IS NULL OR inventory_qty >= 0);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_inventory_qty_required_check;
ALTER TABLE products ADD CONSTRAINT products_inventory_qty_required_check
  CHECK (inventory_tracking_mode <> 'per_product' OR inventory_qty IS NOT NULL);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_weight_oz_check;
ALTER TABLE products ADD CONSTRAINT products_weight_oz_check
  CHECK (weight_oz IS NULL OR weight_oz > 0);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_length_in_check;
ALTER TABLE products ADD CONSTRAINT products_length_in_check
  CHECK (length_in IS NULL OR length_in > 0);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_width_in_check;
ALTER TABLE products ADD CONSTRAINT products_width_in_check
  CHECK (width_in IS NULL OR width_in > 0);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_height_in_check;
ALTER TABLE products ADD CONSTRAINT products_height_in_check
  CHECK (height_in IS NULL OR height_in > 0);

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_lead_time_days_check;
ALTER TABLE products ADD CONSTRAINT products_lead_time_days_check
  CHECK (
    (lead_time_days_min IS NULL OR lead_time_days_min >= 0)
    AND (lead_time_days_max IS NULL OR lead_time_days_max >= 0)
    AND (
      lead_time_days_min IS NULL
      OR lead_time_days_max IS NULL
      OR lead_time_days_min <= lead_time_days_max
    )
  );

DROP TRIGGER IF EXISTS trg_products_set_updated_at ON products;
CREATE TRIGGER trg_products_set_updated_at
BEFORE UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- Taxonomy
CREATE TABLE IF NOT EXISTS categories (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  parent_category_id text REFERENCES categories(id) ON DELETE SET NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_visible boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_categories_parent_sort
  ON categories (parent_category_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_categories_visible_sort
  ON categories (is_visible, sort_order);

DROP TRIGGER IF EXISTS trg_categories_set_updated_at ON categories;
CREATE TRIGGER trg_categories_set_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS product_categories (
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id text NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  is_primary boolean NOT NULL DEFAULT false,
  PRIMARY KEY (product_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_product_categories_category_id
  ON product_categories (category_id);

CREATE INDEX IF NOT EXISTS idx_product_categories_product_sort
  ON product_categories (product_id, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_categories_one_primary_per_product
  ON product_categories (product_id)
  WHERE is_primary;

CREATE TABLE IF NOT EXISTS tags (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_tags_set_updated_at ON tags;
CREATE TRIGGER trg_tags_set_updated_at
BEFORE UPDATE ON tags
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS product_tags (
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_product_tags_tag_id
  ON product_tags (tag_id);

-- Options and variants
CREATE TABLE IF NOT EXISTS product_options (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, name),
  UNIQUE (id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_options_product_sort
  ON product_options (product_id, sort_order);

DROP TRIGGER IF EXISTS trg_product_options_set_updated_at ON product_options;
CREATE TRIGGER trg_product_options_set_updated_at
BEFORE UPDATE ON product_options
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS product_option_values (
  id text PRIMARY KEY,
  option_id text NOT NULL REFERENCES product_options(id) ON DELETE CASCADE,
  value text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (option_id, value),
  UNIQUE (id, option_id)
);

CREATE INDEX IF NOT EXISTS idx_product_option_values_option_sort
  ON product_option_values (option_id, sort_order);

DROP TRIGGER IF EXISTS trg_product_option_values_set_updated_at ON product_option_values;
CREATE TRIGGER trg_product_option_values_set_updated_at
BEFORE UPDATE ON product_option_values
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS product_variants (
  id text PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku text UNIQUE,
  title text,
  price_delta_cents integer NOT NULL DEFAULT 0,
  inventory_qty integer CHECK (inventory_qty IS NULL OR inventory_qty >= 0),
  weight_oz numeric(10,2) CHECK (weight_oz IS NULL OR weight_oz > 0),
  length_in numeric(10,2) CHECK (length_in IS NULL OR length_in > 0),
  width_in numeric(10,2) CHECK (width_in IS NULL OR width_in > 0),
  height_in numeric(10,2) CHECK (height_in IS NULL OR height_in > 0),
  sort_order integer NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  is_visible boolean NOT NULL DEFAULT true,
  stripe_price_id text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product_sort
  ON product_variants (product_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_product_variants_visible
  ON product_variants (product_id, is_visible);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_one_default_per_product
  ON product_variants (product_id)
  WHERE is_default;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_stripe_price_id_unique
  ON product_variants (stripe_price_id)
  WHERE stripe_price_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_product_variants_set_updated_at ON product_variants;
CREATE TRIGGER trg_product_variants_set_updated_at
BEFORE UPDATE ON product_variants
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS variant_option_values (
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id text NOT NULL,
  option_id text NOT NULL,
  option_value_id text NOT NULL,
  PRIMARY KEY (variant_id, option_id),
  UNIQUE (variant_id, option_value_id),
  FOREIGN KEY (variant_id, product_id)
    REFERENCES product_variants(id, product_id)
    ON DELETE CASCADE,
  FOREIGN KEY (option_id, product_id)
    REFERENCES product_options(id, product_id)
    ON DELETE CASCADE,
  FOREIGN KEY (option_value_id, option_id)
    REFERENCES product_option_values(id, option_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_variant_option_values_option_value_id
  ON variant_option_values (option_value_id);

-- Attributes
CREATE TABLE IF NOT EXISTS attributes (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('text', 'number', 'boolean', 'enum')),
  is_filterable boolean NOT NULL DEFAULT false,
  is_visible boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attributes_filterable_visible_sort
  ON attributes (is_filterable, is_visible, sort_order);

DROP TRIGGER IF EXISTS trg_attributes_set_updated_at ON attributes;
CREATE TRIGGER trg_attributes_set_updated_at
BEFORE UPDATE ON attributes
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS attribute_values (
  id text PRIMARY KEY,
  attribute_id text NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  value_text text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (attribute_id, value_text),
  UNIQUE (id, attribute_id)
);

CREATE INDEX IF NOT EXISTS idx_attribute_values_attribute_sort
  ON attribute_values (attribute_id, sort_order);

DROP TRIGGER IF EXISTS trg_attribute_values_set_updated_at ON attribute_values;
CREATE TRIGGER trg_attribute_values_set_updated_at
BEFORE UPDATE ON attribute_values
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_attribute_value_enum_attribute()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attribute_type text;
BEGIN
  SELECT data_type
    INTO attribute_type
  FROM attributes
  WHERE id = NEW.attribute_id;

  IF attribute_type IS DISTINCT FROM 'enum' THEN
    RAISE EXCEPTION
      'attribute_values row requires an enum attribute; attribute_id=% has data_type=%',
      NEW.attribute_id,
      attribute_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attribute_values_validate_enum_attribute ON attribute_values;
CREATE TRIGGER trg_attribute_values_validate_enum_attribute
BEFORE INSERT OR UPDATE ON attribute_values
FOR EACH ROW
EXECUTE FUNCTION validate_attribute_value_enum_attribute();

CREATE TABLE IF NOT EXISTS product_attribute_values (
  product_id text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attribute_id text NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  attribute_value_id text,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (product_id, attribute_id),
  FOREIGN KEY (attribute_value_id, attribute_id)
    REFERENCES attribute_values(id, attribute_id)
    ON DELETE CASCADE,
  CHECK (
    (
      CASE WHEN attribute_value_id IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN value_text IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN value_number IS NOT NULL THEN 1 ELSE 0 END +
      CASE WHEN value_boolean IS NOT NULL THEN 1 ELSE 0 END
    ) = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_product_attribute_values_attribute_id
  ON product_attribute_values (attribute_id);

CREATE INDEX IF NOT EXISTS idx_product_attribute_values_attribute_value_id
  ON product_attribute_values (attribute_value_id);

DROP TRIGGER IF EXISTS trg_product_attribute_values_set_updated_at ON product_attribute_values;
CREATE TRIGGER trg_product_attribute_values_set_updated_at
BEFORE UPDATE ON product_attribute_values
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION validate_product_attribute_value()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  attribute_type text;
BEGIN
  SELECT data_type
    INTO attribute_type
  FROM attributes
  WHERE id = NEW.attribute_id;

  IF attribute_type IS NULL THEN
    RAISE EXCEPTION 'Unknown attribute_id=%', NEW.attribute_id;
  END IF;

  CASE attribute_type
    WHEN 'enum' THEN
      IF NEW.attribute_value_id IS NULL THEN
        RAISE EXCEPTION 'Enum attribute % requires attribute_value_id', NEW.attribute_id;
      END IF;
    WHEN 'text' THEN
      IF NEW.value_text IS NULL THEN
        RAISE EXCEPTION 'Text attribute % requires value_text', NEW.attribute_id;
      END IF;
    WHEN 'number' THEN
      IF NEW.value_number IS NULL THEN
        RAISE EXCEPTION 'Number attribute % requires value_number', NEW.attribute_id;
      END IF;
    WHEN 'boolean' THEN
      IF NEW.value_boolean IS NULL THEN
        RAISE EXCEPTION 'Boolean attribute % requires value_boolean', NEW.attribute_id;
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported attribute data_type=% for attribute_id=%', attribute_type, NEW.attribute_id;
  END CASE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_attribute_values_validate_type ON product_attribute_values;
CREATE TRIGGER trg_product_attribute_values_validate_type
BEFORE INSERT OR UPDATE ON product_attribute_values
FOR EACH ROW
EXECUTE FUNCTION validate_product_attribute_value();

COMMIT;
