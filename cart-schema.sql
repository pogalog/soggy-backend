-- cart table (one row per product in a session cart)
create table if not exists cart (
  session_id    text not null,
  product_id    text not null,
  quantity      integer not null check (quantity > 0),
  last_updated  timestamptz not null default now(),
  primary key (session_id, product_id)
);

create index if not exists idx_cart_session_id on cart(session_id);
create index if not exists idx_cart_last_updated on cart(last_updated);
