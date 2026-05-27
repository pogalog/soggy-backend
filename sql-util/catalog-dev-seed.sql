BEGIN;

UPDATE products
SET
  subtitle = CASE id
    WHEN 'prod_moon_bunny' THEN 'Soft plush bunny with embroidered moon details'
    WHEN 'prod_forest_frog' THEN 'Squishy frog friend in mossy shades'
    WHEN 'prod_berry_bucket_hat' THEN 'Lightweight hat with berry stitch accents'
    ELSE subtitle
  END,
  compare_at_price_cents = CASE id
    WHEN 'prod_moon_bunny' THEN 5200
    WHEN 'prod_berry_bucket_hat' THEN 7800
    ELSE compare_at_price_cents
  END,
  weight_oz = CASE id
    WHEN 'prod_moon_bunny' THEN 20.00
    WHEN 'prod_forest_frog' THEN 18.00
    WHEN 'prod_berry_bucket_hat' THEN 6.50
    ELSE weight_oz
  END,
  length_in = CASE id
    WHEN 'prod_moon_bunny' THEN 10.00
    WHEN 'prod_forest_frog' THEN 9.00
    WHEN 'prod_berry_bucket_hat' THEN 11.00
    ELSE length_in
  END,
  width_in = CASE id
    WHEN 'prod_moon_bunny' THEN 8.00
    WHEN 'prod_forest_frog' THEN 8.00
    WHEN 'prod_berry_bucket_hat' THEN 11.00
    ELSE width_in
  END,
  height_in = CASE id
    WHEN 'prod_moon_bunny' THEN 4.00
    WHEN 'prod_forest_frog' THEN 4.00
    WHEN 'prod_berry_bucket_hat' THEN 4.00
    ELSE height_in
  END,
  lead_time_days_min = CASE id
    WHEN 'prod_moon_bunny' THEN 1.00
    WHEN 'prod_forest_frog' THEN 1.00
    WHEN 'prod_berry_bucket_hat' THEN 1.00
    ELSE lead_time_days_min
  END,
  lead_time_days_max = CASE id
    WHEN 'prod_moon_bunny' THEN 2.00
    WHEN 'prod_forest_frog' THEN 1.50
    WHEN 'prod_berry_bucket_hat' THEN 2.00
    ELSE lead_time_days_max
  END,
  is_featured = CASE id
    WHEN 'prod_moon_bunny' THEN true
    ELSE is_featured
  END,
  search_title = COALESCE(search_title, title),
  search_description = COALESCE(search_description, description);

INSERT INTO safety (name, message, display_type, updated_by)
VALUES (
  'small-parts-standard',
  'This item may contain small parts and is not recommended for children 4 and under.',
  'embedded',
  'codex'
)
ON CONFLICT (name) DO UPDATE
SET
  message = EXCLUDED.message,
  display_type = EXCLUDED.display_type,
  updated_by = EXCLUDED.updated_by,
  updated_at = NOW();

UPDATE products
SET safety_id = (
  SELECT id
  FROM safety
  WHERE name = 'small-parts-standard'
)
WHERE id = 'prod_moon_bunny';

INSERT INTO categories (id, slug, name, description, sort_order, is_visible)
VALUES
  ('cat_plush', 'plush', 'Plush', 'Soft sculptural plushies and creatures.', 10, true),
  ('cat_wearables', 'wearables', 'Wearables', 'Wearable crochet pieces and accessories.', 20, true),
  ('cat_pride', 'pride', 'Pride', 'Pride-inspired colorways and celebratory pieces.', 30, true)
ON CONFLICT (id) DO UPDATE
SET
  slug = EXCLUDED.slug,
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_visible = EXCLUDED.is_visible,
  updated_at = NOW();

INSERT INTO product_categories (product_id, category_id, sort_order, is_primary)
VALUES
  ('prod_moon_bunny', 'cat_plush', 0, true),
  ('prod_forest_frog', 'cat_plush', 0, true),
  ('prod_berry_bucket_hat', 'cat_wearables', 0, true),
  ('prod_berry_bucket_hat', 'cat_pride', 1, false)
ON CONFLICT (product_id, category_id) DO UPDATE
SET
  sort_order = EXCLUDED.sort_order,
  is_primary = EXCLUDED.is_primary;

INSERT INTO tags (id, slug, name)
VALUES
  ('tag_plush', 'plush', 'Plush'),
  ('tag_made_to_order', 'made-to-order', 'Made To Order'),
  ('tag_pride', 'pride', 'Pride')
ON CONFLICT (id) DO UPDATE
SET
  slug = EXCLUDED.slug,
  name = EXCLUDED.name,
  updated_at = NOW();

INSERT INTO product_tags (product_id, tag_id)
VALUES
  ('prod_moon_bunny', 'tag_plush'),
  ('prod_moon_bunny', 'tag_made_to_order'),
  ('prod_forest_frog', 'tag_plush'),
  ('prod_berry_bucket_hat', 'tag_pride')
ON CONFLICT (product_id, tag_id) DO NOTHING;

INSERT INTO attributes (id, code, name, data_type, is_filterable, is_visible, sort_order)
VALUES
  ('attr_softness', 'softness', 'Softness', 'enum', true, true, 10),
  ('attr_size_band', 'size_band', 'Size Band', 'text', true, true, 20)
