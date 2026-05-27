"use strict";

const { env } = require("../config/env");
const { findFirstImageUrlInGcsPrefix } = require("../lib/gcsObjectClient");

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

let hasCheckedProductSchemaSupport = false;
let cachedProductSchemaSupport = null;
const stripeThumbnailUrlCache = new Map();

function formatMoney(cents, currency) {
  const amount = Number(cents || 0);
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency
  });
  return formatter.format(amount / 100);
}

function formatSignedMoney(cents, currency) {
  const amount = Number(cents || 0);
  if (amount === 0) {
    return formatMoney(0, currency);
  }

  return `${amount > 0 ? "+" : "-"}${formatMoney(Math.abs(amount), currency)}`;
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

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIsoString(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function trimString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildPrice(amount, currency, extras = {}) {
  const normalizedAmount = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  const normalizedCurrency =
    typeof currency === "string" && currency.trim() ? currency.trim() : env.priceCurrency;
  const price = {
    amount: normalizedAmount,
    currency: normalizedCurrency,
    display: formatMoney(normalizedAmount, normalizedCurrency)
  };

  const normalizedCompareAtAmount = toFiniteNumber(extras.compareAtAmount);
  if (normalizedCompareAtAmount !== null) {
    price.compareAtAmount = normalizedCompareAtAmount;
    price.compareAtDisplay = formatMoney(price.compareAtAmount, normalizedCurrency);
  }

  if (extras.includeSignedDisplay === true) {
    price.signedDisplay = formatSignedMoney(normalizedAmount, normalizedCurrency);
  }

  return price;
}

function buildLeadTime(row) {
  const min = toFiniteNumber(row.lead_time_days_min);
  const max = toFiniteNumber(row.lead_time_days_max);
  if (min === null && max === null) {
    return null;
  }

  return {
    min,
    max
  };
}

function mapShippingProfile(row) {
  const canonicalWeightOz = toFiniteNumber(row.weight_oz);
  const legacyWeightLbs = toFiniteNumber(row.shipping_weight_lbs);
  const canonicalLengthIn = toFiniteNumber(row.length_in);
  const canonicalWidthIn = toFiniteNumber(row.width_in);
  const canonicalHeightIn = toFiniteNumber(row.height_in);
  const legacyLengthIn = toFiniteNumber(row.shipping_length_in);
  const legacyWidthIn = toFiniteNumber(row.shipping_width_in);
  const legacyHeightIn = toFiniteNumber(row.shipping_height_in);

  const weightOz =
    canonicalWeightOz !== null && canonicalWeightOz > 0
      ? canonicalWeightOz
      : legacyWeightLbs !== null && legacyWeightLbs > 0
        ? Math.round(legacyWeightLbs * 16 * 100) / 100
        : null;
  const weightLbs =
    weightOz !== null
      ? Math.round((weightOz / 16) * 1000) / 1000
      : legacyWeightLbs !== null && legacyWeightLbs > 0
        ? legacyWeightLbs
        : null;

  const lengthIn =
    canonicalLengthIn !== null && canonicalLengthIn > 0 ? canonicalLengthIn : legacyLengthIn;
  const widthIn =
    canonicalWidthIn !== null && canonicalWidthIn > 0 ? canonicalWidthIn : legacyWidthIn;
  const heightIn =
    canonicalHeightIn !== null && canonicalHeightIn > 0 ? canonicalHeightIn : legacyHeightIn;

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
    weightOz: hasWeight && weightOz !== null ? weightOz : null,
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

function mapSafetyNotice(row) {
  const id = row.safety_id;
  const message = trimString(row.safety_message);
  const displayType = trimString(row.safety_display_type);

  if (!id || !message || (displayType !== "embedded" && displayType !== "cart_add")) {
    return null;
  }

  return {
    id: String(id),
    message,
    displayType
  };
}

function mapCategory(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    id: String(raw.id),
    slug: trimString(raw.slug) || String(raw.id),
    name: trimString(raw.name) || String(raw.id),
    isPrimary: raw.isPrimary === true
  };
}

function mapTag(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    id: String(raw.id),
    slug: trimString(raw.slug) || String(raw.id),
    name: trimString(raw.name) || String(raw.id)
  };
}

function mapAttribute(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const enumValue =
    raw.enumValue && typeof raw.enumValue === "object"
      ? {
          id: String(raw.enumValue.id),
          value: trimString(raw.enumValue.value) || String(raw.enumValue.id)
        }
      : null;

  return {
    id: String(raw.id),
    code: trimString(raw.code) || String(raw.id),
    name: trimString(raw.name) || trimString(raw.code) || String(raw.id),
    dataType: trimString(raw.dataType) || "text",
    displayValue: trimString(raw.displayValue) || "",
    valueText: trimString(raw.valueText),
    valueNumber: toFiniteNumber(raw.valueNumber),
    valueBoolean: typeof raw.valueBoolean === "boolean" ? raw.valueBoolean : null,
    enumValue
  };
}

function mapOptionValue(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    id: String(raw.id),
    value: trimString(raw.value) || String(raw.id),
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : 0
  };
}

function mapOption(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  return {
    id: String(raw.id),
    name: trimString(raw.name) || String(raw.id),
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : 0,
    values: readJsonArray(raw.values)
      .map(mapOptionValue)
      .filter(Boolean)
  };
}

function mapVariant(raw, basePriceCents, currency) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const priceDeltaCents = Number.isFinite(Number(raw.priceDeltaCents))
    ? Number(raw.priceDeltaCents)
    : 0;
  const effectivePriceCents = basePriceCents + priceDeltaCents;
  const optionSelections = readJsonArray(raw.optionSelections)
    .map((selection) => {
      if (!selection || typeof selection !== "object") {
        return null;
      }

      return {
        optionId: String(selection.optionId),
        optionName: trimString(selection.optionName) || String(selection.optionId),
        optionValueId: String(selection.optionValueId),
        value: trimString(selection.value) || String(selection.optionValueId)
      };
    })
    .filter(Boolean);

  return {
    id: String(raw.id),
    sku: trimString(raw.sku),
    title: trimString(raw.title),
    inventoryQty: toFiniteNumber(raw.inventoryQty),
    sortOrder: Number.isFinite(Number(raw.sortOrder)) ? Number(raw.sortOrder) : 0,
    isDefault: raw.isDefault === true,
    isVisible: raw.isVisible !== false,
    stripePriceId: trimString(raw.stripePriceId),
    createdAt: toIsoString(raw.createdAt),
    updatedAt: toIsoString(raw.updatedAt),
    optionSelections,
    optionValueIds: optionSelections.map((selection) => selection.optionValueId),
    priceDelta: buildPrice(priceDeltaCents, currency, { includeSignedDisplay: true }),
    price: buildPrice(effectivePriceCents, currency),
    shipping: mapShippingProfile({
      weight_oz: raw.weightOz,
      length_in: raw.lengthIn,
      width_in: raw.widthIn,
      height_in: raw.heightIn
    })
  };
}

