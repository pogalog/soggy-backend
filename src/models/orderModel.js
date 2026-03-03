"use strict";

const { randomUUID } = require("node:crypto");

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeOptionalInt(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.trunc(value);
}

function buildInsertOrderItemsQuery(orderId, items) {
  const values = [];
  const placeholders = items.map((item, index) => {
    const base = index * 7;
    values.push(
      orderId,
      item.productId,
      item.sku,
      item.name,
      item.unitAmount,
      item.quantity,
      item.stripeThumbUrl || null
    );

    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
  });

  return {
    text: `
      INSERT INTO order_items (
        order_id,
        product_id,
        sku,
        name,
        unit_amount,
        quantity,
        stripe_thumb_url
      )
      VALUES ${placeholders.join(", ")}
    `,
    values
  };
}

function computeSubtotal(items) {
  return items.reduce((sum, item) => sum + item.unitAmount * item.quantity, 0);
}

async function createPendingOrder(pool, { cartSessionId, channel, currency, items }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw withStatusError("Cannot create an order for an empty cart", 422);
  }

  const client = await pool.connect();
  const orderId = randomUUID();
  const subtotalAmount = computeSubtotal(items);

  try {
    await client.query("BEGIN");

    // Pattern A: persist the order snapshot first so Postgres remains the source of truth.
    // Inventory reservation is intentionally omitted here; the paid webhook decrements inventory atomically.
    await client.query(
      `
        INSERT INTO orders (
          id,
          cart_session_id,
          channel,
          status,
          currency,
          subtotal_amount,
          tax_amount,
          total_amount,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 'pending_payment', $4, $5, NULL, $5, NOW(), NOW())
      `,
      [orderId, cartSessionId, channel, currency, subtotalAmount]
    );

    const insertItemsQuery = buildInsertOrderItemsQuery(orderId, items);
    await client.query(insertItemsQuery.text, insertItemsQuery.values);

    await client.query("COMMIT");

    return {
      id: orderId,
      cartSessionId,
      channel,
      status: "pending_payment",
      currency,
      subtotalAmount,
      taxAmount: null,
      totalAmount: subtotalAmount
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setOrderStripeCheckoutSessionId(pool, { orderId, stripeCheckoutSessionId }) {
  const result = await pool.query(
    `
      UPDATE orders
      SET
        stripe_checkout_session_id = $2,
        updated_at = NOW()
      WHERE id = $1
      RETURNING id
    `,
    [orderId, stripeCheckoutSessionId]
  );

  if (result.rowCount === 0) {
    throw withStatusError("Order not found while attaching Stripe session", 404);
  }
}

async function markOrderPaidAndDecrementInventory(
  pool,
  {
    orderId,
    stripeCheckoutSessionId,
    stripePaymentIntentId,
    currency,
    amountSubtotal,
    amountTax,
    amountTotal
  }
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `
        SELECT id, status
        FROM orders
        WHERE id = $1
        FOR UPDATE
      `,
      [orderId]
    );

    if (orderResult.rowCount === 0) {
      throw withStatusError("Order not found", 404);
    }

    const order = orderResult.rows[0];
    if (order.status === "paid") {
      await client.query("COMMIT");
      return {
        orderId,
        alreadyPaid: true
      };
    }

    if (order.status !== "pending_payment") {
      throw withStatusError(
        `Order is not payable from current status: ${order.status}`,
        409
      );
    }

    const itemsResult = await client.query(
      `
        SELECT product_id, quantity
        FROM order_items
        WHERE order_id = $1
        ORDER BY product_id
      `,
      [orderId]
    );

    if (itemsResult.rowCount === 0) {
      throw withStatusError("Order has no items", 409);
    }

    for (const item of itemsResult.rows) {
      const decResult = await client.query(
        `
          UPDATE products
          SET
            inventory_qty = inventory_qty - $1,
            updated_at = NOW()
          WHERE id = $2
            AND inventory_qty >= $1
        `,
        [Number(item.quantity), item.product_id]
      );

      if (decResult.rowCount === 0) {
        throw withStatusError(
          `Insufficient inventory while finalizing order for product ${item.product_id}`,
          409
        );
      }
    }

    await client.query(
      `
        UPDATE orders
        SET
          status = 'paid',
          currency = COALESCE($2, currency),
          subtotal_amount = COALESCE($3, subtotal_amount),
          tax_amount = COALESCE($4, tax_amount),
          total_amount = COALESCE($5, total_amount),
          stripe_checkout_session_id = COALESCE($6, stripe_checkout_session_id),
          stripe_payment_intent_id = COALESCE($7, stripe_payment_intent_id),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        orderId,
        currency || null,
        normalizeOptionalInt(amountSubtotal),
        normalizeOptionalInt(amountTax),
        normalizeOptionalInt(amountTotal),
        stripeCheckoutSessionId || null,
        stripePaymentIntentId || null
      ]
    );

    await client.query("COMMIT");
    return {
      orderId,
      alreadyPaid: false
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createPendingOrder,
  setOrderStripeCheckoutSessionId,
  markOrderPaidAndDecrementInventory
};
