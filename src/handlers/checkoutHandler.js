"use strict";

const { env } = require("../config/env");
const { getCartBySessionId } = require("../models/cartModel");
const { getProductsForCheckoutByIds } = require("../models/productModel");
const {
  createPendingOrder,
  setOrderStripeCheckoutSessionId
} = require("../models/orderModel");
const {
  normalizeShippingDetailsInput,
  quoteCheapestShipping
} = require("../lib/shippingQuote");
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

  const shippingDetails =
    body.shippingDetails === undefined || body.shippingDetails === null
      ? null
      : normalizeShippingDetailsInput(body.shippingDetails, { requireName: false });

  return {
    cartSessionId,
    channel,
    shippingDetails
  };
}

function getAllowedShippingCountries() {
  const allowedCountries = Array.isArray(env.stripeShippingAllowedCountries)
    ? env.stripeShippingAllowedCountries.filter(
        (country) => typeof country === "string" && country.trim()
      )
    : [];

  if (allowedCountries.length === 0) {
    throw withStatusError(
      "STRIPE_SHIPPING_ALLOWED_COUNTRIES must include at least one country",
      500
    );
  }

  return allowedCountries;
}

function buildPreparedOrderItems({ cartItems, productsById }) {
  const preparedItems = [];
  const missing = [];
  const workLimitViolations = [];
  let totalWorkDays = 0;

  for (const cartItem of cartItems) {
    const product = productsById.get(cartItem.productId);
    if (!product) {
      missing.push(cartItem.productId);
      continue;
    }

    if (product.kind === "commission_commitment" && cartItem.quantity > 1) {
      workLimitViolations.push({
        productId: cartItem.productId,
        requestedQuantity: cartItem.quantity,
        maxCartQty: 1,
        reason: "EXCEEDS_MAX_CART_QTY"
      });
    }

    if (product.kind !== "commission_commitment") {
      totalWorkDays += Number(product.daysToCreate || 0) * cartItem.quantity;
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

  if (totalWorkDays > env.maxCartWorkDays) {
    for (const item of preparedItems) {
      const product = productsById.get(item.productId);
      if (!product || product.kind === "commission_commitment") {
        continue;
      }

      workLimitViolations.push({
        productId: item.productId,
        requestedQuantity: item.quantity,
        requestedWorkDays: Number(product.daysToCreate || 0) * item.quantity,
        totalRequestedWorkDays: totalWorkDays,
        maxCartWorkDays: env.maxCartWorkDays,
        reason: "EXCEEDS_MAX_CART_WORK_DAYS"
      });
    }
  }

  if (workLimitViolations.length > 0) {
    const hasWorkLimit = workLimitViolations.some(
      (violation) => violation.reason === "EXCEEDS_MAX_CART_WORK_DAYS"
    );
    const error = withStatusError(
      hasWorkLimit
        ? "This order exceeds the current four-day production limit"
        : "One or more cart items exceed the per-item limit",
      422
    );
    error.details = workLimitViolations;
    throw error;
  }

  return preparedItems;
}

function cartRequiresShipping(cartItems, productsById) {
  return cartItems.some((item) => {
    const product = productsById.get(item.productId);
    return product && product.kind !== "commission_commitment";
  });
}

function validateShippingDetailsForCheckout(shippingDetails) {
  if (!shippingDetails) {
    throw withStatusError(
      "shippingDetails are required to calculate shipping before checkout",
      400
    );
  }

  if (!shippingDetails.name) {
    throw withStatusError("shippingDetails.name is required", 400);
  }

  const allowedCountries = getAllowedShippingCountries();
  if (!allowedCountries.includes(shippingDetails.address.country)) {
    throw withStatusError(
      `Shipping is currently limited to ${allowedCountries.join(", ")}`,
      422
    );
  }
}

function buildStripeLineItems(items) {
  const stripeCurrency = String(env.priceCurrency || "USD").toLowerCase();
  const stripeTaxCode =
    typeof env.stripeTaxCode === "string" ? env.stripeTaxCode.trim() : "";

  return items.map((item) => {
    const productData = {
      name: item.name,
      metadata: {
        product_id: String(item.productId),
        sku: String(item.sku)
      }
    };

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

function buildStripeShippingOptions(quote) {
  if (!quote) {
    return undefined;
  }

  const shippingRateData = {
    type: "fixed_amount",
    fixed_amount: {
      amount: quote.amountCents,
      currency: String(quote.currency || env.priceCurrency || "USD").toLowerCase()
    },
    display_name: quote.serviceName,
    metadata: {
      carrier: quote.carrier || "UPS",
      service_code: quote.serviceCode || "",
      quoted_at: quote.quotedAt || ""
    }
  };

  if (env.stripeShippingTaxCode && env.stripeShippingTaxCode.trim()) {
    shippingRateData.tax_code = env.stripeShippingTaxCode.trim();
    shippingRateData.tax_behavior = "exclusive";
  }

  if (Number.isFinite(quote.businessDaysInTransit) && quote.businessDaysInTransit > 0) {
    shippingRateData.delivery_estimate = {
      minimum: {
        unit: "business_day",
        value: quote.businessDaysInTransit
      },
      maximum: {
        unit: "business_day",
        value: quote.businessDaysInTransit
      }
    };
  }

  return [
    {
      shipping_rate_data: shippingRateData
    }
  ];
}

function toStripeAddress(address) {
  return {
    line1: address.line1,
    line2: address.line2 || undefined,
    city: address.city,
    state: address.state,
    postal_code: address.postalCode,
    country: address.country
  };
}

async function createStripeCustomer(stripe, shippingDetails) {
  if (!shippingDetails) {
    return null;
  }

  const customer = await stripe.customers.create({
    name: shippingDetails.name || undefined,
    address: toStripeAddress(shippingDetails.address),
    shipping: {
      name: shippingDetails.name || "Customer",
      address: toStripeAddress(shippingDetails.address)
    }
  });

  return customer && typeof customer.id === "string" ? customer.id : null;
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function createCheckoutHandler({ getPool }) {
  return async function checkoutHandler(req, res) {
    let cartSessionId = null;

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

      const requiresShipping =
        normalized.channel === "online" && cartRequiresShipping(cart.items, productsById);
      let shippingQuote = null;
      let shippingDetails = null;

      if (requiresShipping) {
        validateShippingDetailsForCheckout(normalized.shippingDetails);
        shippingDetails = normalized.shippingDetails;
        const quoteResult = await quoteCheapestShipping({
          productsById,
          cartItems: cart.items,
          shippingDetails
        });
        shippingQuote = quoteResult.quote;
      }

      const pendingOrder = await createPendingOrder(pool, {
        cartSessionId,
        channel: normalized.channel,
        currency: String(env.priceCurrency || "USD").toUpperCase(),
        items: preparedItems,
        shippingMethod: shippingQuote ? shippingQuote.serviceName : null,
        shippingAmount: shippingQuote ? shippingQuote.amountCents : null,
        shippingDetails,
        shippingQuote
      });

      const appBaseUrl = requireAppBaseUrl();
      const stripe = getStripeClient();
      const customerId = await createStripeCustomer(stripe, shippingDetails);
      const sessionPayload = {
        mode: "payment",
        line_items: buildStripeLineItems(preparedItems),
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        success_url: `${appBaseUrl}/checkout/success?order_id=${encodeURIComponent(
          pendingOrder.id
        )}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appBaseUrl}/checkout`,
        client_reference_id: cartSessionId,
        metadata: {
          cart_session_id: cartSessionId,
          channel: normalized.channel,
          order_id: pendingOrder.id
        }
      };

      if (customerId) {
        sessionPayload.customer = customerId;
      } else {
        sessionPayload.customer_creation = "always";
      }

      const shippingOptions = buildStripeShippingOptions(shippingQuote);
      if (shippingOptions) {
        sessionPayload.shipping_options = shippingOptions;
      }

      const session = await stripe.checkout.sessions.create(sessionPayload);
      if (!session || !session.url || typeof session.id !== "string") {
        throw new Error("Stripe Checkout Session did not return a redirect URL");
      }

      await setOrderStripeCheckoutSessionId(pool, {
        orderId: pendingOrder.id,
        stripeCheckoutSessionId: session.id
      });

      return res.status(201).json({
        checkoutUrl: session.url,
        orderId: pendingOrder.id
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
