"use strict";

const { randomUUID } = require("node:crypto");
const { env } = require("../config/env");

const {
  createCart,
  getCartBySessionId,
  updateCart,
  deleteCart
} = require("../models/cartModel");
const { getProductsForCheckoutByIds } = require("../models/productModel");
const { resolveCartLineItems } = require("../lib/cartLineResolver");

const WORK_DAY_EPSILON = 1e-9;

function parseJsonBody(req) {
  if (req.body === undefined || req.body === null || req.body === "") {
    return {};
  }

  if (Buffer.isBuffer(req.body)) {
    const bodyText = req.body.toString("utf8").trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }

  if (typeof req.body === "string") {
    const bodyText = req.body.trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  throw new Error("Unsupported request body format");
}

function extractSessionId(req, body) {
  if (req.params && typeof req.params.sessionId === "string" && req.params.sessionId.trim()) {
    return req.params.sessionId.trim();
  }

  if (req.query && typeof req.query.sessionId === "string" && req.query.sessionId.trim()) {
    return req.query.sessionId.trim();
  }

  if (body && typeof body.sessionId === "string" && body.sessionId.trim()) {
    return body.sessionId.trim();
  }

  const path = req.path || req.url || "";
  const match = path.match(/^\/(?:api\/)?cart\/([^/]+)\/?$/);
  if (!match || !match[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

function requireSessionId(req, body) {
  const sessionId = extractSessionId(req, body);
  if (!sessionId) {
    throw withStatusError(
      "Missing sessionId. Use /cart/:sessionId or ?sessionId=<sessionId>",
      400
    );
  }

  return sessionId;
}

function generateSessionId() {
  return `sess_${randomUUID()}`;
}

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function logWarning(message, details) {
  console.warn(message, details);
}

function isCommissionProductId(productId) {
  return typeof productId === "string" && /^cm_[0-9a-f]+$/i.test(productId);
}

function toTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function computeEstimatedProductionDays(totalWorkDays) {
  return totalWorkDays > 0 ? Math.ceil(totalWorkDays - WORK_DAY_EPSILON) : 0;
}

function formatDateOnly(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function computeShipByDate(totalWorkDays) {
  const productionDays = computeEstimatedProductionDays(totalWorkDays);
  if (productionDays <= 0) {
    return formatDateOnly(new Date());
  }

  const date = new Date();
  date.setUTCDate(date.getUTCDate() + productionDays);
  return formatDateOnly(date);
}

function buildCartViolationMessage(violations) {
  if (!Array.isArray(violations) || violations.length === 0) {
    return "One or more cart items exceed allowed limits";
  }

  if (violations.some((violation) => violation.reason === "EXCEEDS_MAX_CART_WORK_DAYS")) {
    return "This order exceeds the current four-day production limit";
  }

  if (violations.some((violation) => violation.reason === "EXCEEDS_MAX_CART_QTY")) {
    return "One or more cart items exceed the per-item limit";
  }

  if (violations.some((violation) => violation.reason === "PRODUCT_NOT_FOUND")) {
    return "One or more cart items are no longer available";
  }

  if (violations.some((violation) => violation.reason === "VARIANT_SELECTION_REQUIRED")) {
    return "One or more cart items require a variant selection";
  }

  if (violations.some((violation) => violation.reason === "INVALID_VARIANT")) {
    return "One or more cart items include an invalid variant selection";
  }

  return "One or more cart items exceed allowed limits";
}

function ensureJsonContentType(req) {
  if (req.method !== "POST" && req.method !== "PUT") {
    return;
  }

  const contentType = (req.headers && req.headers["content-type"]) || "";
  if (!contentType) {
    return;
  }

  const isJson =
    (typeof req.is === "function" && req.is("application/json")) ||
    String(contentType).toLowerCase().includes("application/json");

  if (!isJson) {
    throw withStatusError("Content-Type must be application/json", 415);
  }
}

function normalizeCartItems(items, { allowEmpty }) {
  if (!Array.isArray(items)) {
    throw withStatusError("Request body must include items[]", 400);
  }

  if (!allowEmpty && items.length === 0) {
    throw withStatusError("New carts must include at least one item", 400);
  }

  const seen = new Set();

  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw withStatusError(`items[${index}] must be an object`, 400);
    }

    const lineIdSource = typeof item.lineId === "string" ? item.lineId : item.line_id;
    const lineId = typeof lineIdSource === "string" ? lineIdSource.trim() : "";
    const productIdSource =
      typeof item.productId === "string" ? item.productId : item.product_id;
    const productId =
      typeof productIdSource === "string" ? productIdSource.trim() : "";
    const variantIdSource =
      typeof item.variantId === "string" ? item.variantId : item.variant_id;
    const variantId =
      typeof variantIdSource === "string" && variantIdSource.trim()
        ? variantIdSource.trim()
        : null;

    if (!productId) {
      throw withStatusError(`items[${index}].productId is required`, 400);
    }

    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw withStatusError(`items[${index}].quantity must be a positive integer`, 400);
    }

    const dedupeKey = `${productId}::${variantId || ""}`;
    if (seen.has(dedupeKey)) {
      throw withStatusError(
        `Duplicate cart line in items: ${productId}${variantId ? ` (${variantId})` : ""}`,
        400
      );
    }
    seen.add(dedupeKey);

    return {
      lineId: lineId || null,
      productId,
      variantId,
      quantity
    };
  });
}

async function inspectCartItems(pool, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      normalizedItems: [],
      violations: [],
      totalWorkDays: 0,
      estimatedProductionDays: 0,
      shipByDate: formatDateOnly(new Date()),
      isAtCapacity: false,
      remainingWorkDays: env.maxCartWorkDays,
      maxCartWorkDays: env.maxCartWorkDays
    };
  }

  const productIds = [...new Set(items.map((item) => item.productId))];
  const productsById = await getProductsForCheckoutByIds(pool, productIds);
  const { resolvedItems, violations } = resolveCartLineItems(productsById, items);
  let totalWorkDays = 0;

  for (const item of resolvedItems) {
    if (item.validationReason) {
      continue;
    }

    if (isCommissionProductId(item.productId) && item.quantity > 1) {
      violations.push({
        lineId: item.lineId,
        productId: item.productId,
        variantId: item.variantId,
        requestedQuantity: item.quantity,
        maxCartQty: 1,
        reason: "EXCEEDS_MAX_CART_QTY"
      });
    }

    if (!isCommissionProductId(item.productId)) {
      totalWorkDays += Number(item.daysToCreate || 0) * item.quantity;
    }
  }

  if (totalWorkDays > env.maxCartWorkDays + WORK_DAY_EPSILON) {
    for (const item of resolvedItems) {
      if (item.validationReason) {
        continue;
      }

      if (isCommissionProductId(item.productId)) {
        continue;
      }

      violations.push({
        lineId: item.lineId,
        productId: item.productId,
        variantId: item.variantId,
        requestedQuantity: item.quantity,
        requestedWorkDays: Number(item.daysToCreate || 0) * item.quantity,
        totalRequestedWorkDays: totalWorkDays,
        maxCartWorkDays: env.maxCartWorkDays,
        reason: "EXCEEDS_MAX_CART_WORK_DAYS"
      });
    }
  }

  const estimatedProductionDays = computeEstimatedProductionDays(totalWorkDays);
  return {
    normalizedItems: resolvedItems.map((item) => ({
      lineId: item.lineId,
      productId: item.productId,
      variantId: item.variantId,
      variantLabel: item.variantLabel,
      optionSummary: item.optionSummary,
      sku: item.sku,
      unitAmount: item.unitAmount,
      currency: item.currency,
      quantity: item.quantity,
      lastUpdated: item.lastUpdated,
      validationReason: item.validationReason
    })),
    violations,
    totalWorkDays,
    estimatedProductionDays,
    shipByDate: computeShipByDate(totalWorkDays),
    isAtCapacity: totalWorkDays >= env.maxCartWorkDays - WORK_DAY_EPSILON,
    remainingWorkDays: Math.max(0, env.maxCartWorkDays - totalWorkDays),
    maxCartWorkDays: env.maxCartWorkDays
  };
}

