-- orders
create table if not exists orders (
  id                         text primary key,
  cart_session_id            text not null,
  channel                    text not null default 'online'
                             check (channel in ('online', 'market')),
  status                     text not null
                             check (status in ('pending_payment', 'paid', 'canceled')),
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

-- order_items
create table if not exists order_items (
  order_id         text not null references orders(id) on delete cascade,
  product_id       text not null references products(id),
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
