alter table if exists products
  add column if not exists shipping_weight_lbs numeric(8,2) check (shipping_weight_lbs > 0);

alter table if exists products
  add column if not exists shipping_length_in numeric(8,2) check (shipping_length_in > 0);

alter table if exists products
  add column if not exists shipping_width_in numeric(8,2) check (shipping_width_in > 0);

alter table if exists products
  add column if not exists shipping_height_in numeric(8,2) check (shipping_height_in > 0);

alter table if exists orders
  add column if not exists shipping_details jsonb;

alter table if exists orders
  add column if not exists shipping_quote jsonb;