async function validateCartItemQuantities(pool, items) {
  const inspection = await inspectCartItems(pool, items);

  if (inspection.violations.length > 0) {
    const error = withStatusError(buildCartViolationMessage(inspection.violations), 422);
    error.details = inspection.violations;
    throw error;
  }

  return inspection;
}

async function buildCartSummary(pool, items) {
  const inspection = await inspectCartItems(pool, items);
  return {
    normalizedItems: inspection.normalizedItems,
    totalWorkDays: inspection.totalWorkDays,
    estimatedProductionDays: inspection.estimatedProductionDays,
    shipByDate: inspection.shipByDate,
    isAtCapacity: inspection.isAtCapacity,
    remainingWorkDays: inspection.remainingWorkDays,
    maxCartWorkDays: inspection.maxCartWorkDays
  };
}

async function attachSummary(pool, cart) {
  if (!cart || typeof cart !== "object") {
    return cart;
  }

  const items = Array.isArray(cart.items) ? cart.items : [];
  const summary = await buildCartSummary(pool, items);
  return {
    ...cart,
    items: summary.normalizedItems.map((item) => ({
      ...item,
      lastUpdated:
        items.find((entry) => entry.lineId === item.lineId)?.lastUpdated || item.lastUpdated
    })),
    summary: {
      totalWorkDays: summary.totalWorkDays,
      estimatedProductionDays: summary.estimatedProductionDays,
      shipByDate: summary.shipByDate,
      isAtCapacity: summary.isAtCapacity,
      remainingWorkDays: summary.remainingWorkDays,
      maxCartWorkDays: summary.maxCartWorkDays
    }
  };
}

