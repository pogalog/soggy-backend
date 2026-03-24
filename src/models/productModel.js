"use strict";

const { env } = require("../config/env");
const { findFirstImageUrlInGcsPrefix } = require("../lib/gcsObjectClient");

const PRODUCT_BY_ID_SQL = `
  SELECT
    p.id,
    p.title,
    p.description,
    p.sell_price_cents,
    p.days_to_create,
    p.shipping_weight_lbs,
    p.shipping_length_in,
    p.shipping_width_in,
    p.shipping_height_in,
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

const PRODUCT_BY_ID_NO_SHIPPING_SQL = `
  SELECT
    p.id,
    p.title,
    p.description,
    p.sell_price_cents,
    p.days_to_create,
    NULL::numeric AS shipping_weight_lbs,
    NULL::numeric AS shipping_length_in,
    NULL::numeric AS shipping_width_in,
    NULL::numeric AS shipping_height_in,
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

const COMMISSION_PRODUCT_BY_ID_SQL = `
  SELECT
    id,
    item_name,
    item_description,
    commitment_deposit_amount,
    total_cost,
    status,
    requires_commit,
    storage_bucket,
    storage_images,
    created_at,
    updated_at
  FROM commissions
  WHERE id = $1
  LIMIT 1
`;

const PRODUCT_WORK_BY_IDS_SQL = `
  SELECT
    id,
    days_to_create
  FROM products
  WHERE id = ANY($1::text[])
`;

const PRODUCTS_FOR_CHECKOUT_BY_IDS_SQL = `
  SELECT
    id,
    title,
    sell_price_cents,
    days_to_create,
    shipping_weight_lbs,
    shipping_length_in,
    shipping_width_in,
    shipping_height_in,
    stripe_thumb_url
  FROM products
  WHERE id = ANY($1::text[])
`;

const PRODUCTS_FOR_CHECKOUT_BY_IDS_NO_THUMB_SQL = `
  SELECT
    id,
    title,
    sell_price_cents,
    days_to_create,
    shipping_weight_lbs,
    shipping_length_in,
    shipping_width_in,
    shipping_height_in,
    NULL::text AS stripe_thumb_url
  FROM products
  WHERE id = ANY($1::text[])
`;

const PRODUCTS_FOR_CHECKOUT_BY_IDS_NO_SHIPPING_SQL = `
  SELECT
    id,
    title,
    sell_price_cents,
    days_to_create,
    NULL::numeric AS shipping_weight_lbs,
    NULL::numeric AS shipping_length_in,
    NULL::numeric AS shipping_width_in,
    NULL::numeric AS shipping_height_in,
    stripe_thumb_url
  FROM products
  WHERE id = ANY($1::text[])
`;

const PRODUCTS_FOR_CHECKOUT_BY_IDS_NO_THUMB_OR_SHIPPING_SQL = `
  SELECT
    id,
    title,
    sell_price_cents,
    days_to_create,
    NULL::numeric AS shipping_weight_lbs,
    NULL::numeric AS shipping_length_in,
    NULL::numeric AS shipping_width_in,
    NULL::numeric AS shipping_height_in,
    NULL::text AS stripe_thumb_url
  FROM products
  WHERE id = ANY($1::text[])
`;

const COMMISSIONS_FOR_CHECKOUT_BY_IDS_SQL = `
  SELECT
    id,
    item_name,
    item_description,
    commitment_deposit_amount,
    total_cost,
    status,
    requires_commit,
    storage_bucket,
    storage_images,
    created_at,
    updated_at
  FROM commissions
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

function isCommissionProductId(productId) {
  return typeof productId === "string" && /^cm_[0-9a-f]+$/i.test(productId);
}

function canCheckoutCommissionRow(row) {
  if (!row || row.requires_commit !== true) {
    return false;
  }

  if (!Number.isInteger(Number(row.commitment_deposit_amount))) {
    return false;
  }

  return row.status !== "customer_cancelled" && row.status !== "customer_committed";
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
    kind: "product",
    daysToCreate: Number(row.days_to_create),
    shipping: mapShippingProfile(row),
    images: row.images || [],
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapCommissionRow(row) {
  return {
    id: row.id,
    title: `Commission commitment: ${row.item_name}`,
    description:
      typeof row.item_description === "string" && row.item_description.trim()
        ? row.item_description.trim()
        : `Commitment payment for commission ${row.id}`,
    price: {
      amount: Number(row.commitment_deposit_amount),
      currency: env.priceCurrency,
      display: formatMoney(row.commitment_deposit_amount, env.priceCurrency)
    },
    daysToCreate: 0,
    shipping: null,
    images: [],
    kind: "commission_commitment",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

let hasCheckedStripeThumbColumn = false;
let hasStripeThumbColumn = false;
const stripeThumbnailUrlCache = new Map();
let hasCheckedShippingColumns = false;
let hasShippingColumns = false;

function mapShippingProfile(row) {
  const weightLbs = Number(row.shipping_weight_lbs);
  const lengthIn = Number(row.shipping_length_in);
  const widthIn = Number(row.shipping_width_in);
  const heightIn = Number(row.shipping_height_in);

  const hasAllDimensions =
    Number.isFinite(lengthIn) &&
    lengthIn > 0 &&
    Number.isFinite(widthIn) &&
    widthIn > 0 &&
    Number.isFinite(heightIn) &&
    heightIn > 0;
  const hasWeight = Number.isFinite(weightLbs) && weightLbs > 0;

  if (!hasWeight && !hasAllDimensions) {
    return null;
  }

  return {
    weightLbs: hasWeight ? weightLbs : null,
    dimensionsIn: hasAllDimensions
      ? {
          length: lengthIn,
          width: widthIn,
          height: heightIn
        }
      : null,
    isShippable: hasWeight && hasAllDimensions
  };
}

async function productsHaveStripeThumbColumn(pool) {
  if (hasCheckedStripeThumbColumn) {
    return hasStripeThumbColumn;
  }

  const result = await pool.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'products'
        AND column_name = 'stripe_thumb_url'
      LIMIT 1
    `
  );

  hasCheckedStripeThumbColumn = true;
  hasStripeThumbColumn = result.rowCount > 0;
  return hasStripeThumbColumn;
}

