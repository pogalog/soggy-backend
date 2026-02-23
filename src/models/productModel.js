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

module.exports = {
  getProductById
};
