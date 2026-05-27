-- Commission request records intentionally exclude customer PII.
create table if not exists commissions (
  id                         text primary key,
  submission_key             text not null unique,
  item_name                  text not null,
  item_description           text not null,
  yarn_type                  text not null,
  yarn_color                 text not null,
  attachment_material_type   text not null,
  requires_commit            boolean not null default false,
  commitment_deposit_amount  integer,
  time_cost                  integer,
  ship_date                  date,
  total_cost                 integer,
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
  add column if not exists requires_commit boolean not null default false;

alter table if exists commissions
  add column if not exists commitment_deposit_amount integer;

alter table if exists commissions
  add column if not exists time_cost integer;

alter table if exists commissions
  add column if not exists ship_date date;

alter table if exists commissions
  add column if not exists total_cost integer;

alter table if exists commissions
  add column if not exists yarn_colors jsonb not null default '[]'::jsonb;

update commissions
set yarn_colors = jsonb_build_array(
  jsonb_build_object(
    'color', yarn_color,
    'usage', 'Primary color'
  )
)
where yarn_colors = '[]'::jsonb
  and yarn_color is not null
  and btrim(yarn_color) <> '';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.commissions'::regclass
      and conname = 'commissions_yarn_colors_is_array'
  ) then
    alter table commissions
      add constraint commissions_yarn_colors_is_array
      check (jsonb_typeof(yarn_colors) = 'array');
  end if;
end $$;

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
