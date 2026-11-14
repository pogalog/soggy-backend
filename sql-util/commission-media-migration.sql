-- Apply to the shared database before deploying either backend.
-- Customer references remain in commissions.storage_images; never expose those here.
create table if not exists commission_product_images (
  id uuid primary key,
  commission_id text not null references commissions(id) on delete cascade,
  display_path text not null unique,
  email_path text not null unique,
  original_path text not null unique,
  alt text not null,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_at timestamptz not null default now()
);
create index if not exists commission_product_images_commission_idx
  on commission_product_images (commission_id, created_at, id);
