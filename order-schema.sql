-- orders
create table if not exists orders (
  id                         text primary key,
  cart_session_id            text not null,
  channel                    text not null default 'online'
                             check (channel in ('online', 'market')),
  status                     text not null
                             check (status in ('pending_payment', 'checkout_cancelled', 'paid', 'scheduled', 'in_production', 'ready_to_ship', 'shipped', 'delivered', 'created', 'canceled')),
  currency                   text not null,
  subtotal_amount            integer not null check (subtotal_amount >= 0),
  tax_amount                 integer,
  total_amount               integer not null check (total_amount >= 0),
  shipping_method            text,
  shipping_amount            integer check (shipping_amount >= 0),
  shipping_details           jsonb,
  shipping_quote             jsonb,
  ship_by_date               date,
  work_scheduled_at          timestamptz,
  work_completed_at          timestamptz,
  customer_email             text,
  fulfillment_carrier        text,
  tracking_number            text,
  tracking_url               text,
  fulfillment_notes          text,
  shipped_at                 timestamptz,
  carrier_status_type        text,
  carrier_status_code        text,
  carrier_status_description text,
  carrier_status_at          timestamptz,
  carrier_status_location    jsonb,
  estimated_delivery_date    date,
  last_tracking_event_at     timestamptz,
  delivered_at               timestamptz,
  tracking_subscription_status text,
  tracking_subscribed_at     timestamptz,
  tracking_subscription_error text,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id   text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create index if not exists idx_orders_cart_session_id on orders(cart_session_id);
create index if not exists idx_orders_status on orders(status);
create index if not exists idx_orders_created_at on orders(created_at);
create index if not exists idx_orders_tracking_number on orders(upper(tracking_number)) where tracking_number is not null;

-- order_items
create table if not exists order_items (
  line_id          text not null,
  order_id         text not null references orders(id) on delete cascade,
  product_id       text not null,
  variant_id       text,
  variant_label    text,
  option_summary   text,
  sku              text not null,
  name             text not null,
  unit_amount      integer not null check (unit_amount >= 0),
  quantity         integer not null check (quantity > 0),
  stripe_thumb_url text,
  work_units       numeric(10,2) not null default 0 check (work_units >= 0),
  product_kind     text not null default 'repeatable'
                   check (product_kind in ('one_of_a_kind', 'repeatable', 'made_to_order', 'commission_template', 'commission_commitment', 'commission_final', 'digital')),
  created_at       timestamptz not null default now(),
  primary key (order_id, line_id)
);

create index if not exists idx_order_items_order_id on order_items(order_id);
create index if not exists idx_order_items_product_id on order_items(product_id);