async function productsHaveShippingColumns(pool) {
  if (hasCheckedShippingColumns) {
    return hasShippingColumns;
  }

  const result = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'products'
        AND column_name IN (
          'shipping_weight_lbs',
          'shipping_length_in',
          'shipping_width_in',
          'shipping_height_in'
        )
    `
  );

  const columnNames = new Set(result.rows.map((row) => row.column_name));
  hasCheckedShippingColumns = true;
  hasShippingColumns =
    columnNames.has("shipping_weight_lbs") &&
    columnNames.has("shipping_length_in") &&
    columnNames.has("shipping_width_in") &&
    columnNames.has("shipping_height_in");
  return hasShippingColumns;
}

async function resolveStripeThumbnailUrl(productId, persistedStripeThumbUrl) {
  if (typeof persistedStripeThumbUrl === "string" && persistedStripeThumbUrl.trim()) {
    return persistedStripeThumbUrl.trim();
  }

  if (stripeThumbnailUrlCache.has(productId)) {
    return stripeThumbnailUrlCache.get(productId);
  }

  try {
    const imageUrl = await findFirstImageUrlInGcsPrefix({
      bucketName: env.stripeThumbnailsGcsBucket,
      objectPrefix: productId
    });
    stripeThumbnailUrlCache.set(productId, imageUrl);
    return imageUrl;
  } catch (error) {
    console.warn("Unable to resolve Stripe thumbnail URL", {
      productId,
      bucketName: env.stripeThumbnailsGcsBucket,
      message: error instanceof Error ? error.message : String(error)
    });
    stripeThumbnailUrlCache.set(productId, null);
    return null;
  }
}

async function getProductById(pool, productId) {
  const includeShippingColumns = await productsHaveShippingColumns(pool);
  const result = await pool.query(
    includeShippingColumns ? PRODUCT_BY_ID_SQL : PRODUCT_BY_ID_NO_SHIPPING_SQL,
    [productId]
  );
  if (result.rowCount > 0) {
    return mapProductRow(result.rows[0]);
  }

  if (!isCommissionProductId(productId)) {
    return null;
  }

  const commissionResult = await pool.query(COMMISSION_PRODUCT_BY_ID_SQL, [productId]);
  if (commissionResult.rowCount === 0) {
    return null;
  }

  const commissionRow = commissionResult.rows[0];
  if (!canCheckoutCommissionRow(commissionRow)) {
    return null;
  }

  return mapCommissionRow(commissionRow);
}

async function getProductWorkByIds(pool, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return new Map();
  }

  const result = await pool.query(PRODUCT_WORK_BY_IDS_SQL, [productIds]);
  const workById = new Map(
    result.rows.map((row) => [row.id, Number(row.days_to_create)])
  );

  const commissionIds = productIds.filter((productId) => isCommissionProductId(productId));
  if (commissionIds.length === 0) {
    return workById;
  }

  const commissionResult = await pool.query(COMMISSIONS_FOR_CHECKOUT_BY_IDS_SQL, [commissionIds]);
  for (const row of commissionResult.rows) {
    if (canCheckoutCommissionRow(row)) {
      workById.set(row.id, 0);
    }
  }

  return workById;
}

async function getProductsForCheckoutByIds(pool, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return new Map();
  }

  const includeStripeThumbUrl = await productsHaveStripeThumbColumn(pool);
  const includeShippingColumns = await productsHaveShippingColumns(pool);
  const result = await pool.query(
    includeStripeThumbUrl
      ? includeShippingColumns
        ? PRODUCTS_FOR_CHECKOUT_BY_IDS_SQL
        : PRODUCTS_FOR_CHECKOUT_BY_IDS_NO_SHIPPING_SQL
      : includeShippingColumns
        ? PRODUCTS_FOR_CHECKOUT_BY_IDS_NO_THUMB_SQL
        : PRODUCTS_FOR_CHECKOUT_BY_IDS_NO_THUMB_OR_SHIPPING_SQL,
    [productIds]
  );
  const normalizedRows = await Promise.all(
    result.rows.map(async (row) => ({
      id: row.id,
      title: row.title,
      sellPriceCents: Number(row.sell_price_cents),
      daysToCreate: Number(row.days_to_create),
      stripeThumbUrl: await resolveStripeThumbnailUrl(row.id, row.stripe_thumb_url),
      shipping: mapShippingProfile(row),
      kind: "product"
    }))
  );
  const productsById = new Map(
    normalizedRows.map((row) => [row.id, row])
  );

  const commissionIds = productIds.filter((productId) => isCommissionProductId(productId));
  if (commissionIds.length === 0) {
    return productsById;
  }

  const commissionResult = await pool.query(COMMISSIONS_FOR_CHECKOUT_BY_IDS_SQL, [commissionIds]);
  for (const row of commissionResult.rows) {
    if (!canCheckoutCommissionRow(row)) {
      continue;
    }

    productsById.set(row.id, {
      id: row.id,
      title: `Commission commitment: ${row.item_name}`,
      sellPriceCents: Number(row.commitment_deposit_amount),
      daysToCreate: 0,
      stripeThumbUrl: null,
      kind: "commission_commitment"
    });
  }

  return productsById;
}

module.exports = {
  getProductById,
  getProductWorkByIds,
  getProductsForCheckoutByIds
};
