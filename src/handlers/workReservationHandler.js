"use strict";

const { env } = require("../config/env");
const { getCartBySessionId } = require("../models/cartModel");
const { getProductsForCheckoutByIds } = require("../models/productModel");
const { reserveWorkForCart } = require("../models/workQueueModel");
const { buildDisplayName, resolveCartLineItems } = require("../lib/cartLineResolver");

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseJsonBody(req) {
  if (req.body === undefined || req.body === null || req.body === "") return {};
  if (Buffer.isBuffer(req.body)) {
    const bodyText = req.body.toString("utf8").trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }
  if (typeof req.body === "string") {
    const bodyText = req.body.trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }
  if (typeof req.body === "object") return req.body;
  throw new Error("Unsupported request body format");
}

function ensureJsonContentType(req) {
  const contentType = (req.headers && req.headers["content-type"]) || "";
  if (!contentType) return;

  const isJson =
    (typeof req.is === "function" && req.is("application/json")) ||
    String(contentType).toLowerCase().includes("application/json");

  if (!isJson) {
    throw withStatusError("Content-Type must be application/json", 415);
  }
}

function isCommissionOrderItem(productId) {
  return typeof productId === "string" && /^cm_[0-9a-f]+$/i.test(productId);
}

function normalizeRequest(body) {
  const cartSessionId = typeof body.cartSessionId === "string" ? body.cartSessionId.trim() : "";
  if (!cartSessionId) {
    throw withStatusError("cartSessionId is required", 400);
  }

  return { cartSessionId };
}

function buildReservationItems({ cartItems, productsById }) {
  const { resolvedItems, violations } = resolveCartLineItems(productsById, cartItems);
  const missing = [];
  const invalidVariants = [];
  const workLimitViolations = [];
  const preparedItems = [];
  let totalWorkDays = 0;

  for (const cartItem of resolvedItems) {
    const product = productsById.get(cartItem.productId);
    if (!product) {
      missing.push(cartItem.productId);
      continue;
    }

    if (cartItem.validationReason) {
      invalidVariants.push({
        lineId: cartItem.lineId || undefined,
        productId: cartItem.productId,
        variantId: cartItem.variantId || undefined,
        reason: cartItem.validationReason
      });
      continue;
    }

    if (product.kind === "commission_commitment" && cartItem.quantity > 1) {
      workLimitViolations.push({
        lineId: cartItem.lineId || undefined,
        productId: cartItem.productId,
        variantId: cartItem.variantId || undefined,
        requestedQuantity: cartItem.quantity,
        maxCartQty: 1,
        reason: "EXCEEDS_MAX_CART_QTY"
      });
    }

    const workUnits =
      product.kind === "commission_commitment"
        ? 0
        : Number(product.daysToCreate || 0) * cartItem.quantity;

    if (!isCommissionOrderItem(product.id)) {
      totalWorkDays += workUnits;
    }

    preparedItems.push({
      lineId: cartItem.lineId || null,
      productId: product.id,
      variantId: cartItem.variantId || null,
      variantLabel: cartItem.variantLabel || null,
      optionSummary: cartItem.optionSummary || null,
      sku: cartItem.sku || product.id,
      name: buildDisplayName(cartItem),
      unitAmount: Number(cartItem.unitAmount || 0),
      quantity: cartItem.quantity,
      stripeThumbUrl: product.stripeThumbUrl,
      workUnits
    });
  }

  if (missing.length > 0 || violations.length > 0 || invalidVariants.length > 0) {
    const error = withStatusError("One or more cart items need attention before checkout", 422);
    error.details = [...violations, ...invalidVariants, ...missing.map((productId) => ({
      productId,
      reason: "PRODUCT_NOT_FOUND"
    }))];
    throw error;
  }

  if (totalWorkDays > env.maxCartWorkDays) {
    const error = withStatusError("This order exceeds the current four-day production limit", 422);
    error.details = [{
      totalRequestedWorkDays: totalWorkDays,
      maxCartWorkDays: env.maxCartWorkDays,
      reason: "EXCEEDS_MAX_CART_WORK_DAYS"
    }];
    throw error;
  }

  if (workLimitViolations.length > 0) {
    const error = withStatusError("One or more cart items exceed the per-item limit", 422);
    error.details = workLimitViolations;
    throw error;
  }

  return preparedItems;
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function createWorkReservationHandler({ getPool }) {
  return async function workReservationHandler(req, res) {
    let cartSessionId = null;

    try {
      if (req.method !== "POST") {
        return methodNotAllowed(res);
      }

      ensureJsonContentType(req);
      const request = normalizeRequest(parseJsonBody(req));
      cartSessionId = request.cartSessionId;

      const pool = getPool();
      const cart = await getCartBySessionId(pool, cartSessionId);
      if (!Array.isArray(cart.items) || cart.items.length === 0) {
        throw withStatusError("Cart session not found or empty", 422);
      }

      const productIds = cart.items.map((item) => item.productId);
      const productsById = await getProductsForCheckoutByIds(pool, productIds);
      const preparedItems = buildReservationItems({
        cartItems: cart.items,
        productsById
      });
      const reservation = await reserveWorkForCart(pool, {
        cartSessionId,
        items: preparedItems
      });

      return res.status(200).json({
        reservation,
        shipByDate: reservation ? reservation.shipByDate : null,
        expiresAt: reservation ? reservation.expiresAt : null
      });
    } catch (error) {
      if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
      const logPayload = {
        method: req.method,
        path: req.path || req.url,
        cartSessionId,
        message: error.message,
        code: error.code
      };

      if (statusCode >= 500) {
        console.error("Failed to reserve work", logPayload);
      } else {
        console.warn("Rejected work reservation request", logPayload);
      }

      const responseBody = {
        error: statusCode === 500 ? "Internal server error" : error.message
      };
      if (statusCode < 500 && error.details !== undefined) {
        responseBody.details = error.details;
      }

      return res.status(statusCode).json(responseBody);
    }
  };
}

module.exports = {
  buildReservationItems,
  normalizeRequest,
  createWorkReservationHandler
};
