-- Commission request records intentionally exclude customer PII.
create table if not exists commissions (
  id                         text primary key,
  submission_key             text not null unique,
  item_name                  text not null,
  item_description           text not null,
  yarn_type                  text not null,
  yarn_color                 text not null,
  attachment_material_type   text not null,
  storage_bucket             text not null,
  upload_directory           text,
  storage_images             jsonb not null default '[]'::jsonb,
  meta_path                  text,
  signed_url_expires_at      timestamptz,
  prepared_at                timestamptz,
  status                     text not null default 'email_pending',
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

alter table if exists commissions
  alter column upload_directory drop not null;

alter table if exists commissions
  alter column meta_path drop not null;

alter table if exists commissions
  alter column signed_url_expires_at drop not null;

alter table if exists commissions
  alter column prepared_at drop not null;

create index if not exists idx_commissions_status on commissions(status);
create index if not exists idx_commissions_created_at on commissions(created_at);