function mapProductRow(row) {
  const currency = trimString(row.currency) || env.priceCurrency;
  const priceAmount = Number.isFinite(Number(row.base_price_cents))
    ? Number(row.base_price_cents)
    : Number(row.sell_price_cents || 0);
  const compareAtAmount = toFiniteNumber(row.compare_at_price_cents);
  const categories = readJsonArray(row.categories).map(mapCategory).filter(Boolean);
  const tags = readJsonArray(row.tags).map(mapTag).filter(Boolean);
  const attributes = readJsonArray(row.attributes).map(mapAttribute).filter(Boolean);
  const options = readJsonArray(row.options).map(mapOption).filter(Boolean);
  const variants = readJsonArray(row.variants)
    .map((variant) => mapVariant(variant, priceAmount, currency))
    .filter(Boolean);
  const leadTime = buildLeadTime(row);

  return {
    id: row.id,
    slug: trimString(row.slug),
    title: row.title,
    subtitle: trimString(row.subtitle),
    description: row.description,
    status: trimString(row.status) || "active",
    productKind: trimString(row.product_kind) || "repeatable",
    availabilityMode: trimString(row.availability_mode) || "made_to_order",
    kind: "product",
    price: buildPrice(priceAmount, currency, { compareAtAmount }),
    daysToCreate:
      leadTime && Number.isFinite(leadTime.max)
        ? leadTime.max
        : Number.isFinite(Number(row.days_to_create))
          ? Number(row.days_to_create)
          : 0,
    leadTimeDays: leadTime,
    shipping: mapShippingProfile(row),
    safety: mapSafetyNotice(row),
    images: readJsonArray(row.images),
    categories,
    tags,
    attributes,
    options,
    variants,
    hasVariants: variants.length > 0 || options.length > 0,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapCommissionRow(row) {
  return {
    id: row.id,
    slug: null,
    title: `Commission commitment: ${row.item_name}`,
    subtitle: null,
    description:
      typeof row.item_description === "string" && row.item_description.trim()
        ? row.item_description.trim()
        : `Commitment payment for commission ${row.id}`,
    status: row.status,
    productKind: "commission_template",
    availabilityMode: "made_to_order",
    price: buildPrice(Number(row.commitment_deposit_amount), env.priceCurrency),
    daysToCreate: 0,
    leadTimeDays: {
      min: 0,
      max: 0
    },
    shipping: null,
    images: [],
    categories: [],
    tags: [],
    attributes: [],
    options: [],
    variants: [],
    hasVariants: false,
    kind: "commission_commitment",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

async function getProductSchemaSupport(pool) {
  if (hasCheckedProductSchemaSupport && cachedProductSchemaSupport) {
    return cachedProductSchemaSupport;
  }

  const productColumns = [
    "slug",
    "subtitle",
    "status",
    "product_kind",
    "availability_mode",
    "base_price_cents",
    "compare_at_price_cents",
    "currency",
    "search_title",
    "search_description",
    "is_visible",
    "weight_oz",
    "length_in",
    "width_in",
    "height_in",
    "lead_time_days_min",
    "lead_time_days_max",
    "stripe_product_id",
    "stripe_tax_code",
    "safety_id",
    "stripe_thumb_url",
    "shipping_weight_lbs",
    "shipping_length_in",
    "shipping_width_in",
    "shipping_height_in"
  ];
  const tableNames = [
    "product_images",
    "safety",
    "categories",
    "product_categories",
    "tags",
    "product_tags",
    "product_options",
    "product_option_values",
    "product_variants",
    "variant_option_values",
    "attributes",
    "attribute_values",
    "product_attribute_values"
  ];

  const [columnResult, tableResult, extensionResult] = await Promise.all([
    pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'products'
          AND column_name = ANY($1::text[])
      `,
      [productColumns]
    ),
    pool.query(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
      `,
      [tableNames]
    ),
    pool.query(
      `
        SELECT to_regproc('similarity(text,text)') IS NOT NULL AS has_pg_trgm
      `
    )
  ]);

  const columns = new Set(columnResult.rows.map((row) => row.column_name));
  const tables = new Set(tableResult.rows.map((row) => row.table_name));

  cachedProductSchemaSupport = {
    hasSlug: columns.has("slug"),
    hasSubtitle: columns.has("subtitle"),
    hasStatus: columns.has("status"),
    hasProductKind: columns.has("product_kind"),
    hasAvailabilityMode: columns.has("availability_mode"),
    hasBasePrice: columns.has("base_price_cents"),
    hasCompareAtPrice: columns.has("compare_at_price_cents"),
    hasCurrency: columns.has("currency"),
    hasSearchTitle: columns.has("search_title"),
    hasSearchDescription: columns.has("search_description"),
    hasVisible: columns.has("is_visible"),
    hasCanonicalShipping:
      columns.has("weight_oz") &&
      columns.has("length_in") &&
      columns.has("width_in") &&
      columns.has("height_in"),
    hasCanonicalLeadTime:
      columns.has("lead_time_days_min") && columns.has("lead_time_days_max"),
    hasStripeThumb: columns.has("stripe_thumb_url"),
    hasLegacyShipping:
      columns.has("shipping_weight_lbs") &&
      columns.has("shipping_length_in") &&
      columns.has("shipping_width_in") &&
      columns.has("shipping_height_in"),
    hasSafety: columns.has("safety_id") && tables.has("safety"),
    hasImages: tables.has("product_images"),
    hasCategories: tables.has("categories") && tables.has("product_categories"),
    hasTags: tables.has("tags") && tables.has("product_tags"),
    hasOptions: tables.has("product_options") && tables.has("product_option_values"),
    hasVariants: tables.has("product_variants") && tables.has("variant_option_values"),
    hasAttributes:
      tables.has("attributes") &&
      tables.has("attribute_values") &&
      tables.has("product_attribute_values"),
    hasPgTrgm: extensionResult.rows[0]?.has_pg_trgm === true
  };
  hasCheckedProductSchemaSupport = true;
  return cachedProductSchemaSupport;
}

function buildProductByIdSql(support) {
  const lookupPredicate = support.hasSlug ? "(p.id = $1 OR p.slug = $1)" : "p.id = $1";

  return `
    SELECT
      p.id,
      ${support.hasSlug ? "p.slug" : "NULL::text AS slug"},
      p.title,
      ${support.hasSubtitle ? "p.subtitle" : "NULL::text AS subtitle"},
      p.description,
      ${support.hasStatus ? "p.status" : "'active'::text AS status"},
      ${support.hasProductKind ? "p.product_kind" : "'repeatable'::text AS product_kind"},
      ${
        support.hasAvailabilityMode
          ? "p.availability_mode"
          : `
      CASE
        WHEN COALESCE(p.days_to_create, 0) > 0 THEN 'made_to_order'
        ELSE 'ready_to_ship'
      END AS availability_mode`
      },
      ${
        support.hasBasePrice
          ? "p.base_price_cents"
          : "p.sell_price_cents AS base_price_cents"
      },
      ${
        support.hasCompareAtPrice
          ? "p.compare_at_price_cents"
          : "NULL::integer AS compare_at_price_cents"
      },
      ${support.hasCurrency ? "p.currency" : "NULL::text AS currency"},
      p.sell_price_cents,
      p.days_to_create,
      ${
        support.hasCanonicalLeadTime
          ? `
      p.lead_time_days_min,
      p.lead_time_days_max,`
          : `
      p.days_to_create AS lead_time_days_min,
      p.days_to_create AS lead_time_days_max,`
      }
      ${
        support.hasCanonicalShipping
          ? `
      p.weight_oz,
      p.length_in,
      p.width_in,
      p.height_in,`
          : `
      NULL::numeric AS weight_oz,
      NULL::numeric AS length_in,
      NULL::numeric AS width_in,
      NULL::numeric AS height_in,`
      }
      ${
        support.hasLegacyShipping
          ? `
      p.shipping_weight_lbs,
      p.shipping_length_in,
      p.shipping_width_in,
      p.shipping_height_in,`
          : `
      NULL::numeric AS shipping_weight_lbs,
      NULL::numeric AS shipping_length_in,
      NULL::numeric AS shipping_width_in,
      NULL::numeric AS shipping_height_in,`
      }
      ${
        support.hasSafety
          ? `
      s.id AS safety_id,
      s.message AS safety_message,
      s.display_type AS safety_display_type,`
          : `
      NULL::bigint AS safety_id,
      NULL::text AS safety_message,
      NULL::text AS safety_display_type,`
      }
      img.images,
      cat.categories,
      tag.tags,
      attr.attributes,
      opt.options,
      var.variants,
      p.created_at,
      p.updated_at
    FROM products p
    ${
      support.hasSafety
        ? `
    LEFT JOIN safety s
      ON s.id = p.safety_id`
        : ""
    }
    LEFT JOIN LATERAL (
      ${
        support.hasImages
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'path', pi.path,
            'alt', pi.alt
          )
          ORDER BY pi.sort_order, pi.id
        ),
        '[]'::json
      ) AS images
      FROM product_images pi
      WHERE pi.product_id = p.id`
          : `
      SELECT '[]'::json AS images`
      }
    ) img ON TRUE
    LEFT JOIN LATERAL (
      ${
        support.hasCategories
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', c.id,
            'slug', c.slug,
            'name', c.name,
            'isPrimary', pc.is_primary
          )
          ORDER BY pc.is_primary DESC, pc.sort_order, c.sort_order, c.name
        ),
        '[]'::json
      ) AS categories
      FROM product_categories pc
      JOIN categories c
        ON c.id = pc.category_id
      WHERE pc.product_id = p.id
        AND c.is_visible = true`
          : `
      SELECT '[]'::json AS categories`
      }
    ) cat ON TRUE
    LEFT JOIN LATERAL (
      ${
        support.hasTags
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', t.id,
            'slug', t.slug,
            'name', t.name
          )
          ORDER BY t.name
        ),
        '[]'::json
      ) AS tags
      FROM product_tags pt
      JOIN tags t
        ON t.id = pt.tag_id
      WHERE pt.product_id = p.id`
          : `
      SELECT '[]'::json AS tags`
      }
    ) tag ON TRUE
    LEFT JOIN LATERAL (
      ${
        support.hasAttributes
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', a.id,
            'code', a.code,
            'name', a.name,
            'dataType', a.data_type,
            'displayValue',
              CASE
                WHEN a.data_type = 'enum' THEN av.value_text
                WHEN a.data_type = 'number' THEN pav.value_number::text
                WHEN a.data_type = 'boolean' THEN CASE WHEN pav.value_boolean THEN 'Yes' ELSE 'No' END
                ELSE pav.value_text
              END,
            'valueText', pav.value_text,
            'valueNumber', pav.value_number,
            'valueBoolean', pav.value_boolean,
            'enumValue',
              CASE
                WHEN av.id IS NULL THEN NULL
                ELSE json_build_object(
                  'id', av.id,
                  'value', av.value_text
                )
              END
          )
          ORDER BY a.sort_order, a.name
        ),
        '[]'::json
      ) AS attributes
      FROM product_attribute_values pav
      JOIN attributes a
        ON a.id = pav.attribute_id
      LEFT JOIN attribute_values av
        ON av.id = pav.attribute_value_id
      WHERE pav.product_id = p.id
        AND a.is_visible = true`
          : `
      SELECT '[]'::json AS attributes`
      }
    ) attr ON TRUE
    LEFT JOIN LATERAL (
      ${
        support.hasOptions
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', po.id,
            'name', po.name,
            'sortOrder', po.sort_order,
            'values', (
              SELECT COALESCE(
                json_agg(
                  json_build_object(
                    'id', pov.id,
                    'value', pov.value,
                    'sortOrder', pov.sort_order
                  )
                  ORDER BY pov.sort_order, pov.value
                ),
                '[]'::json
              )
              FROM product_option_values pov
              WHERE pov.option_id = po.id
            )
          )
          ORDER BY po.sort_order, po.name
        ),
        '[]'::json
      ) AS options
      FROM product_options po
      WHERE po.product_id = p.id`
          : `
      SELECT '[]'::json AS options`
      }
    ) opt ON TRUE
    LEFT JOIN LATERAL (
      ${
        support.hasVariants
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', pv.id,
            'sku', pv.sku,
            'title', pv.title,
            'priceDeltaCents', pv.price_delta_cents,
            'inventoryQty', pv.inventory_qty,
            'weightOz', pv.weight_oz,
            'lengthIn', pv.length_in,
            'widthIn', pv.width_in,
            'heightIn', pv.height_in,
            'sortOrder', pv.sort_order,
            'isDefault', pv.is_default,
            'isVisible', pv.is_visible,
            'stripePriceId', pv.stripe_price_id,
            'createdAt', pv.created_at,
            'updatedAt', pv.updated_at,
            'optionSelections', (
              SELECT COALESCE(
                json_agg(
                  json_build_object(
                    'optionId', po.id,
                    'optionName', po.name,
                    'optionValueId', pov.id,
                    'value', pov.value
                  )
                  ORDER BY po.sort_order, pov.sort_order, pov.value
                ),
                '[]'::json
              )
              FROM variant_option_values vov
              JOIN product_options po
                ON po.id = vov.option_id
              JOIN product_option_values pov
                ON pov.id = vov.option_value_id
              WHERE vov.variant_id = pv.id
            )
          )
          ORDER BY pv.sort_order, pv.created_at, pv.id
        ),
        '[]'::json
      ) AS variants
      FROM product_variants pv
      WHERE pv.product_id = p.id
        AND pv.is_visible = true`
          : `
      SELECT '[]'::json AS variants`
      }
    ) var ON TRUE
    WHERE ${lookupPredicate}
    ORDER BY CASE WHEN p.id = $1 THEN 0 ELSE 1 END
    LIMIT 1
  `;
}

