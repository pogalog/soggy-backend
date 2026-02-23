-- Seed data: 10 products + images
-- Assumes tables already exist as you defined.

BEGIN;

-- Optional: clear existing rows for a clean rerun
-- (uncomment if you want it to be repeatable)
-- TRUNCATE TABLE product_images;
-- TRUNCATE TABLE products;

INSERT INTO products (id, title, description, sell_price_cents, inventory_qty, created_at, updated_at)
VALUES
  (
    'prod_moon_bunny',
    'Moon Bunny Plush',
    'Soft plush bunny with embroidered moon details. Great gift size; can be customized in color.',
    4500,
    3,
    NOW() - INTERVAL '20 days',
    NOW() - INTERVAL '2 days'
  ),
  (
    'prod_forest_frog',
    'Forest Frog Buddy',
    'A squishy frog friend with a little smile. Works up nicely in greens, teals, or any “mossy” palette.',
    3800,
    5,
    NOW() - INTERVAL '18 days',
    NOW() - INTERVAL '1 day'
  ),
  (
    'prod_sunflower_keychain',
    'Sunflower Keychain',
    'Tiny sunflower charm with sturdy clasp. Perfect for bags, keys, or zipper pulls.',
    1200,
    12,
    NOW() - INTERVAL '16 days',
    NOW() - INTERVAL '3 days'
  ),
  (
    'prod_winter_scarf',
    'Winter Scarf',
    'Cozy scarf with clean ribbing and a soft drape. Made to order in your preferred colors.',
    6000,
    0,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '10 days'
  ),
  (
    'prod_starry_beanie',
    'Starry Night Beanie',
    'Warm beanie with subtle star motif. Stretchy fit and comfy brim.',
    3200,
    7,
    NOW() - INTERVAL '12 days',
    NOW() - INTERVAL '1 day'
  ),
  (
    'prod_cable_headband',
    'Cable Knit Headband',
    'Twist-front headband that keeps ears warm without hat hair. Soft, snug, and cute.',
    1800,
    9,
    NOW() - INTERVAL '11 days',
    NOW() - INTERVAL '4 days'
  ),
  (
    'prod_cloud_coaster_set',
    'Cloud Coaster Set (4)',
    'Set of four cloud coasters. Thick, absorbent, and makes your mug look adorable.',
    2400,
    4,
    NOW() - INTERVAL '14 days',
    NOW() - INTERVAL '6 days'
  ),
  (
    'prod_mushroom_pouch',
    'Mushroom Pouch',
    'Little drawstring pouch with mushroom applique. Great for dice, earbuds, or tiny treasures.',
    2600,
    2,
    NOW() - INTERVAL '9 days',
    NOW() - INTERVAL '2 days'
  ),
  (
    'prod_dragon_egg_plush',
    'Dragon Egg Plush',
    'Textured “egg” plush with scale-like stitch pattern. Fun display piece; can do themed colors.',
    5200,
    1,
    NOW() - INTERVAL '25 days',
    NOW() - INTERVAL '5 days'
  ),
  (
    'prod_berry_bucket_hat',
    'Berry Bucket Hat',
    'Bucket hat with berry stitch accents. Lightweight, cute, and perfect for sunny market days.',
    7000,
    2,
    NOW() - INTERVAL '7 days',
    NOW() - INTERVAL '1 day'
  );

