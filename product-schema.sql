-- products
create table if not exists products (
  id            text primary key,
  title         text not null,
  description   text,
  sell_price_cents   integer not null,
  inventory_qty integer not null default 0,
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
