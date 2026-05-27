"use strict";

const { randomUUID } = require("node:crypto");
const { consumeReservationForOrder } = require("./workQueueModel");

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
    const base = index * 12;
    values.push(
      item.lineId || `ordln_${randomUUID()}`,
      orderId,
      item.productId,
      item.variantId || null,
      item.variantLabel || null,
      item.optionSummary || null,
      item.sku,
      item.name,
      item.unitAmount,
      item.quantity,
      item.stripeThumbUrl || null,
      Number.isFinite(Number(item.workUnits)) ? Number(item.workUnits) : 0
    );

    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`;
  });

  return {
    text: `
      INSERT INTO order_items (
        line_id,
        order_id,
        product_id,
        variant_id,
        variant_label,
        option_summary,
        sku,
        name,
        unit_amount,
        quantity,
        stripe_thumb_url,
        work_units
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
          ,'ship_by_date',
          'work_scheduled_at',
          'work_completed_at'
        )
    `
  );

  const columnNames = new Set(result.rows.map((row) => row.column_name));
  hasCheckedOrderShippingColumns = true;
  cachedOrderColumnSupport = {
    hasShippingAmountColumns:
      columnNames.has("shipping_method") && columnNames.has("shipping_amount"),
    hasShippingDetailsColumn: columnNames.has("shipping_details"),
    hasShippingQuoteColumn: columnNames.has("shipping_quote"),
    hasWorkQueueColumns:
      columnNames.has("ship_by_date") &&
      columnNames.has("work_scheduled_at") &&
      columnNames.has("work_completed_at")
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
    shippingQuote,
    shipByDate
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

    if (columnSupport.hasWorkQueueColumns && shipByDate) {
      columns.push("ship_by_date", "work_scheduled_at");
      values.push(shipByDate);
      nextIndex += 1;
      placeholders.push(`$${nextIndex}::date`, "NOW()");
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
      shipByDate: shipByDate || null,
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
        ${
          columnSupport.hasWorkQueueColumns
            ? "ship_by_date,\n        work_scheduled_at,\n        work_completed_at,"
            : "NULL::date AS ship_by_date,\n        NULL::timestamptz AS work_scheduled_at,\n        NULL::timestamptz AS work_completed_at,"
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
        line_id,
        product_id,
        variant_id,
        variant_label,
        option_summary,
        sku,
        name,
        unit_amount,
        quantity,
        stripe_thumb_url,
        work_units
      FROM order_items
      WHERE order_id = $1
      ORDER BY created_at ASC, line_id ASC
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
    shipByDate:
      order.ship_by_date === null || order.ship_by_date === undefined
        ? null
        : new Date(order.ship_by_date).toISOString().slice(0, 10),
    workScheduledAt:
      order.work_scheduled_at === null || order.work_scheduled_at === undefined
        ? null
        : new Date(order.work_scheduled_at).toISOString(),
    workCompletedAt:
      order.work_completed_at === null || order.work_completed_at === undefined
        ? null
        : new Date(order.work_completed_at).toISOString(),
    totalAmount: Number(order.total_amount),
    stripeCheckoutSessionId:
      typeof order.stripe_checkout_session_id === "string" &&
      order.stripe_checkout_session_id.trim()
        ? order.stripe_checkout_session_id.trim()
        : null,
    createdAt: new Date(order.created_at).toISOString(),
    updatedAt: new Date(order.updated_at).toISOString(),
    items: itemsResult.rows.map((item) => ({
      lineId: item.line_id,
      productId: item.product_id,
      variantId:
        typeof item.variant_id === "string" && item.variant_id.trim()
          ? item.variant_id.trim()
          : null,
      variantLabel:
        typeof item.variant_label === "string" && item.variant_label.trim()
          ? item.variant_label.trim()
          : null,
      optionSummary:
        typeof item.option_summary === "string" && item.option_summary.trim()
          ? item.option_summary.trim()
          : null,
      sku: item.sku,
      name: item.name,
      unitAmount: Number(item.unit_amount),
      quantity: Number(item.quantity),
      workUnits:
        item.work_units === null || item.work_units === undefined
          ? 0
          : Number(item.work_units),
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

async function markOrderCheckoutCancelled(pool, { orderId }) {
  const updateResult = await pool.query(
    `
      UPDATE orders
      SET
        status = 'checkout_cancelled',
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
      status: "checkout_cancelled",
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
    shippingMethod,
    shippingDetails
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
      const columns = [
        "id",
        "cart_session_id",
        "channel",
        "status",
        "currency",
        "subtotal_amount",
        "tax_amount",
        "total_amount",
        "shipping_method",
        "shipping_amount"
      ];
      const values = [
        orderId,
        cartSessionId,
        channel,
        currency,
        normalizeOptionalInt(amountSubtotal) || 0,
        normalizeOptionalInt(amountTax),
        normalizeOptionalInt(amountTotal) || 0,
        shippingMethod || null,
        normalizeOptionalInt(amountShipping)
      ];
      const placeholders = [
        "$1",
        "$2",
        "$3",
        "'paid'",
        "$4",
        "$5",
        "$6",
        "$7",
        "$8",
        "$9"
      ];
      let nextIndex = 9;

      if (columnSupport.hasShippingDetailsColumn) {
        columns.push("shipping_details");
        values.push(normalizeOptionalObject(shippingDetails));
        nextIndex += 1;
        placeholders.push(`$${nextIndex}::jsonb`);
      }

      if (columnSupport.hasShippingQuoteColumn) {
        columns.push("shipping_quote");
        values.push(null);
        nextIndex += 1;
        placeholders.push(`$${nextIndex}::jsonb`);
      }

      columns.push(
        "stripe_checkout_session_id",
        "stripe_payment_intent_id",
        "created_at",
        "updated_at"
      );
      values.push(stripeCheckoutSessionId, stripePaymentIntentId || null);
      nextIndex += 1;
      placeholders.push(`$${nextIndex}`);
      nextIndex += 1;
      placeholders.push(`$${nextIndex}`);
      placeholders.push("NOW()", "NOW()");

      await client.query(
        `
          INSERT INTO orders (${columns.join(", ")})
          VALUES (${placeholders.join(", ")})
        `,
        values
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

    await consumeReservationForOrder(client, {
      orderId,
      stripeCheckoutSessionId
    });

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
    shippingMethod,
    shippingDetails
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

    if (order.status !== "pending_payment" && order.status !== "checkout_cancelled") {
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
      const values = [
        orderId,
        currency || null,
        normalizeOptionalInt(amountSubtotal),
        normalizeOptionalInt(amountTax),
        normalizeOptionalInt(amountTotal),
        stripeCheckoutSessionId || null,
        stripePaymentIntentId || null,
        normalizeOptionalInt(amountShipping),
        shippingMethod || null
      ];
      let shippingDetailsPlaceholder = "";

      if (columnSupport.hasShippingDetailsColumn) {
        values.push(normalizeOptionalObject(shippingDetails));
        shippingDetailsPlaceholder =
          "shipping_details = COALESCE($10::jsonb, shipping_details),";
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
            shipping_amount = COALESCE($8, shipping_amount),
            shipping_method = COALESCE($9, shipping_method),
            ${shippingDetailsPlaceholder}
            updated_at = NOW()
          WHERE id = $1
        `,
        values
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

    await consumeReservationForOrder(client, {
      orderId,
      stripeCheckoutSessionId
    });

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
  markOrderCheckoutCancelled,
  setOrderStripeCheckoutSessionId,
  markOrderPaidAndDecrementInventory
};
