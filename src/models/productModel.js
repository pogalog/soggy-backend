"use strict";

const { env } = require("../config/env");

const PRODUCT_BY_ID_SQL = `
  SELECT
    p.id,
    p.title,
    p.description,
    p.sell_price_cents,
    p.inventory_qty,
    p.created_at,
    p.updated_at,
    COALESCE(
      json_agg(
        json_build_object(
          'path', pi.path,
          'alt', pi.alt
        )
        ORDER BY pi.sort_order, pi.id
      ) FILTER (WHERE pi.id IS NOT NULL),
      '[]'::json
    ) AS images
  FROM products p
  LEFT JOIN product_images pi
    ON pi.product_id = p.id
  WHERE p.id = $1
  GROUP BY p.id
`;

const PRODUCT_INVENTORY_BY_IDS_SQL = `
  SELECT
    id,
    inventory_qty
  FROM products
  WHERE id = ANY($1::text[])
`;

const PRODUCTS_FOR_CHECKOUT_BY_IDS_SQL = `
  SELECT
    id,
    title,
    sell_price_cents,
    inventory_qty,
    stripe_thumb_url
  FROM products
  WHERE id = ANY($1::text[])
`;

function formatMoney(cents, currency) {
  const amount = Number(cents || 0);
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency
  });
  return formatter.format(amount / 100);
}

function mapProductRow(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    price: {
      amount: row.sell_price_cents,
      currency: env.priceCurrency,
      display: formatMoney(row.sell_price_cents, env.priceCurrency)
    },
    inventoryQty: row.inventory_qty,
    images: row.images || [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

async function getProductById(pool, productId) {
  const result = await pool.query(PRODUCT_BY_ID_SQL, [productId]);
  if (result.rowCount === 0) {
    return null;
  }

  return mapProductRow(result.rows[0]);
}

async function getProductInventoryByIds(pool, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return new Map();
  }

  const result = await pool.query(PRODUCT_INVENTORY_BY_IDS_SQL, [productIds]);
  return new Map(
    result.rows.map((row) => [row.id, Number(row.inventory_qty)])
  );
}

async function getProductsForCheckoutByIds(pool, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return new Map();
  }

  const result = await pool.query(PRODUCTS_FOR_CHECKOUT_BY_IDS_SQL, [productIds]);
  return new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        title: row.title,
        sellPriceCents: Number(row.sell_price_cents),
        inventoryQty: Number(row.inventory_qty),
        stripeThumbUrl:
          typeof row.stripe_thumb_url === "string" && row.stripe_thumb_url.trim()
            ? row.stripe_thumb_url.trim()
            : null
      }
    ])
  );
}

module.exports = {
  getProductById,
  getProductInventoryByIds,
  getProductsForCheckoutByIds
};
