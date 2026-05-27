"use strict";

const { env } = require("../config/env");
const { getCartBySessionId } = require("../models/cartModel");
const { getProductsForCheckoutByIds } = require("../models/productModel");
const { buildDisplayName, resolveCartLineItems } = require("../lib/cartLineResolver");
const { getUpcomingMarketByPickupDetails } = require("../models/marketModel");
const {
  createPendingOrder,
  setOrderStripeCheckoutSessionId
} = require("../models/orderModel");
const {
  attachReservationToCheckout,
  reserveWorkForCart
} = require("../models/workQueueModel");
const {
  normalizeShippingDetailsInput,
  resolveSelectedShippingOption
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

  const rawShippingMethod =
    typeof body.shippingMethod === "string" ? body.shippingMethod.trim() : "";
  const shippingMethod =
    rawShippingMethod || channel === "market"
      ? rawShippingMethod || "market"
      : "shipping";

  if (
    shippingMethod !== "shipping" &&
    shippingMethod !== "market" &&
    shippingMethod !== "local_delivery"
  ) {
    throw withStatusError(
      "shippingMethod must be one of 'shipping', 'market', or 'local_delivery'",
      400
    );
  }

  let shippingDetails = null;
  if (body.shippingDetails !== undefined && body.shippingDetails !== null) {
    shippingDetails =
      shippingMethod === "market"
        ? normalizeMarketPickupDetailsInput(body.shippingDetails)
        : normalizeShippingDetailsInput(body.shippingDetails, { requireName: false });
  }
  const selectedShippingOptionId =
    typeof body.selectedShippingOptionId === "string"
      ? body.selectedShippingOptionId.trim()
      : "";

  return {
    cartSessionId,
    channel,
    shippingMethod,
    shippingDetails,
    selectedShippingOptionId: selectedShippingOptionId || null
  };
}