function buildHasVariantsSqlExpression(support, productAlias = "p") {
  const checks = [];

  if (support.hasOptions) {
    checks.push(
      `EXISTS (
        SELECT 1
        FROM product_options po
        WHERE po.product_id = ${productAlias}.id
      )`
    );
  }

  if (support.hasVariants) {
    checks.push(
      `EXISTS (
        SELECT 1
        FROM product_variants pv
        WHERE pv.product_id = ${productAlias}.id
      )`
    );
  }

  return checks.length > 0 ? `(${checks.join(" OR ")})` : "FALSE";
}

function buildProductCartStateByIdsSql(support) {
  return `
    SELECT
      p.id,
      ${
        support.hasCanonicalLeadTime
          ? "COALESCE(p.lead_time_days_max, p.days_to_create) AS days_to_create"
          : "p.days_to_create"
      },
      ${buildHasVariantsSqlExpression(support, "p")} AS has_variants
    FROM products p
    WHERE p.id = ANY($1::text[])
  `;
}

function buildProductsForCheckoutByIdsSql(support) {
  return `
    SELECT
      p.id,
      p.title,
      ${support.hasCurrency ? "p.currency" : "NULL::text AS currency"},
      ${
        support.hasBasePrice
          ? "COALESCE(p.base_price_cents, p.sell_price_cents) AS sell_price_cents"
          : "p.sell_price_cents"
      },
      ${
        support.hasCanonicalLeadTime
          ? "COALESCE(p.lead_time_days_max, p.days_to_create) AS days_to_create"
          : "p.days_to_create"
      },
      ${
        support.hasCanonicalShipping
          ? `
      ${
        support.hasLegacyShipping
          ? `
      COALESCE(ROUND((p.weight_oz / 16.0)::numeric, 4), p.shipping_weight_lbs) AS shipping_weight_lbs,
      COALESCE(p.length_in, p.shipping_length_in) AS shipping_length_in,
      COALESCE(p.width_in, p.shipping_width_in) AS shipping_width_in,
      COALESCE(p.height_in, p.shipping_height_in) AS shipping_height_in,`
          : `
      ROUND((p.weight_oz / 16.0)::numeric, 4) AS shipping_weight_lbs,
      p.length_in AS shipping_length_in,
      p.width_in AS shipping_width_in,
      p.height_in AS shipping_height_in,`
      }`
          : support.hasLegacyShipping
            ? `
      p.shipping_weight_lbs,
      p.shipping_length_in,
      p.shipping_width_in,
      p.shipping_height_in,`
            : `
      NULL::numeric AS shipping_weight_lbs,
      NULL::numeric AS shipping_length_in,
      NULL::numeric AS shipping_width_in,
      NULL::numeric AS shipping_height_in,`
      }
      ${
        support.hasStripeThumb
          ? "p.stripe_thumb_url"
          : "NULL::text AS stripe_thumb_url"
      },
      ${buildHasVariantsSqlExpression(support, "p")} AS has_variants,
      var.variants
    FROM products p
    LEFT JOIN LATERAL (
      ${
        support.hasVariants
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', pv.id,
            'sku', pv.sku,
            'title', pv.title,
            'priceDeltaCents', pv.price_delta_cents,
            'inventoryQty', pv.inventory_qty,
            'weightOz', pv.weight_oz,
            'lengthIn', pv.length_in,
            'widthIn', pv.width_in,
            'heightIn', pv.height_in,
            'sortOrder', pv.sort_order,
            'isDefault', pv.is_default,
            'isVisible', pv.is_visible,
            'stripePriceId', pv.stripe_price_id,
            'createdAt', pv.created_at,
            'updatedAt', pv.updated_at,
            'optionSelections', (
              SELECT COALESCE(
                json_agg(
                  json_build_object(
                    'optionId', po.id,
                    'optionName', po.name,
                    'optionValueId', pov.id,
                    'value', pov.value
                  )
                  ORDER BY po.sort_order, pov.sort_order, pov.value
                ),
                '[]'::json
              )
              FROM variant_option_values vov
              JOIN product_options po
                ON po.id = vov.option_id
              JOIN product_option_values pov
                ON pov.id = vov.option_value_id
              WHERE vov.variant_id = pv.id
            )
          )
          ORDER BY pv.sort_order, pv.created_at, pv.id
        ),
        '[]'::json
      ) AS variants
      FROM product_variants pv
      WHERE pv.product_id = p.id`
          : `
      SELECT '[]'::json AS variants`
      }
    ) var ON TRUE
    WHERE p.id = ANY($1::text[])
  `;
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
  const support = await getProductSchemaSupport(pool);
  const result = await pool.query(buildProductByIdSql(support), [productId]);
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

function normalizeCatalogLimit(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) {
    return 24;
  }

  return Math.min(48, Math.max(1, parsed));
}

function normalizeCatalogSort(sort, query) {
  const normalized = trimString(sort);
  const allowed = new Set(["relevance", "newest", "price_asc", "price_desc", "lead_time", "name"]);
  if (normalized && allowed.has(normalized)) {
    return normalized === "relevance" && !trimString(query) ? "newest" : normalized;
  }

  return trimString(query) ? "relevance" : "newest";
}

function encodeCatalogCursor(row, sort) {
  let key = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  if (sort === "price_asc" || sort === "price_desc") {
    key = Number(row.price_cents);
  } else if (sort === "lead_time") {
    key = Number(row.lead_time_max);
  } else if (sort === "name") {
    key = trimString(row.sort_title) || "";
  } else if (sort === "relevance") {
    key = Number(row.search_rank || 0);
  }

  return Buffer.from(
    JSON.stringify({
      sort,
      id: String(row.id),
      key,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
    })
  ).toString("base64url");
}

function decodeCatalogCursor(cursor, sort) {
  if (!trimString(cursor)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!decoded || decoded.sort !== sort || !decoded.id) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function mapProductCardRow(row) {
  const currency = trimString(row.currency) || env.priceCurrency;
  const priceAmount = Number.isFinite(Number(row.base_price_cents))
    ? Number(row.base_price_cents)
    : Number(row.sell_price_cents || 0);
  const leadTime = buildLeadTime(row);

  return {
    id: row.id,
    slug: trimString(row.slug),
    title: row.title,
    subtitle: trimString(row.subtitle),
    status: trimString(row.status) || "active",
    productKind: trimString(row.product_kind) || "repeatable",
    availabilityMode: trimString(row.availability_mode) || "made_to_order",
    kind: "product",
    price: buildPrice(priceAmount, currency, {
      compareAtAmount: toFiniteNumber(row.compare_at_price_cents)
    }),
    daysToCreate:
      leadTime && Number.isFinite(leadTime.max)
        ? leadTime.max
        : Number.isFinite(Number(row.days_to_create))
          ? Number(row.days_to_create)
          : 0,
    leadTimeDays: leadTime,
    images: readJsonArray(row.images),
    categories: readJsonArray(row.categories).map(mapCategory).filter(Boolean),
    tags: readJsonArray(row.tags).map(mapTag).filter(Boolean),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function buildPriceCentsExpression(support, alias = "p") {
  return support.hasBasePrice
    ? `COALESCE(${alias}.base_price_cents, ${alias}.sell_price_cents)`
    : `${alias}.sell_price_cents`;
}

function buildLeadTimeMaxExpression(support, alias = "p") {
  return support.hasCanonicalLeadTime
    ? `COALESCE(${alias}.lead_time_days_max, ${alias}.days_to_create)`
    : `${alias}.days_to_create`;
}

function buildActiveProductPredicates(support, alias = "p") {
  const predicates = [];
  if (support.hasStatus) {
    predicates.push(`${alias}.status = 'active'`);
  }
  if (support.hasVisible) {
    predicates.push(`${alias}.is_visible = true`);
  }
  return predicates;
}

function splitCatalogList(value) {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : String(value).split(",");
  return values
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function tokenizeCatalogQuery(query) {
  return trimString(query)
    ? trimString(query)
        .toLowerCase()
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean)
        .slice(0, 8)
    : [];
}

function buildProductCardSelectSql(support) {
  return `
    p.id,
    ${support.hasSlug ? "p.slug" : "NULL::text AS slug"},
    p.title,
    ${support.hasSubtitle ? "p.subtitle" : "NULL::text AS subtitle"},
    ${support.hasStatus ? "p.status" : "'active'::text AS status"},
    ${support.hasProductKind ? "p.product_kind" : "'repeatable'::text AS product_kind"},
    ${support.hasAvailabilityMode ? "p.availability_mode" : "'made_to_order'::text AS availability_mode"},
    ${buildPriceCentsExpression(support, "p")} AS base_price_cents,
    ${support.hasCompareAtPrice ? "p.compare_at_price_cents" : "NULL::integer AS compare_at_price_cents"},
    ${support.hasCurrency ? "p.currency" : "NULL::text AS currency"},
    p.sell_price_cents,
    p.days_to_create,
    ${
      support.hasCanonicalLeadTime
        ? "p.lead_time_days_min, p.lead_time_days_max,"
        : "p.days_to_create AS lead_time_days_min, p.days_to_create AS lead_time_days_max,"
    }
    img.images,
    cat.categories,
    tag.tags,
    p.created_at,
    p.updated_at
  `;
}

function buildCatalogLateralJoins(support, trgmQueryParam) {
  return `
    LEFT JOIN LATERAL (
      ${
        support.hasImages
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'path', pi.path,
            'alt', pi.alt
          )
          ORDER BY pi.sort_order, pi.id
        ),
        '[]'::json
      ) AS images
      FROM product_images pi
      WHERE pi.product_id = p.id`
          : "SELECT '[]'::json AS images"
      }
    ) img ON TRUE
    LEFT JOIN LATERAL (
      ${
        support.hasCategories
          ? `
      SELECT COALESCE(
        json_agg(
          json_build_object(
            'id', c.id,
            'slug', c.slug,
            'name', c.name,
            'isPrimary', pc.is_primary
          )
          ORDER BY pc.is_primary DESC, pc.sort_order, c.sort_order, c.name
        ),
        '[]'::json
      ) AS categories
      FROM product_categories pc
      JOIN categories c
        ON c.id = pc.category_id
      WHERE pc.product_id = p.id
        AND c.is_visible = true`
          : "SELECT '[]'::json AS categories"
      }
    ) cat ON TRUE
    LEFT JOIN LATERAL (
      ${
        support.hasTags
          ? `
      SELECT
        COALESCE(
          json_agg(
            json_build_object(
              'id', t.id,
              'slug', t.slug,
              'name', t.name
            )
            ORDER BY t.name
          ),
          '[]'::json
        ) AS tags,
        lower(COALESCE(string_agg(t.name || ' ' || t.slug, ' '), '')) AS tag_text
        ${
          support.hasPgTrgm && trgmQueryParam
            ? `,
        COALESCE(MAX(GREATEST(similarity(lower(t.name), ${trgmQueryParam}::text), similarity(lower(t.slug), ${trgmQueryParam}::text))), 0) AS tag_similarity`
            : `,
        0::numeric AS tag_similarity`
        }
      FROM product_tags pt
      JOIN tags t
        ON t.id = pt.tag_id
      WHERE pt.product_id = p.id`
          : "SELECT '[]'::json AS tags, ''::text AS tag_text, 0::numeric AS tag_similarity"
      }
    ) tag ON TRUE
  `;
}

