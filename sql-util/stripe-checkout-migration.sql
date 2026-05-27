-- Add optional public Stripe thumbnail URL to products if your base schema predates Checkout integration.
alter table if exists products
  add column if not exists stripe_thumb_url text;

alter table if exists products
  add column if not exists shipping_weight_lbs numeric(8,2) check (shipping_weight_lbs > 0);

alter table if exists products
  add column if not exists shipping_length_in numeric(8,2) check (shipping_length_in > 0);

alter table if exists products
  add column if not exists shipping_width_in numeric(8,2) check (shipping_width_in > 0);

alter table if exists products
  add column if not exists shipping_height_in numeric(8,2) check (shipping_height_in > 0);

-- Orders and order item snapshots for Stripe Checkout + webhook reconciliation.
create table if not exists orders (
  id                         text primary key,
  cart_session_id            text not null,
  channel                    text not null default 'online'
                             check (channel in ('online', 'market')),
  status                     text not null
                             check (status in ('pending_payment', 'checkout_cancelled', 'paid', 'canceled')),
  currency                   text not null,
  subtotal_amount            integer not null check (subtotal_amount >= 0),
  tax_amount                 integer,
  total_amount               integer not null check (total_amount >= 0),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create index if not exists idx_orders_cart_session_id on orders(cart_session_id);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_created_at on orders(created_at);

alter table if exists orders
  add column if not exists shipping_method text;

alter table if exists orders
  add column if not exists shipping_amount integer check (shipping_amount >= 0);

alter table if exists orders
  add column if not exists shipping_details jsonb;

alter table if exists orders
  add column if not exists shipping_quote jsonb;

alter table if exists orders
  drop constraint if exists orders_status_check;

alter table if exists orders
  add constraint orders_status_check
  check (status in ('pending_payment', 'checkout_cancelled', 'paid', 'canceled'));

create table if not exists order_items (
  order_id         text not null references orders(id) on delete cascade,
  product_id       text not null,
  sku              text not null,
  name             text not null,
  unit_amount      integer not null check (unit_amount >= 0),
  quantity         integer not null check (quantity > 0),
  stripe_thumb_url text,
  created_at       timestamptz not null default now(),
  primary key (order_id, product_id)
);

create index if not exists idx_order_items_order_id on order_items(order_id);
create index if not exists idx_order_items_product_id on order_items(product_id);

do $$
declare
  constraint_name text;
begin
  select tc.constraint_name
    into constraint_name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on tc.constraint_name = kcu.constraint_name
   and tc.table_schema = kcu.table_schema
  where tc.table_schema = current_schema()
    and tc.table_name = 'order_items'
    and tc.constraint_type = 'FOREIGN KEY'
    and kcu.column_name = 'product_id'
  limit 1;

  if constraint_name is not null then
    execute format(
      'alter table %I.%I drop constraint %I',
      current_schema(),
      'order_items',
      constraint_name
    );
  end if;
end
$$;
