"use strict";

const { randomUUID } = require("node:crypto");

const SELECT_CART_BY_SESSION_SQL = `
  SELECT
    line_id,
    session_id,
    product_id,
    variant_id,
    variant_label,
    option_summary,
    quantity,
    last_updated
  FROM cart
  WHERE session_id = $1
  ORDER BY last_updated, line_id
`;

function toTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeVariantId(value) {
  const trimmed = toTrimmedString(value);
  return trimmed || null;
}

function mapCart(sessionId, rows) {
  if (!rows || rows.length === 0) {
    return {
      sessionId,
      items: [],
      lastUpdated: null
    };
  }

  let latest = new Date(0);
  const items = rows.map((row) => {
    const updatedAt = new Date(row.last_updated);
    if (updatedAt > latest) {
      latest = updatedAt;
    }

    return {
      lineId: row.line_id,
      productId: row.product_id,
      variantId: normalizeVariantId(row.variant_id),
      variantLabel: toTrimmedString(row.variant_label),
      optionSummary: toTrimmedString(row.option_summary),
      quantity: row.quantity,
      lastUpdated: updatedAt.toISOString()
    };
  });

  return {
    sessionId,
    items,
    lastUpdated: latest.toISOString()
  };
}

function buildInsertCartItemsQuery(sessionId, items) {
  const values = [];
  const placeholders = items.map((item, index) => {
    const base = index * 7;
    const lineId = toTrimmedString(item.lineId) || `cartln_${randomUUID()}`;
    const variantId = normalizeVariantId(item.variantId);
    values.push(
      lineId,
      sessionId,
      item.productId,
      variantId,
      toTrimmedString(item.variantLabel),
      toTrimmedString(item.optionSummary),
      item.quantity
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, NOW())`;
  });

  return {
    text: `
      INSERT INTO cart (
        line_id,
        session_id,
        product_id,
        variant_id,
        variant_label,
        option_summary,
        quantity,
        last_updated
      )
      VALUES ${placeholders.join(", ")}
    `,
    values
  };
}

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function getCartBySessionId(pool, sessionId) {
  const result = await pool.query(SELECT_CART_BY_SESSION_SQL, [sessionId]);
  return mapCart(sessionId, result.rows);
}

async function createCart(pool, { sessionId, items }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT 1 FROM cart WHERE session_id = $1 LIMIT 1",
      [sessionId]
    );
    if (existing.rowCount > 0) {
      throw withStatusError("Cart already exists for session", 409);
    }

    const insertQuery = buildInsertCartItemsQuery(sessionId, items);
    await client.query(insertQuery.text, insertQuery.values);

    const result = await client.query(SELECT_CART_BY_SESSION_SQL, [sessionId]);
    await client.query("COMMIT");
    return mapCart(sessionId, result.rows);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateCart(pool, { sessionId, items }) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM cart WHERE session_id = $1", [sessionId]);

    let cartRows = [];
    if (items.length > 0) {
      const insertQuery = buildInsertCartItemsQuery(sessionId, items);
      await client.query(insertQuery.text, insertQuery.values);
      const result = await client.query(SELECT_CART_BY_SESSION_SQL, [sessionId]);
      cartRows = result.rows;
    }

    await client.query("COMMIT");
    return mapCart(sessionId, cartRows);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteCart(pool, sessionId) {
  const result = await pool.query("DELETE FROM cart WHERE session_id = $1", [sessionId]);
  return {
    sessionId,
    deletedItems: result.rowCount
  };
}

module.exports = {
  createCart,
  getCartBySessionId,
  updateCart,
  deleteCart
};
