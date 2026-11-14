"use strict";

// order_items.product_id is the commission ID; product_kind records what was
// purchased, so later status/quote edits cannot turn a deposit into a final sale.
const COMMISSION_COMMERCE_SELECT = `
  SELECT c.*,
    COALESCE((
      SELECT SUM(oi.unit_amount * oi.quantity)
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = c.id AND oi.product_kind = 'commission_commitment'
        AND (o.status IN ('paid', 'scheduled', 'in_production', 'ready_to_ship', 'shipped', 'delivered') OR o.stripe_payment_intent_id IS NOT NULL)
    ), 0)::integer AS commitment_paid_amount,
    EXISTS (SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = c.id AND oi.product_kind = 'commission_final'
        AND (o.status IN ('paid', 'scheduled', 'in_production', 'ready_to_ship', 'shipped', 'delivered') OR o.stripe_payment_intent_id IS NOT NULL)) AS final_payment_received,
    (SELECT o.id FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = c.id AND oi.product_kind = 'commission_final'
      ORDER BY (o.status NOT IN ('pending_payment', 'checkout_cancelled', 'canceled')) DESC,
        o.created_at DESC LIMIT 1) AS final_order_id
  FROM commissions c
`;

function normalizeCommissionStatus(status) {
  return status === "customer_committed" ? "committed" : status === "read_to_ship" ? "ready_to_ship" : status;
}

function getCommissionPurchase(row) {
  if (!row || row.final_payment_received) return null;
  const status = normalizeCommissionStatus(row.status);
  if (status === "ready_to_ship") {
    const subtotal = Number(row.total_cost);
    const paid = Number(row.commitment_paid_amount || 0);
    if (row.total_cost == null || !Number.isSafeInteger(subtotal) || !Number.isSafeInteger(paid) || paid < 0 || subtotal < paid) return null;
    return { kind: "commission_final", amount: subtotal - paid, paid, title: `Commission final payment: ${row.item_name}`, shipping: row.shipping_profile || null };
  }
  const deposit = Number(row.commitment_deposit_amount);
  if (status !== "quoted" || row.requires_commit !== true || row.commitment_deposit_amount == null || !Number.isSafeInteger(deposit) || deposit <= 0 || Number(row.commitment_paid_amount || 0) > 0) return null;
  return { kind: "commission_commitment", amount: deposit, paid: 0, title: `Commission commitment: ${row.item_name}`, shipping: null };
}

module.exports = { COMMISSION_COMMERCE_SELECT, getCommissionPurchase, normalizeCommissionStatus };