ON CONFLICT (id) DO UPDATE
SET
  code = EXCLUDED.code,
  name = EXCLUDED.name,
  data_type = EXCLUDED.data_type,
  is_filterable = EXCLUDED.is_filterable,
  is_visible = EXCLUDED.is_visible,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

INSERT INTO attribute_values (id, attribute_id, value_text, sort_order)
VALUES
  ('attrv_softness_extra_soft', 'attr_softness', 'Extra Soft', 0),
  ('attrv_softness_soft', 'attr_softness', 'Soft', 1)
ON CONFLICT (id) DO UPDATE
SET
  attribute_id = EXCLUDED.attribute_id,
  value_text = EXCLUDED.value_text,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

INSERT INTO product_attribute_values (
  product_id,
  attribute_id,
  attribute_value_id,
  value_text,
  value_number,
  value_boolean
)
VALUES
  ('prod_moon_bunny', 'attr_softness', 'attrv_softness_extra_soft', NULL, NULL, NULL),
  ('prod_moon_bunny', 'attr_size_band', NULL, 'Medium plush', NULL, NULL),
  ('prod_forest_frog', 'attr_softness', 'attrv_softness_soft', NULL, NULL, NULL)
ON CONFLICT (product_id, attribute_id) DO UPDATE
SET
  attribute_value_id = EXCLUDED.attribute_value_id,
  value_text = EXCLUDED.value_text,
  value_number = EXCLUDED.value_number,
  value_boolean = EXCLUDED.value_boolean,
  updated_at = NOW();

INSERT INTO product_options (id, product_id, name, sort_order)
VALUES
  ('opt_moon_bunny_color', 'prod_moon_bunny', 'Color', 0),
  ('opt_moon_bunny_size', 'prod_moon_bunny', 'Size', 1)
ON CONFLICT (id) DO UPDATE
SET
  product_id = EXCLUDED.product_id,
  name = EXCLUDED.name,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

INSERT INTO product_option_values (id, option_id, value, sort_order)
VALUES
  ('optv_moon_bunny_color_pink', 'opt_moon_bunny_color', 'Pink', 0),
  ('optv_moon_bunny_color_blue', 'opt_moon_bunny_color', 'Blue', 1),
  ('optv_moon_bunny_size_mini', 'opt_moon_bunny_size', 'Mini', 0),
  ('optv_moon_bunny_size_classic', 'opt_moon_bunny_size', 'Classic', 1)
ON CONFLICT (id) DO UPDATE
SET
  option_id = EXCLUDED.option_id,
  value = EXCLUDED.value,
  sort_order = EXCLUDED.sort_order,
  updated_at = NOW();

INSERT INTO product_variants (
  id,
  product_id,
  sku,
  title,
  price_delta_cents,
  inventory_qty,
  weight_oz,
  length_in,
  width_in,
  height_in,
  sort_order,
  is_default,
  is_visible
)
VALUES
  (
    'var_moon_bunny_pink_mini',
    'prod_moon_bunny',
    'MOON-BUNNY-PINK-MINI',
    'Pink / Mini',
    -400,
    2,
    14.00,
    8.00,
    6.00,
    3.00,
    0,
    false,
    true
  ),
  (
    'var_moon_bunny_pink_classic',
    'prod_moon_bunny',
    'MOON-BUNNY-PINK-CLASSIC',
    'Pink / Classic',
    0,
    1,
    20.00,
    10.00,
    8.00,
    4.00,
    1,
    true,
    true
  ),
  (
    'var_moon_bunny_blue_classic',
    'prod_moon_bunny',
    'MOON-BUNNY-BLUE-CLASSIC',
    'Blue / Classic',
    300,
    3,
    20.00,
    10.00,
    8.00,
    4.00,
    2,
    false,
    true
  )
ON CONFLICT (id) DO UPDATE
SET
  product_id = EXCLUDED.product_id,
  sku = EXCLUDED.sku,
  title = EXCLUDED.title,
  price_delta_cents = EXCLUDED.price_delta_cents,
  inventory_qty = EXCLUDED.inventory_qty,
  weight_oz = EXCLUDED.weight_oz,
  length_in = EXCLUDED.length_in,
  width_in = EXCLUDED.width_in,
  height_in = EXCLUDED.height_in,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  is_visible = EXCLUDED.is_visible,
  updated_at = NOW();

INSERT INTO variant_option_values (product_id, variant_id, option_id, option_value_id)
VALUES
  ('prod_moon_bunny', 'var_moon_bunny_pink_mini', 'opt_moon_bunny_color', 'optv_moon_bunny_color_pink'),
  ('prod_moon_bunny', 'var_moon_bunny_pink_mini', 'opt_moon_bunny_size', 'optv_moon_bunny_size_mini'),
  ('prod_moon_bunny', 'var_moon_bunny_pink_classic', 'opt_moon_bunny_color', 'optv_moon_bunny_color_pink'),
  ('prod_moon_bunny', 'var_moon_bunny_pink_classic', 'opt_moon_bunny_size', 'optv_moon_bunny_size_classic'),
  ('prod_moon_bunny', 'var_moon_bunny_blue_classic', 'opt_moon_bunny_color', 'optv_moon_bunny_color_blue'),
  ('prod_moon_bunny', 'var_moon_bunny_blue_classic', 'opt_moon_bunny_size', 'optv_moon_bunny_size_classic')
ON CONFLICT (variant_id, option_id) DO UPDATE
SET
  option_value_id = EXCLUDED.option_value_id,
  product_id = EXCLUDED.product_id;

COMMIT;
