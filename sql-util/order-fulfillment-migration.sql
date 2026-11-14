-- Operational order lifecycle and shipment details.
-- Run once against the shared Soggy Postgres database before deploying the
-- admin fulfillment UI.

alter table if exists orders
  add column if not exists fulfillment_carrier text;

alter table if exists orders
  add column if not exists tracking_number text;

alter table if exists orders
  add column if not exists tracking_url text;

alter table if exists orders
  add column if not exists fulfillment_notes text;

alter table if exists orders
  add column if not exists shipped_at timestamptz;

alter table if exists orders
  drop constraint if exists orders_status_check;

-- `created` was the former work-complete marker. Preserve its meaning while
-- moving existing rows into the explicit fulfillment state.
update orders
set status = 'ready_to_ship', updated_at = now()
where status = 'created';

alter table if exists orders
  add constraint orders_status_check
  check (
    status in (
      'pending_payment',
      'checkout_cancelled',
      'paid',
      'scheduled',
      'in_production',
      'ready_to_ship',
      'shipped',
      'created',
      'canceled'
    )
  );

create index if not exists idx_orders_ready_to_ship
  on orders (work_completed_at asc, created_at asc)
  where status = 'ready_to_ship';
