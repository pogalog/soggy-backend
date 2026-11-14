"use strict";

const { getCartBySessionId } = require("../models/cartModel");
const { getProductsForCheckoutByIds } = require("../models/productModel");
const { resolveCartLineItems } = require("../lib/cartLineResolver");
const {
  normalizeShippingDetailsInput,
  quoteShippingOptions
} = require("../lib/shippingQuote");
const { createShippingQuoteToken } = require("../lib/shippingQuoteToken");

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function ensureJsonContentType(req) {
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

function normalizeRequestedCarriers(value) {
  if (value === undefined || value === null) {
    return ["UPS", "USPS"];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw withStatusError("carriers must be a non-empty array", 400);
  }

  const carriers = Array.from(
    new Set(
      value.map((carrier) =>
        typeof carrier === "string" ? carrier.trim().toUpperCase() : ""
      )
    )
  );
  if (carriers.some((carrier) => carrier !== "UPS" && carrier !== "USPS")) {
    throw withStatusError("carriers may only contain UPS or USPS", 400);
  }

  return carriers;
}

function normalizeRequest(body) {
  if (!body || typeof body !== "object") {
    throw withStatusError("Request body must be a JSON object", 400);
  }

  const cartSessionId =
    typeof body.cartSessionId === "string" ? body.cartSessionId.trim() : "";
  if (!cartSessionId) {
    throw withStatusError("cartSessionId is required", 400);
  }

  return {
    cartSessionId,
    carriers: normalizeRequestedCarriers(body.carriers),
    shippingDetails: normalizeShippingDetailsInput(body.shippingDetails, {
      requireName: false
    })
  };
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function ensureResolvedCartLines(cartItems) {
  const invalidItems = cartItems.filter((item) => typeof item.validationReason === "string");
  if (invalidItems.length === 0) {
    return;
  }

  const error = withStatusError(
    invalidItems.some((item) => item.validationReason === "PRODUCT_NOT_FOUND")
      ? "One or more cart products were not found"
      : invalidItems.some((item) => item.validationReason === "VARIANT_SELECTION_REQUIRED")
        ? "One or more cart items require a variant selection"
        : "One or more cart items include an invalid variant selection",
    422
  );
  error.details = invalidItems.map((item) => ({
    lineId: item.lineId || undefined,
    productId: item.productId,
    variantId: item.variantId || undefined,
    reason: item.validationReason
  }));
  throw error;
}

function createShippingQuoteHandler({ getPool }) {
  return async function shippingQuoteHandler(req, res) {
    let cartSessionId = null;
    let requestedCarriers = null;
    const startedAt = Date.now();

    try {
      if (req.method !== "POST") {
        return methodNotAllowed(res);
      }

      ensureJsonContentType(req);
      const body = parseJsonBody(req);
      const normalized = normalizeRequest(body);
      cartSessionId = normalized.cartSessionId;
      requestedCarriers = normalized.carriers;

      const pool = getPool();
      const cart = await getCartBySessionId(pool, cartSessionId);
      if (!Array.isArray(cart.items) || cart.items.length === 0) {
        throw withStatusError("Cart session not found or empty", 422);
      }

      const productIds = cart.items.map((item) => item.productId);
      const productsById = await getProductsForCheckoutByIds(pool, productIds);
      const { resolvedItems } = resolveCartLineItems(productsById, cart.items);
      ensureResolvedCartLines(resolvedItems);
      const quoteResult = await quoteShippingOptions({
        productsById,
        cartItems: resolvedItems,
        shippingDetails: normalized.shippingDetails,
        carriers: normalized.carriers
      });

      if (quoteResult.shippingRequired) {
        quoteResult.quoteToken = createShippingQuoteToken({
          cartSessionId,
          shippingDetails: normalized.shippingDetails,
          packageSummary: quoteResult.packageSummary,
          options: quoteResult.options
        });
      }

      if (Array.isArray(quoteResult.providerWarnings) && quoteResult.providerWarnings.length > 0) {
        console.warn("Shipping quote completed with reduced carrier coverage", {
          cartSessionId,
          requestedCarriers,
          durationMs: Date.now() - startedAt,
          optionCount: quoteResult.options.length,
          availableCarriers: Array.from(
            new Set(quoteResult.options.map((option) => option.carrier))
          ),
          providerWarnings: quoteResult.providerWarnings
        });
      }

      return res.status(200).json(quoteResult);
    } catch (error) {
      if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
      const publicMessage =
        statusCode === 502 || statusCode === 503 || statusCode === 504
          ? "Shipping quote service is temporarily unavailable. Please retry in a moment."
          : statusCode >= 500
            ? "Internal server error"
            : error.message;
      const responseBody = { error: publicMessage };
      if (statusCode < 500 && error.details !== undefined) {
        responseBody.details = error.details;
      }

      if (statusCode >= 500) {
        console.error("Failed to quote shipping", {
          method: req.method,
          path: req.path || req.url,
          cartSessionId,
          requestedCarriers,
          durationMs: Date.now() - startedAt,
          message: error.message,
          cause: error.cause instanceof Error ? error.cause.message : undefined,
          carrier: typeof error.carrier === "string" ? error.carrier : undefined,
          phase: typeof error.phase === "string" ? error.phase : undefined,
          upstreamStatus: Number.isFinite(Number(error.upstreamStatus))
            ? Number(error.upstreamStatus)
            : undefined,
          providerErrors: Array.isArray(error.providerErrors)
            ? error.providerErrors
            : undefined,
          statusCode
        });
      } else {
        console.warn("Rejected shipping quote request", {
          method: req.method,
          path: req.path || req.url,
          cartSessionId,
          message: error.message
        });
      }

      return res.status(statusCode).json(responseBody);
    }
  };
}

module.exports = {
  createShippingQuoteHandler,
  normalizeRequestedCarriers
};
