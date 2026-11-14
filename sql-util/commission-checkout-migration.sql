-- Apply after digital-assets-migration.sql and order-tracking-workflow-migration.sql.
BEGIN;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS shipping_profile jsonb;
UPDATE commissions SET status = 'committed' WHERE status = 'customer_committed';
UPDATE commissions SET status = 'ready_to_ship' WHERE status = 'read_to_ship';

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_product_kind_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_product_kind_check CHECK (
  product_kind IN ('one_of_a_kind', 'repeatable', 'made_to_order', 'commission_template', 'commission_commitment', 'commission_final', 'digital')
);
CREATE INDEX IF NOT EXISTS idx_order_items_commission_stage ON order_items (product_id, product_kind, order_id)
  WHERE product_kind IN ('commission_commitment', 'commission_final');

CREATE TABLE IF NOT EXISTS commission_email_deliveries (
  commission_id text NOT NULL REFERENCES commissions(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('commit', 'finalize')),
  content_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  PRIMARY KEY (commission_id, action, content_hash)
);

CREATE TABLE IF NOT EXISTS commission_checkout_claims (
  commission_id text NOT NULL REFERENCES commissions(id),
  stage text NOT NULL CHECK (stage IN ('commission_commitment', 'commission_final')),
  order_id text NOT NULL REFERENCES orders(id),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (commission_id, stage)
);

-- All fulfillment paths (including tracking integrations) share this linkage.
CREATE OR REPLACE FUNCTION sync_commission_order_fulfillment() RETURNS trigger AS $$
BEGIN
  IF NEW.status IN ('shipped', 'delivered') THEN
    UPDATE commissions c SET status = 'shipped',
      ship_date = COALESCE(NEW.shipped_at, NEW.delivered_at, now())::date,
      updated_at = now()
    WHERE c.status NOT IN ('closed', 'admin_cancelled', 'customer_cancelled')
      AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = NEW.id
        AND oi.product_id = c.id AND oi.product_kind = 'commission_final');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_commission_order_fulfillment ON orders;
CREATE TRIGGER trg_commission_order_fulfillment AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION sync_commission_order_fulfillment();
COMMIT;