function normalizeMarketPickupDetailsInput(value) {
  const raw = value && typeof value === "object" ? value : {};
  const addressSource =
    raw.address && typeof raw.address === "object" ? raw.address : raw;
  const marketIdSource =
    typeof raw.market_id === "string"
      ? raw.market_id
      : typeof raw.marketId === "string"
        ? raw.marketId
        : typeof raw.id === "string"
          ? raw.id
          : "";
  const startTimeSource =
    typeof raw.start_time === "string"
      ? raw.start_time
      : typeof raw.startTime === "string"
        ? raw.startTime
        : "";

  const normalized = {
    market_id: marketIdSource.trim(),
    name:
      typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : null,
    address: {
      line1:
        typeof addressSource.line1 === "string" && addressSource.line1.trim()
          ? addressSource.line1.trim()
          : "",
      line2:
        typeof addressSource.line2 === "string" && addressSource.line2.trim()
          ? addressSource.line2.trim()
          : null,
      city:
        typeof addressSource.city === "string" && addressSource.city.trim()
          ? addressSource.city.trim()
          : "",
      state:
        typeof addressSource.state === "string" && addressSource.state.trim()
          ? addressSource.state.trim().toUpperCase()
          : "",
      postalCode:
        typeof addressSource.postalCode === "string" && addressSource.postalCode.trim()
          ? addressSource.postalCode.trim()
          : null,
      country:
        typeof addressSource.country === "string" && addressSource.country.trim()
          ? addressSource.country.trim().toUpperCase()
          : "US"
    },
    start_time: typeof startTimeSource === "string" ? startTimeSource.trim() : ""
  };

  const missingField = normalized.market_id
    ? [
        ["country", normalized.address.country]
      ].find((entry) => !entry[1])
    : [
        ["line1", normalized.address.line1],
        ["city", normalized.address.city],
        ["state", normalized.address.state],
        ["country", normalized.address.country],
        ["start_time", normalized.start_time]
      ].find((entry) => !entry[1]);

  if (missingField) {
    throw withStatusError(
      missingField[0] === "start_time"
        ? "shippingDetails.start_time is required"
        : `shippingDetails.address.${missingField[0]} is required`,
      400
    );
  }

  const parsedStartTime = normalized.start_time ? new Date(normalized.start_time) : null;
  if (parsedStartTime && Number.isNaN(parsedStartTime.getTime())) {
    throw withStatusError("shippingDetails.start_time must be a valid ISO datetime", 400);
  }

  normalized.start_time = parsedStartTime ? parsedStartTime.toISOString() : "";
  return normalized;
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
  const invalidVariants = [];
  const workLimitViolations = [];
  let totalWorkDays = 0;
  const { resolvedItems } = resolveCartLineItems(productsById, cartItems);

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

    if (product.kind !== "commission_commitment") {
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

  if (missing.length > 0) {
    const error = withStatusError("One or more cart products were not found", 422);
    error.details = { missingProductIds: missing };
    throw error;
  }

  if (invalidVariants.length > 0) {
    const error = withStatusError(
      invalidVariants.some((item) => item.reason === "VARIANT_SELECTION_REQUIRED")
        ? "One or more cart items require a variant selection"
        : "One or more cart items include an invalid variant selection",
      422
    );
    error.details = invalidVariants;
    throw error;
  }

  if (totalWorkDays > env.maxCartWorkDays) {
    for (const item of resolvedItems) {
      if (item.validationReason) {
        continue;
      }

      const product = productsById.get(item.productId);
      if (!product || product.kind === "commission_commitment") {
        continue;
      }

      workLimitViolations.push({
        lineId: item.lineId || undefined,
        productId: item.productId,
        variantId: item.variantId || undefined,
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
        sku: String(item.sku),
        variant_id: item.variantId ? String(item.variantId) : "",
        variant_label: item.variantLabel ? String(item.variantLabel) : "",
        option_summary: item.optionSummary ? String(item.optionSummary) : ""
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
      mail_class: quote.mailClass || "",
      option_id: quote.optionId || "",
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

async function validateMarketPickupDetails(pool, shippingDetails) {
  if (
    !shippingDetails ||
    !shippingDetails.address ||
    (!shippingDetails.market_id && !shippingDetails.start_time)
  ) {
    throw withStatusError("shippingDetails are required for market pickup", 400);
  }

  const market = await getUpcomingMarketByPickupDetails(pool, {
    marketId: shippingDetails.market_id,
    streetAddress: shippingDetails.address.line1,
    city: shippingDetails.address.city,
    state: shippingDetails.address.state,
    startTime: shippingDetails.start_time
  });

  if (!market) {
    throw withStatusError(
      "The selected market pickup event is no longer available. Please refresh checkout and choose another market.",
      422
    );
  }

  return {
    ...shippingDetails,
    market_id: market.marketId || shippingDetails.market_id || null,
    market_title: market.title || null,
    market_description: market.description || null,
    market_link: market.link || null,
    address: {
      line1: market.streetAddress || market.address || shippingDetails.address.line1,
      line2: shippingDetails.address.line2 || null,
      city: market.city || shippingDetails.address.city,
      state: market.state || shippingDetails.address.state,
      postalCode: shippingDetails.address.postalCode || null,
      country: shippingDetails.address.country || "US"
    },
    start_time: market.startTime || market.start,
    end_time: market.endTime || null
  };
}

function buildCheckoutMetadata({
  cartSessionId,
  channel,
  orderId,
  shippingMethod,
  shippingDetails,
  workReservation
}) {
  const metadata = {
    cart_session_id: cartSessionId,
    channel,
    order_id: orderId,
    shipping_method: shippingMethod,
    work_reservation_id: workReservation ? workReservation.id : "",
    ship_by_date: workReservation ? workReservation.shipByDate || "" : ""
  };

  if (shippingMethod === "market" && shippingDetails && shippingDetails.address) {
    metadata.market_pickup_market_id = shippingDetails.market_id || "";
    metadata.market_pickup_title = shippingDetails.market_title || "";
    metadata.market_pickup_start_time = shippingDetails.start_time || "";
    metadata.market_pickup_end_time = shippingDetails.end_time || "";
    metadata.market_pickup_line1 = shippingDetails.address.line1 || "";
    metadata.market_pickup_city = shippingDetails.address.city || "";
    metadata.market_pickup_state = shippingDetails.address.state || "";
    metadata.market_pickup_postal_code = shippingDetails.address.postalCode || "";
    metadata.market_pickup_country = shippingDetails.address.country || "US";
    metadata.market_pickup_link = shippingDetails.market_link || "";
  }

  return metadata;
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
      const { resolvedItems: resolvedCartItems } = resolveCartLineItems(productsById, cart.items);
      const preparedItems = buildPreparedOrderItems({
        cartItems: cart.items,
        productsById
      });

      if (normalized.shippingMethod === "local_delivery") {
        throw withStatusError("Local delivery checkout is not available yet", 422);
      }

      const requiresShipping =
        normalized.shippingMethod === "shipping" &&
        normalized.channel === "online" &&
        resolvedCartItems.some(
          (item) => !item.validationReason && item.kind && item.kind !== "commission_commitment"
        );
      let shippingQuote = null;
      let shippingDetails = null;

      if (requiresShipping) {
        validateShippingDetailsForCheckout(normalized.shippingDetails);
        if (!normalized.selectedShippingOptionId) {
          throw withStatusError("selectedShippingOptionId is required", 400);
        }

        shippingDetails = normalized.shippingDetails;
        const quoteResult = await resolveSelectedShippingOption({
          productsById,
          cartItems: resolvedCartItems,
          shippingDetails,
          selectedOptionId: normalized.selectedShippingOptionId
        });
        shippingQuote = quoteResult.selectedOption;
      } else if (normalized.shippingMethod === "market") {
        shippingDetails = await validateMarketPickupDetails(pool, normalized.shippingDetails);
      }

      const workReservation = await reserveWorkForCart(pool, {
        cartSessionId,
        items: preparedItems
      });

      const pendingOrder = await createPendingOrder(pool, {
        cartSessionId,
        channel: normalized.channel,
        currency: String(env.priceCurrency || "USD").toUpperCase(),
        items: preparedItems,
        shippingMethod:
          normalized.shippingMethod === "market"
            ? "market"
            : shippingQuote
              ? shippingQuote.serviceName
              : null,
        shippingAmount: normalized.shippingMethod === "market" ? 0 : shippingQuote ? shippingQuote.amountCents : null,
        shippingDetails,
        shippingQuote,
        shipByDate: workReservation ? workReservation.shipByDate : null
      });

      const appBaseUrl = requireAppBaseUrl();
      const stripe = getStripeClient();
      const customerId = requiresShipping
        ? await createStripeCustomer(stripe, shippingDetails)
        : null;
      const sessionPayload = {
        mode: "payment",
        line_items: buildStripeLineItems(preparedItems),
        automatic_tax: { enabled: true },
        billing_address_collection: "required",
        success_url: `${appBaseUrl}/checkout/success?order_id=${encodeURIComponent(
          pendingOrder.id
        )}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appBaseUrl}/checkout?cancelled_order_id=${encodeURIComponent(
          pendingOrder.id
        )}`,
        client_reference_id: cartSessionId,
        metadata: buildCheckoutMetadata({
          cartSessionId,
          channel: normalized.channel,
          orderId: pendingOrder.id,
          shippingMethod: normalized.shippingMethod,
          shippingDetails,
          workReservation
        })
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

      if (workReservation) {
        await attachReservationToCheckout(pool, {
          reservationId: workReservation.id,
          cartSessionId,
          orderId: pendingOrder.id,
          stripeCheckoutSessionId: session.id
        });
      }

      return res.status(201).json({
        checkoutUrl: session.url,
        orderId: pendingOrder.id,
        workReservation
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
