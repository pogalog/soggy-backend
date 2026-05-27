-- cart table (one row per cart line in a session cart)
create table if not exists cart (
  line_id         text primary key,
  session_id      text not null,
  product_id      text not null,
  variant_id      text,
  variant_label   text,
  option_summary  text,
  quantity        integer not null check (quantity > 0),
  last_updated    timestamptz not null default now()
);

create index if not exists idx_cart_session_id on cart(session_id);
create index if not exists idx_cart_last_updated on cart(last_updated);
create unique index if not exists idx_cart_session_simple_product
  on cart(session_id, product_id)
  where variant_id is null;
create unique index if not exists idx_cart_session_variant_product
  on cart(session_id, product_id, variant_id)
  where variant_id is not null;
