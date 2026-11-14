-- Customer identity, carrier status, Track Alert enrollment, and idempotent
-- shipped/delivered notification state for the unified order workflow.

alter table if exists orders
  add column if not exists customer_email text,
  add column if not exists carrier_status_type text,
  add column if not exists carrier_status_code text,
  add column if not exists carrier_status_description text,
  add column if not exists carrier_status_at timestamptz,
  add column if not exists carrier_status_location jsonb,
  add column if not exists estimated_delivery_date date,
  add column if not exists last_tracking_event_at timestamptz,
  add column if not exists delivered_at timestamptz,
  add column if not exists tracking_subscription_status text,
  add column if not exists tracking_subscribed_at timestamptz,
  add column if not exists tracking_subscription_error text;

alter table if exists orders drop constraint if exists orders_status_check;
alter table if exists orders add constraint orders_status_check check (status in (
  'pending_payment', 'checkout_cancelled', 'paid', 'scheduled', 'in_production',
  'ready_to_ship', 'shipped', 'delivered', 'created', 'canceled'
));

create index if not exists idx_orders_tracking_number
  on orders (upper(tracking_number)) where tracking_number is not null;

create index if not exists idx_orders_tracking_subscription
  on orders (tracking_subscription_status, shipped_at)
  where tracking_subscription_status in ('pending', 'failed');

create table if not exists order_notifications (
  id text primary key,
  order_id text not null references orders(id) on delete cascade,
  notification_type text not null check (notification_type in ('shipped', 'delivered')),
  recipient text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempt_count integer not null default 0,
  processing_started_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, notification_type)
);

create index if not exists order_notifications_pending_idx
  on order_notifications (created_at) where status in ('pending', 'failed');
