"use strict";

async function reconcileCommissionPayment(client, { orderId }) {
  // Read the immutable purchase stage from the order, never from today's quote.
  const result = await client.query(`
    UPDATE commissions c SET
      status = CASE WHEN oi.product_kind = 'commission_final' THEN 'payment_received'
        WHEN c.status IN ('quoted', 'customer_committed') THEN 'committed' ELSE c.status END,
      updated_at = NOW()
    FROM order_items oi
    WHERE oi.order_id = $1 AND oi.product_id = c.id
      AND oi.product_kind IN ('commission_commitment', 'commission_final')
      AND c.status NOT IN ('shipped', 'closed')
    RETURNING c.id, oi.product_kind
  `, [orderId]);

  // Finished commissions do not need another production allocation. Mixed
  // orders still wait for their ordinary physical items to be made.
  await client.query(`
    UPDATE orders SET status = 'ready_to_ship', work_completed_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND status = 'paid'
      AND EXISTS (SELECT 1 FROM order_items WHERE order_id = $1 AND product_kind = 'commission_final')
      AND NOT EXISTS (SELECT 1 FROM order_items WHERE order_id = $1
        AND product_kind NOT IN ('commission_final', 'commission_commitment', 'digital'))
  `, [orderId]);
  return result.rows.filter((row) => row.product_kind === "commission_commitment").map((row) => row.id);
}

module.exports = { reconcileCommissionPayment };
