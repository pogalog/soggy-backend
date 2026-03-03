"use strict";

const { env } = require("../config/env");
const { getCartBySessionId } = require("../models/cartModel");
const { getProductsForCheckoutByIds } = require("../models/productModel");
const {
  createPendingOrder,
  setOrderStripeCheckoutSessionId
} = require("../models/orderModel");
const { getStripeClient } = require("../lib/stripeClient");

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

function requireAppBaseUrl() {
  if (!env.appBaseUrl || !env.appBaseUrl.trim()) {
    throw withStatusError("APP_BASE_URL is required for Checkout redirects", 500);
  }

  return env.appBaseUrl.trim().replace(/\/+$/, "");
}

function normalizeCheckoutRequest(body) {
  if (!body || typeof body !== "object") {
    throw withStatusError("Request body must be a JSON object", 400);
  }

  const cartSessionId =
    typeof body.cartSessionId === "string" ? body.cartSessionId.trim() : "";
  if (!cartSessionId) {
    throw withStatusError("cartSessionId is required", 400);
  }

  const rawChannel =
    typeof body.channel === "string" ? body.channel.trim() : body.channel;
  const channel =
    rawChannel === undefined || rawChannel === null || rawChannel === ""
      ? "online"
      : rawChannel;

  if (channel !== "online" && channel !== "market") {
    throw withStatusError("channel must be either 'online' or 'market'", 400);
  }

  return {
    cartSessionId,
    channel
  };
}

function buildPreparedOrderItems({ cartItems, productsById }) {
  const preparedItems = [];
  const missing = [];
  const insufficient = [];

  for (const cartItem of cartItems) {
    const product = productsById.get(cartItem.productId);
    if (!product) {
      missing.push(cartItem.productId);
      continue;
    }

    if (cartItem.quantity > product.inventoryQty) {
      insufficient.push({
        productId: cartItem.productId,
        requestedQuantity: cartItem.quantity,
        inventoryQty: product.inventoryQty
      });
      continue;
    }

    preparedItems.push({
      productId: product.id,
      sku: product.id,
      name: product.title,
      unitAmount: product.sellPriceCents,
      quantity: cartItem.quantity,
      stripeThumbUrl: product.stripeThumbUrl
    });
  }

  if (missing.length > 0) {
    const error = withStatusError("One or more cart products were not found", 422);
    error.details = { missingProductIds: missing };
    throw error;
  }

  if (insufficient.length > 0) {
    const error = withStatusError("Insufficient inventory for one or more cart items", 422);
    error.details = insufficient;
    throw error;
  }

  return preparedItems;
}

function buildStripeLineItems(items) {
  const stripeCurrency = String(env.priceCurrency || "USD").toLowerCase();
  const stripeTaxCode =
    typeof env.stripeTaxCode === "string" ? env.stripeTaxCode.trim() : "";

  return items.map((item) => {
    const productData = {
      name: item.name
    };

    // Stripe Checkout inline price_data keeps Stripe Products/Prices out of our source of truth.
    // Shared tax code and optional public thumbnail URL both belong on product_data here.
    if (stripeTaxCode) {
      productData.tax_code = stripeTaxCode;
    }
    if (item.stripeThumbUrl) {
      productData.images = [item.stripeThumbUrl];
    }

    return {
      quantity: item.quantity,
      price_data: {
        currency: stripeCurrency,
        unit_amount: item.unitAmount,
        product_data: productData
      }
    };
  });
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function createCheckoutHandler({ getPool }) {
  return async function checkoutHandler(req, res) {
    let cartSessionId = null;
    let orderId = null;

    try {
      if (req.method !== "POST") {
        return methodNotAllowed(res);
      }

      ensureJsonContentType(req);
      const body = parseJsonBody(req);
      const normalized = normalizeCheckoutRequest(body);
      cartSessionId = normalized.cartSessionId;

      const pool = getPool();
      const cart = await getCartBySessionId(pool, cartSessionId);
      if (!Array.isArray(cart.items) || cart.items.length === 0) {
        throw withStatusError("Cart session not found or empty", 422);
      }

      const productIds = cart.items.map((item) => item.productId);
      const productsById = await getProductsForCheckoutByIds(pool, productIds);
      const preparedItems = buildPreparedOrderItems({
        cartItems: cart.items,
        productsById
      });

      const order = await createPendingOrder(pool, {
        cartSessionId,
        channel: normalized.channel,
        currency: String(env.priceCurrency || "USD").toUpperCase(),
        items: preparedItems
      });
      orderId = order.id;

      const appBaseUrl = requireAppBaseUrl();
      const stripe = getStripeClient();
      const session = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: buildStripeLineItems(preparedItems),
          automatic_tax: { enabled: true },
          success_url:
            `${appBaseUrl}/checkout/success?order_id=${encodeURIComponent(order.id)}` +
            "&session_id={CHECKOUT_SESSION_ID}",
          cancel_url: `${appBaseUrl}/checkout/cancel?order_id=${encodeURIComponent(order.id)}`,
          client_reference_id: cartSessionId,
          metadata: {
            order_id: String(order.id),
            cart_session_id: cartSessionId,
            channel: normalized.channel
          }
        },
        {
          idempotencyKey: `checkout_session_order_${order.id}`
        }
      );

      if (!session || !session.url) {
        throw new Error("Stripe Checkout Session did not return a redirect URL");
      }

      await setOrderStripeCheckoutSessionId(pool, {
        orderId: order.id,
        stripeCheckoutSessionId: session.id
      });

      return res.status(201).json({
        checkoutUrl: session.url,
        orderId: order.id
      });
    } catch (error) {
      if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const statusCode =
        typeof error.statusCode === "number"
          ? error.statusCode
          : error.type && String(error.type).startsWith("Stripe")
            ? 502
            : 500;

      const logPayload = {
        method: req.method,
        path: req.path || req.url,
        cartSessionId,
        orderId,
        message: error.message,
        code: error.code,
        type: error.type
      };

      if (statusCode >= 500) {
        console.error("Failed to create checkout session", logPayload);
      } else {
        console.warn("Rejected checkout session request", logPayload);
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
  createCheckoutHandler
};