async function searchProducts(pool, criteria = {}) {
  const support = await getProductSchemaSupport(pool);
  const params = [];
  const addParam = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  const query = trimString(criteria.query);
  const queryLower = query ? query.toLowerCase() : "";
  const queryParam = query && support.hasPgTrgm ? addParam(queryLower) : null;
  const queryLikeParam = query ? addParam(`%${queryLower}%`) : null;
  const tokens = tokenizeCatalogQuery(query);
  const sort = normalizeCatalogSort(criteria.sort, query);
  const limit = normalizeCatalogLimit(criteria.limit);
  const priceExpr = buildPriceCentsExpression(support, "p");
  const leadExpr = buildLeadTimeMaxExpression(support, "p");
  const searchTitleExpr = support.hasSearchTitle ? "COALESCE(p.search_title, p.title)" : "p.title";
  const searchDescriptionExpr = support.hasSearchDescription
    ? "COALESCE(p.search_description, p.description, '')"
    : "COALESCE(p.description, '')";
  const searchTextExpr = `lower(concat_ws(' ', p.title, ${searchTitleExpr}, ${searchDescriptionExpr}, COALESCE(tag.tag_text, '')))`;
  const where = buildActiveProductPredicates(support, "p");
  const categoryIds = splitCatalogList(criteria.categories ?? criteria.categoryIds);
  const tagIds = splitCatalogList(criteria.tags ?? criteria.tagIds);
  const minPriceCents = toFiniteNumber(criteria.minPriceCents);
  const maxPriceCents = toFiniteNumber(criteria.maxPriceCents);
  const leadTimeMaxDays = toFiniteNumber(criteria.leadTimeMaxDays);

  if (minPriceCents !== null) {
    where.push(`${priceExpr} >= ${addParam(Math.max(0, Math.floor(minPriceCents)))}`);
  }
  if (maxPriceCents !== null) {
    where.push(`${priceExpr} <= ${addParam(Math.max(0, Math.floor(maxPriceCents)))}`);
  }
  if (leadTimeMaxDays !== null) {
    where.push(`${leadExpr} <= ${addParam(Math.max(0, leadTimeMaxDays))}`);
  }

  if (categoryIds.length > 0) {
    if (!support.hasCategories) {
      where.push("FALSE");
    } else {
      const categoryParam = addParam(categoryIds);
      where.push(`
        EXISTS (
          SELECT 1
          FROM product_categories pc_filter
          JOIN categories c_filter
            ON c_filter.id = pc_filter.category_id
          WHERE pc_filter.product_id = p.id
            AND (pc_filter.category_id = ANY(${categoryParam}::text[]) OR c_filter.slug = ANY(${categoryParam}::text[]))
        )
      `);
    }
  }

  if (tagIds.length > 0) {
    if (!support.hasTags) {
      where.push("FALSE");
    } else {
      const tagParam = addParam(tagIds);
      where.push(`
        EXISTS (
          SELECT 1
          FROM product_tags pt_filter
          JOIN tags t_filter
            ON t_filter.id = pt_filter.tag_id
          WHERE pt_filter.product_id = p.id
            AND (pt_filter.tag_id = ANY(${tagParam}::text[]) OR t_filter.slug = ANY(${tagParam}::text[]))
        )
      `);
    }
  }

  if (query) {
    const tokenPredicates = tokens.map((token) => `${searchTextExpr} LIKE ${addParam(`%${token}%`)}`);
    const fuzzyPredicate =
      support.hasPgTrgm && queryParam
        ? `
          similarity(lower(p.title), ${queryParam}::text) > 0.2
          OR similarity(lower(${searchTitleExpr}), ${queryParam}::text) > 0.2
          OR COALESCE(tag.tag_similarity, 0) > 0.2
        `
        : "";
    where.push(`
      (
        ${tokenPredicates.length > 0 ? tokenPredicates.join(" AND ") : "FALSE"}
        ${fuzzyPredicate ? `OR ${fuzzyPredicate}` : ""}
      )
    `);
  }

  const exactRank =
    query && queryLikeParam
      ? `
        CASE WHEN lower(p.title) LIKE ${queryLikeParam} THEN 3 ELSE 0 END
        + CASE WHEN ${searchTextExpr} LIKE ${queryLikeParam} THEN 1 ELSE 0 END
      `
      : "0";
  const fuzzyRank =
    support.hasPgTrgm && queryParam
      ? `
        + GREATEST(
          similarity(lower(p.title), ${queryParam}::text),
          similarity(lower(${searchTitleExpr}), ${queryParam}::text),
          COALESCE(tag.tag_similarity, 0)
        )
      `
      : "";
  const rankExpr = `(${exactRank} ${fuzzyRank})`;
  const cursor = decodeCatalogCursor(criteria.cursor, sort);
  const outerWhere = [];

  if (cursor) {
    const idParam = addParam(String(cursor.id));
    if (sort === "price_asc") {
      const keyParam = addParam(Number(cursor.key));
      outerWhere.push(`(r.price_cents > ${keyParam} OR (r.price_cents = ${keyParam} AND r.id > ${idParam}))`);
    } else if (sort === "price_desc") {
      const keyParam = addParam(Number(cursor.key));
      outerWhere.push(`(r.price_cents < ${keyParam} OR (r.price_cents = ${keyParam} AND r.id > ${idParam}))`);
    } else if (sort === "lead_time") {
      const keyParam = addParam(Number(cursor.key));
      outerWhere.push(`(r.lead_time_max > ${keyParam} OR (r.lead_time_max = ${keyParam} AND r.id > ${idParam}))`);
    } else if (sort === "name") {
      const keyParam = addParam(String(cursor.key || ""));
      outerWhere.push(`(r.sort_title > ${keyParam} OR (r.sort_title = ${keyParam} AND r.id > ${idParam}))`);
    } else if (sort === "relevance") {
      const keyParam = addParam(Number(cursor.key || 0));
      const createdParam = addParam(cursor.createdAt);
      outerWhere.push(`
        (
          r.search_rank < ${keyParam}
          OR (
            r.search_rank = ${keyParam}
            AND (
              r.created_at < ${createdParam}::timestamptz
              OR (r.created_at = ${createdParam}::timestamptz AND r.id > ${idParam})
            )
          )
        )
      `);
    } else {
      const createdParam = addParam(cursor.key || cursor.createdAt);
      outerWhere.push(`
        (
          r.created_at < ${createdParam}::timestamptz
          OR (r.created_at = ${createdParam}::timestamptz AND r.id > ${idParam})
        )
      `);
    }
  }

  const orderBy =
    sort === "price_asc"
      ? "r.price_cents ASC, r.id ASC"
      : sort === "price_desc"
        ? "r.price_cents DESC, r.id ASC"
        : sort === "lead_time"
          ? "r.lead_time_max ASC, r.id ASC"
          : sort === "name"
            ? "r.sort_title ASC, r.id ASC"
            : sort === "relevance"
              ? "r.search_rank DESC, r.created_at DESC, r.id ASC"
              : "r.created_at DESC, r.id ASC";

  const sql = `
    WITH ranked AS (
      SELECT
        ${buildProductCardSelectSql(support)},
        ${priceExpr} AS price_cents,
        ${leadExpr} AS lead_time_max,
        lower(p.title) AS sort_title,
        ${rankExpr} AS search_rank
      FROM products p
      ${buildCatalogLateralJoins(support, queryParam)}
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    )
    SELECT *
    FROM ranked r
    ${outerWhere.length > 0 ? `WHERE ${outerWhere.join(" AND ")}` : ""}
    ORDER BY ${orderBy}
    LIMIT ${addParam(limit + 1)}
  `;

  const result = await pool.query(sql, params);
  const rows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;

  return {
    products: rows.map(mapProductCardRow),
    pageInfo: {
      hasMore,
      cursor: hasMore && rows.length > 0 ? encodeCatalogCursor(rows[rows.length - 1], sort) : null,
      limit,
      sort
    }
  };
}

