-- products
create table if not exists products (
  id            text primary key,
  title         text not null,
  description   text,
  sell_price_cents   integer not null,
  days_to_create numeric(8,2) not null default 1 check (days_to_create >= 0),
  shipping_weight_lbs numeric(8,2) check (shipping_weight_lbs > 0),
  shipping_length_in numeric(8,2) check (shipping_length_in > 0),
  shipping_width_in  numeric(8,2) check (shipping_width_in > 0),
  shipping_height_in numeric(8,2) check (shipping_height_in > 0),
  stripe_thumb_url text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- product_images
create table if not exists product_images (
  id          bigserial primary key,
  product_id  text not null references products(id) on delete cascade,
  path        text not null,         -- e.g. 'products/prod_123/1.jpg'
  alt         text,
  sort_order  integer not null default 0
);

create index if not exists idx_product_images_product_id on product_images(product_id);
