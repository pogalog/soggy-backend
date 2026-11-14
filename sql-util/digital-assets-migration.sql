BEGIN;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_kind_check;
ALTER TABLE products ADD CONSTRAINT products_product_kind_check
  CHECK (
    product_kind IN (
      'one_of_a_kind',
      'repeatable',
      'made_to_order',
      'commission_template',
      'digital'
    )
  );

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_availability_mode_check;
ALTER TABLE products ADD CONSTRAINT products_availability_mode_check
  CHECK (
    availability_mode IN (
      'ready_to_ship',
      'made_to_order',
      'preorder',
      'market_only',
      'instant_download'
    )
  );

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS product_kind text;

UPDATE order_items oi
SET product_kind = p.product_kind
FROM products p
WHERE p.id = oi.product_id
  AND oi.product_kind IS NULL;

UPDATE order_items
SET product_kind = 'commission_commitment'
WHERE product_kind IS NULL
  AND product_id ~* '^cm_[0-9a-f]+$';

UPDATE order_items
SET product_kind = 'repeatable'
WHERE product_kind IS NULL;

ALTER TABLE order_items
  ALTER COLUMN product_kind SET DEFAULT 'repeatable',
  ALTER COLUMN product_kind SET NOT NULL;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_product_kind_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_product_kind_check
  CHECK (
    product_kind IN (
      'one_of_a_kind',
      'repeatable',
      'made_to_order',
      'commission_template',
      'commission_commitment',
      'digital'
    )
  );

CREATE TABLE IF NOT EXISTS product_digital_assets (
  id                     text PRIMARY KEY,
  product_id             text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label                  text NOT NULL DEFAULT 'Primary download',
  version                integer NOT NULL CHECK (version > 0),
  status                 text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'archived')),
  storage_bucket         text NOT NULL,
  object_path            text NOT NULL,
  original_filename      text NOT NULL,
  content_type           text NOT NULL DEFAULT 'application/pdf',
  byte_size              bigint NOT NULL CHECK (byte_size > 0),
  sha256                 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  page_count             integer CHECK (page_count IS NULL OR page_count > 0),
  personalization_config jsonb NOT NULL DEFAULT
                         '{
                           "mode": "license_page_footer",
                           "customer_label": "masked_email",
                           "copyright_notice": true,
                           "website": "www.soggystitches.com"
                         }'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, label, version),
  UNIQUE (storage_bucket, object_path)
);

CREATE INDEX IF NOT EXISTS idx_product_digital_assets_product
  ON product_digital_assets(product_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS digital_entitlements (
  id                    text PRIMARY KEY,
  order_id              text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_line_id         text NOT NULL,
  asset_id              text NOT NULL REFERENCES product_digital_assets(id),
  customer_email        text NOT NULL,
  customer_name         text,
  copy_id               text NOT NULL UNIQUE,
  status                text NOT NULL DEFAULT 'generating'
                        CHECK (status IN ('generating', 'available', 'failed', 'revoked')),
  personalized_bucket   text,
  personalized_path     text,
  personalized_sha256   text CHECK (
                          personalized_sha256 IS NULL OR
                          personalized_sha256 ~ '^[0-9a-f]{64}$'
                        ),
  download_limit        integer NOT NULL DEFAULT 5 CHECK (download_limit > 0),
  download_count        integer NOT NULL DEFAULT 0 CHECK (download_count >= 0),
  expires_at            timestamptz NOT NULL,
  first_download_at     timestamptz,
  last_download_at      timestamptz,
  failure_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, order_line_id, asset_id),
  FOREIGN KEY (order_id, order_line_id)
    REFERENCES order_items(order_id, line_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_digital_entitlements_order
  ON digital_entitlements(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_digital_entitlements_customer
  ON digital_entitlements(lower(customer_email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_digital_entitlements_access
  ON digital_entitlements(status, expires_at);

CREATE TABLE IF NOT EXISTS digital_access_grants (
  id             text PRIMARY KEY,
  entitlement_id text NOT NULL REFERENCES digital_entitlements(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_digital_access_grants_entitlement
  ON digital_access_grants(entitlement_id, created_at DESC);

CREATE TABLE IF NOT EXISTS digital_access_events (
  id             bigserial PRIMARY KEY,
  entitlement_id text NOT NULL REFERENCES digital_entitlements(id) ON DELETE CASCADE,
  grant_id       text REFERENCES digital_access_grants(id) ON DELETE SET NULL,
  event_type     text NOT NULL CHECK (
                   event_type IN (
                     'download_authorized',
                     'download_denied',
                     'admin_count_reset',
                     'admin_limit_changed',
                     'admin_access_extended',
                     'admin_access_revoked',
                     'admin_grant_reissued',
                     'generation_failed',
                     'delivery_email_sent',
                     'delivery_email_failed'
                   )
                 ),
  actor          text,
  ip_hash        text,
  user_agent     text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_digital_access_events_entitlement
  ON digital_access_events(entitlement_id, created_at DESC);

-- Re-running this migration after an earlier digital rollout should also expand
-- the event constraint without requiring the tables to be recreated.
ALTER TABLE digital_access_events
  DROP CONSTRAINT IF EXISTS digital_access_events_event_type_check;
ALTER TABLE digital_access_events
  ADD CONSTRAINT digital_access_events_event_type_check CHECK (
    event_type IN (
      'download_authorized',
      'download_denied',
      'admin_count_reset',
      'admin_limit_changed',
      'admin_access_extended',
      'admin_access_revoked',
      'admin_grant_reissued',
      'generation_failed',
      'delivery_email_sent',
      'delivery_email_failed'
    )
  );

COMMIT;