async function getProductFilters(pool) {
  const support = await getProductSchemaSupport(pool);
  const activePredicates = buildActiveProductPredicates(support, "p");
  const activeWhere = activePredicates.length > 0 ? `WHERE ${activePredicates.join(" AND ")}` : "";
  const priceExpr = buildPriceCentsExpression(support, "p");
  const leadExpr = buildLeadTimeMaxExpression(support, "p");

  const summaryPromise = pool.query(`
    SELECT
      COUNT(*)::integer AS product_count,
      MIN(${priceExpr}) AS min_price_cents,
      MAX(${priceExpr}) AS max_price_cents,
      MIN(${leadExpr}) AS min_lead_time_days,
      MAX(${leadExpr}) AS max_lead_time_days,
      MIN(${support.hasCurrency ? "p.currency" : "NULL::text"}) AS currency
    FROM products p
    ${activeWhere}
  `);

  const categoryPromise = support.hasCategories
    ? pool.query(`
        SELECT
          c.id,
          c.slug,
          c.name,
          COUNT(DISTINCT p.id)::integer AS product_count
        FROM categories c
        JOIN product_categories pc
          ON pc.category_id = c.id
        JOIN products p
          ON p.id = pc.product_id
        ${activeWhere ? `${activeWhere} AND c.is_visible = true` : "WHERE c.is_visible = true"}
        GROUP BY c.id, c.slug, c.name, c.sort_order
        ORDER BY c.sort_order, c.name
      `)
    : Promise.resolve({ rows: [] });

  const tagPromise = support.hasTags
    ? pool.query(`
        SELECT
          t.id,
          t.slug,
          t.name,
          COUNT(DISTINCT p.id)::integer AS product_count
        FROM tags t
        LEFT JOIN product_tags pt
          ON pt.tag_id = t.id
        LEFT JOIN products p
          ON p.id = pt.product_id
          ${activePredicates.length > 0 ? `AND ${activePredicates.join(" AND ")}` : ""}
        GROUP BY t.id, t.slug, t.name
        ORDER BY t.name
      `)
    : Promise.resolve({ rows: [] });

  const [summaryResult, categoryResult, tagResult] = await Promise.all([
    summaryPromise,
    categoryPromise,
    tagPromise
  ]);
  const summary = summaryResult.rows[0] || {};

  return {
    productCount: Number(summary.product_count || 0),
    price: {
      min: toFiniteNumber(summary.min_price_cents),
      max: toFiniteNumber(summary.max_price_cents),
      currency: trimString(summary.currency) || env.priceCurrency
    },
    leadTimeDays: {
      min: toFiniteNumber(summary.min_lead_time_days),
      max: toFiniteNumber(summary.max_lead_time_days)
    },
    categories: categoryResult.rows.map((row) => ({
      id: String(row.id),
      slug: trimString(row.slug) || String(row.id),
      name: trimString(row.name) || String(row.id),
      productCount: Number(row.product_count || 0)
    })),
    tags: tagResult.rows.map((row) => ({
      id: String(row.id),
      slug: trimString(row.slug) || String(row.id),
      name: trimString(row.name) || String(row.id),
      productCount: Number(row.product_count || 0)
    }))
  };
}