-- Images (3 per product)
INSERT INTO product_images (product_id, path, alt, sort_order)
VALUES
  -- Moon Bunny Plush
  ('prod_moon_bunny', 'products/prod_moon_bunny/1.jpg', 'Moon Bunny Plush front view', 0),
  ('prod_moon_bunny', 'products/prod_moon_bunny/2.jpg', 'Moon Bunny Plush side profile', 1),
  ('prod_moon_bunny', 'products/prod_moon_bunny/3.jpg', 'Moon Bunny Plush stitch detail', 2),

  -- Forest Frog Buddy
  ('prod_forest_frog', 'products/prod_forest_frog/1.jpg', 'Forest Frog Buddy front view', 0),
  ('prod_forest_frog', 'products/prod_forest_frog/2.jpg', 'Forest Frog Buddy close-up', 1),
  ('prod_forest_frog', 'products/prod_forest_frog/3.jpg', 'Forest Frog Buddy in hand for scale', 2),

  -- Sunflower Keychain
  ('prod_sunflower_keychain', 'products/prod_sunflower_keychain/1.jpg', 'Sunflower Keychain on clasp', 0),
  ('prod_sunflower_keychain', 'products/prod_sunflower_keychain/2.jpg', 'Sunflower Keychain detail stitching', 1),
  ('prod_sunflower_keychain', 'products/prod_sunflower_keychain/3.jpg', 'Sunflower Keychain on bag', 2),

  -- Winter Scarf
  ('prod_winter_scarf', 'products/prod_winter_scarf/1.jpg', 'Winter Scarf folded', 0),
  ('prod_winter_scarf', 'products/prod_winter_scarf/2.jpg', 'Winter Scarf drape detail', 1),
  ('prod_winter_scarf', 'products/prod_winter_scarf/3.jpg', 'Winter Scarf texture close-up', 2),

  -- Starry Night Beanie
  ('prod_starry_beanie', 'products/prod_starry_beanie/1.jpg', 'Starry Night Beanie front view', 0),
  ('prod_starry_beanie', 'products/prod_starry_beanie/2.jpg', 'Starry Night Beanie brim detail', 1),
  ('prod_starry_beanie', 'products/prod_starry_beanie/3.jpg', 'Starry Night Beanie top view', 2),

  -- Cable Knit Headband
  ('prod_cable_headband', 'products/prod_cable_headband/1.jpg', 'Cable Knit Headband front twist', 0),
  ('prod_cable_headband', 'products/prod_cable_headband/2.jpg', 'Cable Knit Headband side view', 1),
  ('prod_cable_headband', 'products/prod_cable_headband/3.jpg', 'Cable Knit Headband texture close-up', 2),

  -- Cloud Coaster Set
  ('prod_cloud_coaster_set', 'products/prod_cloud_coaster_set/1.jpg', 'Cloud Coaster Set stacked', 0),
  ('prod_cloud_coaster_set', 'products/prod_cloud_coaster_set/2.jpg', 'Cloud Coaster under mug', 1),
  ('prod_cloud_coaster_set', 'products/prod_cloud_coaster_set/3.jpg', 'Cloud Coaster edge detail', 2),

  -- Mushroom Pouch
  ('prod_mushroom_pouch', 'products/prod_mushroom_pouch/1.jpg', 'Mushroom Pouch front view', 0),
  ('prod_mushroom_pouch', 'products/prod_mushroom_pouch/2.jpg', 'Mushroom Pouch open top', 1),
  ('prod_mushroom_pouch', 'products/prod_mushroom_pouch/3.jpg', 'Mushroom applique detail', 2),

  -- Dragon Egg Plush
  ('prod_dragon_egg_plush', 'products/prod_dragon_egg_plush/1.jpg', 'Dragon Egg Plush front view', 0),
  ('prod_dragon_egg_plush', 'products/prod_dragon_egg_plush/2.jpg', 'Dragon Egg Plush texture close-up', 1),
  ('prod_dragon_egg_plush', 'products/prod_dragon_egg_plush/3.jpg', 'Dragon Egg Plush in a basket', 2),

  -- Berry Bucket Hat
  ('prod_berry_bucket_hat', 'products/prod_berry_bucket_hat/1.jpg', 'Berry Bucket Hat front view', 0),
  ('prod_berry_bucket_hat', 'products/prod_berry_bucket_hat/2.jpg', 'Berry stitch accents close-up', 1),
  ('prod_berry_bucket_hat', 'products/prod_berry_bucket_hat/3.jpg', 'Berry Bucket Hat on mannequin', 2);

COMMIT;