function methodNotAllowed(res) {
  res.set("Allow", "GET, POST, PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

function createCartHandler({ getPool }) {
  return async function cartService(req, res) {
    let body = {};
    let sessionId = null;

    try {
      ensureJsonContentType(req);

      if (req.method === "POST" || req.method === "PUT") {
        body = parseJsonBody(req);
      }

      if (req.method === "GET") {
        sessionId = requireSessionId(req, body);
        const pool = getPool();
        const cart = await getCartBySessionId(pool, sessionId);
        return res.status(200).json(await attachSummary(pool, cart));
      }

      if (req.method === "POST") {
        sessionId = extractSessionId(req, body) || generateSessionId();
        const items = normalizeCartItems(body.items, { allowEmpty: false });
        const pool = getPool();
        const inspection = await validateCartItemQuantities(pool, items);
        const cart = await createCart(pool, {
          sessionId,
          items: inspection.normalizedItems.map((item) => ({
            lineId: item.lineId,
            productId: item.productId,
            variantId: item.variantId,
            variantLabel: item.variantLabel,
            optionSummary: item.optionSummary,
            quantity: item.quantity
          }))
        });
        return res.status(201).json(await attachSummary(pool, cart));
      }

      if (req.method === "PUT") {
        sessionId = requireSessionId(req, body);
        const items = normalizeCartItems(body.items, { allowEmpty: true });
        const pool = getPool();
        const inspection = await validateCartItemQuantities(pool, items);
        const cart = await updateCart(pool, {
          sessionId,
          items: inspection.normalizedItems.map((item) => ({
            lineId: item.lineId,
            productId: item.productId,
            variantId: item.variantId,
            variantLabel: item.variantLabel,
            optionSummary: item.optionSummary,
            quantity: item.quantity
          }))
        });
        return res.status(200).json(await attachSummary(pool, cart));
      }

      if (req.method === "DELETE") {
        sessionId = requireSessionId(req, body);
        const pool = getPool();
        const result = await deleteCart(pool, sessionId);
        return res.status(200).json(result);
      }

      return methodNotAllowed(res);
    } catch (error) {
      if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
        logWarning("Rejected cart request with invalid JSON", {
          method: req.method,
          path: req.path || req.url
        });
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const statusCode =
        typeof error.statusCode === "number"
          ? error.statusCode
          : error.code === "23505"
            ? 409
            : 500;

      const logDetails = {
        method: req.method,
        path: req.path || req.url,
        sessionId,
        message: error.message,
        code: error.code
      };

      if (statusCode >= 500) {
        console.error("Failed to handle cart request", logDetails);
      } else {
        logWarning("Rejected cart request", logDetails);
      }

      const publicMessage = statusCode === 500 ? "Internal server error" : error.message;
      const responseBody = { error: publicMessage };
      if (statusCode < 500 && error.details !== undefined) {
        responseBody.details = error.details;
      }

      return res.status(statusCode).json(responseBody);
    }
  };
}

module.exports = {
  createCartHandler
};