async function getTags(pool) {
  const support = await getProductSchemaSupport(pool);
  if (!support.hasTags) {
    return { tags: [] };
  }

  const activePredicates = buildActiveProductPredicates(support, "p");
  const result = await pool.query(`
    SELECT
      t.id,
      t.slug,
      t.name,
      COUNT(DISTINCT p.id)::integer AS product_count
    FROM tags t
    LEFT JOIN product_tags pt
      ON pt.tag_id = t.id
    LEFT JOIN products p
      ON p.id = pt.product_id
      ${activePredicates.length > 0 ? `AND ${activePredicates.join(" AND ")}` : ""}
    GROUP BY t.id, t.slug, t.name
    ORDER BY t.name
  `);

  return {
    tags: result.rows.map((row) => ({
      id: String(row.id),
      slug: trimString(row.slug) || String(row.id),
      name: trimString(row.name) || String(row.id),
      productCount: Number(row.product_count || 0)
    }))
  };
}

async function getFeaturedCategories(pool, options = {}) {
  const support = await getProductSchemaSupport(pool);
  if (!support.hasCategories) {
    return { categories: [] };
  }

  const limit = Math.min(12, Math.max(1, Number.parseInt(String(options.limit || 3), 10) || 3));
  const activePredicates = buildActiveProductPredicates(support, "p");
  const activeWhere = activePredicates.length > 0 ? `AND ${activePredicates.join(" AND ")}` : "";
  const result = await pool.query(
    `
      SELECT
        c.id,
        c.slug,
        c.name,
        c.description,
        counts.product_count,
        product_pick.id AS product_id,
        product_pick.title AS product_title,
        image_pick.image
      FROM categories c
      JOIN LATERAL (
        SELECT COUNT(DISTINCT p.id)::integer AS product_count
        FROM product_categories pc
        JOIN products p
          ON p.id = pc.product_id
        WHERE pc.category_id = c.id
          ${activeWhere}
      ) counts ON TRUE
      JOIN LATERAL (
        SELECT p.id, p.title
        FROM product_categories pc
        JOIN products p
          ON p.id = pc.product_id
        WHERE pc.category_id = c.id
          ${activeWhere}
        ORDER BY random()
        LIMIT 1
      ) product_pick ON TRUE
      LEFT JOIN LATERAL (
        ${
          support.hasImages
            ? `
        SELECT json_build_object(
          'path', pi.path,
          'alt', pi.alt
        ) AS image
        FROM product_images pi
        WHERE pi.product_id = product_pick.id
        ORDER BY random()
        LIMIT 1`
            : "SELECT NULL::json AS image"
        }
      ) image_pick ON TRUE
      WHERE c.is_visible = true
        AND counts.product_count > 0
      ORDER BY random()
      LIMIT $1
    `,
    [limit]
  );

  return {
    categories: result.rows.map((row) => ({
      id: String(row.id),
      slug: trimString(row.slug) || String(row.id),
      name: trimString(row.name) || String(row.id),
      description: trimString(row.description),
      productCount: Number(row.product_count || 0),
      featuredProduct: {
        id: String(row.product_id),
        title: trimString(row.product_title) || String(row.product_id)
      },
      image: row.image || null
    }))
  };
}

