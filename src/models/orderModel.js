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

function normalizeOptionalObject(value) {
  return value && typeof value === "object" ? value : null;
}

function isCommissionOrderItem(productId) {
  return typeof productId === "string" && /^cm_[0-9a-f]+$/i.test(productId);
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

let hasCheckedOrderShippingColumns = false;
let cachedOrderColumnSupport = null;

async function getOrderColumnSupport(pool) {
  if (hasCheckedOrderShippingColumns && cachedOrderColumnSupport) {
    return cachedOrderColumnSupport;
  }

  const result = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'orders'
        AND column_name IN (
          'shipping_method',
          'shipping_amount',
          'shipping_details',
          'shipping_quote'
        )
    `
  );

  const columnNames = new Set(result.rows.map((row) => row.column_name));
  hasCheckedOrderShippingColumns = true;
  cachedOrderColumnSupport = {
    hasShippingAmountColumns:
      columnNames.has("shipping_method") && columnNames.has("shipping_amount"),
    hasShippingDetailsColumn: columnNames.has("shipping_details"),
    hasShippingQuoteColumn: columnNames.has("shipping_quote")
  };
  return cachedOrderColumnSupport;
}

async function createPendingOrder(
  pool,
  {
    cartSessionId,
    channel,
    currency,
    items,
    shippingMethod,
    shippingAmount,
    shippingDetails,
    shippingQuote
  }
) {
  if (!Array.isArray(items) || items.length === 0) {
    throw withStatusError("Cannot create an order for an empty cart", 422);
  }

  const client = await pool.connect();
  const orderId = randomUUID();
  const subtotalAmount = computeSubtotal(items);
  const normalizedShippingAmount = normalizeOptionalInt(shippingAmount);
  const totalAmount = subtotalAmount + (normalizedShippingAmount || 0);
  const columnSupport = await getOrderColumnSupport(pool);

  try {
    await client.query("BEGIN");

    const columns = [
      "id",
      "cart_session_id",
      "channel",
      "status",
      "currency",
      "subtotal_amount",
      "tax_amount",
      "total_amount"
    ];
    const values = [orderId, cartSessionId, channel, currency, subtotalAmount, totalAmount];
    const placeholders = ["$1", "$2", "$3", "'pending_payment'", "$4", "$5", "NULL", "$6"];
    let nextIndex = 6;

    if (columnSupport.hasShippingAmountColumns) {
      columns.push("shipping_method", "shipping_amount");
      values.push(shippingMethod || null, normalizedShippingAmount);
      nextIndex += 1;
      placeholders.push(`$${nextIndex}`);
      nextIndex += 1;
      placeholders.push(`$${nextIndex}`);
    }

    if (columnSupport.hasShippingDetailsColumn) {
      columns.push("shipping_details");
      values.push(normalizeOptionalObject(shippingDetails));
      nextIndex += 1;
      placeholders.push(`$${nextIndex}::jsonb`);
    }

    if (columnSupport.hasShippingQuoteColumn) {
      columns.push("shipping_quote");
      values.push(normalizeOptionalObject(shippingQuote));
      nextIndex += 1;
      placeholders.push(`$${nextIndex}::jsonb`);
    }

    columns.push("created_at", "updated_at");
    placeholders.push("NOW()", "NOW()");

    await client.query(
      `
        INSERT INTO orders (${columns.join(", ")})
        VALUES (${placeholders.join(", ")})
      `,
      values
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
      shippingMethod: shippingMethod || null,
      shippingAmount: normalizedShippingAmount,
      shippingDetails: normalizeOptionalObject(shippingDetails),
      shippingQuote: normalizeOptionalObject(shippingQuote),
      totalAmount
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

async function getOrderRecordByStripeCheckoutSessionId(pool, stripeCheckoutSessionId) {
  if (
    typeof stripeCheckoutSessionId !== "string" ||
    !stripeCheckoutSessionId.trim()
  ) {
    return null;
  }

  const result = await pool.query(
    `
      SELECT id
      FROM orders
      WHERE stripe_checkout_session_id = $1
      LIMIT 1
    `,
    [stripeCheckoutSessionId.trim()]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return getOrderRecordById(pool, result.rows[0].id);
}

async function getOrderRecordById(pool, orderId) {
  const columnSupport = await getOrderColumnSupport(pool);
  const orderResult = await pool.query(
    `
      SELECT
        id,
        channel,
        status,
        currency,
        subtotal_amount,
        tax_amount,
        total_amount,
        stripe_checkout_session_id,
        ${
          columnSupport.hasShippingAmountColumns
            ? "shipping_method,\n        shipping_amount,"
            : "NULL::text AS shipping_method,\n        NULL::integer AS shipping_amount,"
        }
        ${
          columnSupport.hasShippingDetailsColumn
            ? "shipping_details,"
            : "NULL::jsonb AS shipping_details,"
        }
        ${
          columnSupport.hasShippingQuoteColumn
            ? "shipping_quote,"
            : "NULL::jsonb AS shipping_quote,"
        }
        created_at,
        updated_at
      FROM orders
      WHERE id = $1
      LIMIT 1
    `,
    [orderId]
  );

  if (orderResult.rowCount === 0) {
    return null;
  }

  const itemsResult = await pool.query(
    `
      SELECT
        product_id,
        sku,
        name,
        unit_amount,
        quantity,
        stripe_thumb_url
      FROM order_items
      WHERE order_id = $1
      ORDER BY created_at ASC, product_id ASC
    `,
    [orderId]
  );

  const order = orderResult.rows[0];

  return {
    id: order.id,
    channel: order.channel,
    status: order.status,
    currency: order.currency,
    subtotalAmount: Number(order.subtotal_amount),
    taxAmount: order.tax_amount === null ? null : Number(order.tax_amount),
    shippingMethod:
      typeof order.shipping_method === "string" && order.shipping_method.trim()
        ? order.shipping_method.trim()
        : null,
    shippingAmount:
      order.shipping_amount === null ? null : Number(order.shipping_amount),
    shippingDetails: normalizeOptionalObject(order.shipping_details),
    shippingQuote: normalizeOptionalObject(order.shipping_quote),
    totalAmount: Number(order.total_amount),
    stripeCheckoutSessionId:
      typeof order.stripe_checkout_session_id === "string" &&
      order.stripe_checkout_session_id.trim()
        ? order.stripe_checkout_session_id.trim()
        : null,
    createdAt: new Date(order.created_at).toISOString(),
    updatedAt: new Date(order.updated_at).toISOString(),
    items: itemsResult.rows.map((item) => ({
      productId: item.product_id,
      sku: item.sku,
      name: item.name,
      unitAmount: Number(item.unit_amount),
      quantity: Number(item.quantity),
      stripeThumbUrl:
        typeof item.stripe_thumb_url === "string" && item.stripe_thumb_url.trim()
          ? item.stripe_thumb_url.trim()
          : null
    }))
  };
}

async function getOrderById(pool, orderId) {
  const order = await getOrderRecordById(pool, orderId);
  if (!order) {
    return null;
  }

  const { stripeCheckoutSessionId, ...publicOrder } = order;
  return publicOrder;
}

async function cancelPendingOrder(pool, { orderId }) {
  const updateResult = await pool.query(
    `
      UPDATE orders
      SET
        status = 'canceled',
        updated_at = NOW()
      WHERE id = $1
        AND status = 'pending_payment'
      RETURNING id, status
    `,
    [orderId]
  );

  if (updateResult.rowCount > 0) {
    return {
      orderId,
      status: "canceled",
      changed: true
    };
  }

  const orderResult = await pool.query(
    `
      SELECT id, status
      FROM orders
      WHERE id = $1
      LIMIT 1
    `,
    [orderId]
  );

  if (orderResult.rowCount === 0) {
    throw withStatusError("Order not found", 404);
  }

  return {
    orderId,
    status: orderResult.rows[0].status,
    changed: false
  };
}

async function createPaidOrderFromCheckoutSession(
  pool,
  {
    cartSessionId,
    channel,
    currency,
    items,
    stripeCheckoutSessionId,
    stripePaymentIntentId,
    amountSubtotal,
    amountShipping,
    amountTax,
    amountTotal,
    shippingMethod
  }
) {
  if (!Array.isArray(items) || items.length === 0) {
    throw withStatusError("Checkout session did not contain any order items", 422);
  }

  const client = await pool.connect();
  const columnSupport = await getOrderColumnSupport(pool);

  try {
    await client.query("BEGIN");

    const existingResult = await client.query(
      `
        SELECT id, status
        FROM orders
        WHERE stripe_checkout_session_id = $1
        FOR UPDATE
      `,
      [stripeCheckoutSessionId]
    );

    if (existingResult.rowCount > 0) {
      const existingOrder = existingResult.rows[0];
      await client.query("COMMIT");
      return {
        orderId: existingOrder.id,
        alreadyPaid: existingOrder.status === "paid",
        committedCommissionIds: []
      };
    }

    const orderId = randomUUID();
    const committedCommissionIds = [];
    for (const item of items) {
      if (isCommissionOrderItem(item.productId)) {
        committedCommissionIds.push(item.productId);
      }
    }

    if (columnSupport.hasShippingAmountColumns) {
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
            shipping_method,
            shipping_amount,
            ${
              columnSupport.hasShippingDetailsColumn
                ? "shipping_details,"
                : ""
            }
            ${
              columnSupport.hasShippingQuoteColumn
                ? "shipping_quote,"
                : ""
            }
            stripe_checkout_session_id,
            stripe_payment_intent_id,
            created_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            $3,
            'paid',
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            ${
              columnSupport.hasShippingDetailsColumn
                ? "NULL,"
                : ""
            }
            ${
              columnSupport.hasShippingQuoteColumn
                ? "NULL,"
                : ""
            }
            $10,
            $11,
            NOW(),
            NOW()
          )
        `,
        [
          orderId,
          cartSessionId,
          channel,
          currency,
          normalizeOptionalInt(amountSubtotal) || 0,
          normalizeOptionalInt(amountTax),
          normalizeOptionalInt(amountTotal) || 0,
          shippingMethod || null,
          normalizeOptionalInt(amountShipping),
          stripeCheckoutSessionId,
          stripePaymentIntentId || null
        ]
      );
    } else {
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
            stripe_checkout_session_id,
            stripe_payment_intent_id,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, 'paid', $4, $5, $6, $7, $8, $9, NOW(), NOW())
        `,
        [
          orderId,
          cartSessionId,
          channel,
          currency,
          normalizeOptionalInt(amountSubtotal) || 0,
          normalizeOptionalInt(amountTax),
          normalizeOptionalInt(amountTotal) || 0,
          stripeCheckoutSessionId,
          stripePaymentIntentId || null
        ]
      );
    }

    const insertItemsQuery = buildInsertOrderItemsQuery(orderId, items);
    await client.query(insertItemsQuery.text, insertItemsQuery.values);

    for (const commissionId of committedCommissionIds) {
      await client.query(
        `
          UPDATE commissions
          SET status = 'customer_committed', updated_at = NOW()
          WHERE id = $1
        `,
        [commissionId]
      );
    }

    await client.query("COMMIT");
    return {
      orderId,
      alreadyPaid: false,
      committedCommissionIds
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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
    amountShipping,
    amountTax,
    amountTotal,
    shippingMethod
  }
) {
  const client = await pool.connect();
  const columnSupport = await getOrderColumnSupport(pool);

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

    const committedCommissionIds = [];

    for (const item of itemsResult.rows) {
      if (isCommissionOrderItem(item.product_id)) {
        committedCommissionIds.push(item.product_id);
      }
    }

    if (columnSupport.hasShippingAmountColumns) {
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
            shipping_amount = COALESCE($8, shipping_amount),
            shipping_method = COALESCE($9, shipping_method),
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
          stripePaymentIntentId || null,
          normalizeOptionalInt(amountShipping),
          shippingMethod || null
        ]
      );
    } else {
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
    }

    for (const commissionId of committedCommissionIds) {
      await client.query(
        `
          UPDATE commissions
          SET status = 'customer_committed', updated_at = NOW()
          WHERE id = $1
        `,
        [commissionId]
      );
    }

    await client.query("COMMIT");
    return {
      orderId,
      alreadyPaid: false,
      committedCommissionIds
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  cancelPendingOrder,
  createPaidOrderFromCheckoutSession,
  createPendingOrder,
  getOrderRecordById,
  getOrderRecordByStripeCheckoutSessionId,
  getOrderById,
  setOrderStripeCheckoutSessionId,
  markOrderPaidAndDecrementInventory
};
