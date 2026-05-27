alter table if exists orders
  drop constraint if exists orders_status_check;

alter table if exists orders
  add constraint orders_status_check
  check (status in ('pending_payment', 'checkout_cancelled', 'paid', 'canceled'));