async function getProductWorkByIds(pool, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return new Map();
  }

  const productStateById = await getProductCartStateByIds(pool, productIds);
  return new Map(
    Array.from(productStateById.entries()).map(([productId, state]) => [
      productId,
      Number(state.daysToCreate)
    ])
  );
}

async function getProductCartStateByIds(pool, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return new Map();
  }

  const support = await getProductSchemaSupport(pool);
  const result = await pool.query(buildProductCartStateByIdsSql(support), [productIds]);
  const productStateById = new Map(
    result.rows.map((row) => [
      row.id,
      {
        daysToCreate: Number(row.days_to_create),
        hasVariants: row.has_variants === true
      }
    ])
  );

  const commissionIds = productIds.filter((productId) => isCommissionProductId(productId));
  if (commissionIds.length === 0) {
    return productStateById;
  }

  const commissionResult = await pool.query(COMMISSIONS_FOR_CHECKOUT_BY_IDS_SQL, [commissionIds]);
  for (const row of commissionResult.rows) {
    if (canCheckoutCommissionRow(row)) {
      productStateById.set(row.id, {
        daysToCreate: 0,
        hasVariants: false
      });
    }
  }

  return productStateById;
}

async function getProductsForCheckoutByIds(pool, productIds) {
  if (!Array.isArray(productIds) || productIds.length === 0) {
    return new Map();
  }

  const support = await getProductSchemaSupport(pool);
  const result = await pool.query(buildProductsForCheckoutByIdsSql(support), [productIds]);
  const normalizedRows = await Promise.all(
    result.rows.map(async (row) => ({
      id: row.id,
      title: row.title,
      sellPriceCents: Number(row.sell_price_cents),
      daysToCreate: Number(row.days_to_create),
      currency: trimString(row.currency) || env.priceCurrency,
      stripeThumbUrl: await resolveStripeThumbnailUrl(row.id, row.stripe_thumb_url),
      shipping: mapShippingProfile(row),
      hasVariants: row.has_variants === true,
      variants: readJsonArray(row.variants)
        .map((variant) =>
          mapVariant(
            variant,
            Number(row.sell_price_cents),
            trimString(row.currency) || env.priceCurrency
          )
        )
        .filter(Boolean),
      kind: "product"
    }))
  );
  const productsById = new Map(normalizedRows.map((row) => [row.id, row]));

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
      currency: env.priceCurrency,
      stripeThumbUrl: null,
      hasVariants: false,
      variants: [],
      kind: "commission_commitment"
    });
  }

  return productsById;
}

module.exports = {
  getProductById,
  getFeaturedCategories,
  getProductFilters,
  getTags,
  searchProducts,
  getProductCartStateByIds,
  getProductWorkByIds,
  getProductsForCheckoutByIds
};
