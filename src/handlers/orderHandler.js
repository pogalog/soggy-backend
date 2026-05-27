"use strict";

const { getStripeClient } = require("../lib/stripeClient");
const {
  cancelPendingOrder,
  getOrderById,
  getOrderRecordById,
  getOrderRecordByStripeCheckoutSessionId,
  markOrderCheckoutCancelled
} = require("../models/orderModel");

function extractCheckoutShippingDetails(session) {
  const shippingDetails =
    session &&
    session.collected_information &&
    session.collected_information.shipping_details
      ? session.collected_information.shipping_details
      : session && session.shipping_details
        ? session.shipping_details
        : null;

  if (!shippingDetails || typeof shippingDetails !== "object") {
    return null;
  }

  const address =
    shippingDetails.address && typeof shippingDetails.address === "object"
      ? shippingDetails.address
      : null;

  return {
    name:
      typeof shippingDetails.name === "string" && shippingDetails.name.trim()
        ? shippingDetails.name.trim()
        : null,
    address: address
      ? {
          line1:
            typeof address.line1 === "string" && address.line1.trim()
              ? address.line1.trim()
              : null,
          line2:
            typeof address.line2 === "string" && address.line2.trim()
              ? address.line2.trim()
              : null,
          city:
            typeof address.city === "string" && address.city.trim()
              ? address.city.trim()
              : null,
          state:
            typeof address.state === "string" && address.state.trim()
              ? address.state.trim()
              : null,
          postalCode:
            typeof address.postal_code === "string" && address.postal_code.trim()
              ? address.postal_code.trim()
              : null,
          country:
            typeof address.country === "string" && address.country.trim()
              ? address.country.trim()
              : null
        }
      : null
  };
}

function extractCheckoutCustomerName(session) {
  const candidates = [
    session && session.customer_details && session.customer_details.name,
    session && session.shipping_details && session.shipping_details.name,
    session &&
      session.collected_information &&
      session.collected_information.shipping_details &&
      session.collected_information.shipping_details.name
  ];

  const name = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );

  return name ? name.trim() : null;
}

function buildTaxSummary(session, order) {
  const breakdown =
    session &&
    session.total_details &&
    session.total_details.breakdown &&
    Array.isArray(session.total_details.breakdown.taxes)
      ? session.total_details.breakdown.taxes
      : [];

  const jurisdictions = Array.from(
    new Set(
      breakdown
        .map((tax) => {
          const rate = tax && tax.rate && typeof tax.rate === "object" ? tax.rate : null;
          return rate && typeof rate.jurisdiction === "string" && rate.jurisdiction.trim()
            ? rate.jurisdiction.trim()
            : null;
        })
        .filter(Boolean)
    )
  );

  const amount = Number(session && session.total_details && session.total_details.amount_tax);
  return {
    amount: Number.isFinite(amount) ? amount : Number(order.taxAmount || 0),
    jurisdictions
  };
}

function resolveShippingMethod(session, order) {
  if (order && typeof order.shippingMethod === "string" && order.shippingMethod.trim()) {
    return order.shippingMethod.trim();
  }

  const metadataMethod =
    session && session.metadata && typeof session.metadata.shipping_method === "string"
      ? session.metadata.shipping_method.trim()
      : "";
  if (metadataMethod === "market" || metadataMethod === "local_delivery") {
    return metadataMethod;
  }

  const shippingAmount = Number(
    session && session.total_details && session.total_details.amount_shipping
  );

  return shippingAmount > 0 ? "Standard shipping" : null;
}

function resolveShippingAmount(session, order) {
  const shippingAmount = Number(
    session && session.total_details && session.total_details.amount_shipping
  );
  if (Number.isFinite(shippingAmount)) {
    return shippingAmount;
  }

  return order && Number.isFinite(Number(order.shippingAmount))
    ? Number(order.shippingAmount)
    : null;
}

function resolveShippingDetails(session, order) {
  const customerName = extractCheckoutCustomerName(session);
  if (order && order.shippingDetails && typeof order.shippingDetails === "object") {
    return withResolvedCustomerName(order.shippingDetails, customerName);
  }

  const shippingMethod = resolveShippingMethod(session, order);
  if (shippingMethod === "market") {
    return extractMarketPickupDetails(session, customerName);
  }

  return withResolvedCustomerName(extractCheckoutShippingDetails(session), customerName);
}

function withResolvedCustomerName(shippingDetails, customerName) {
  if (!shippingDetails || typeof shippingDetails !== "object") {
    return shippingDetails;
  }

  if (
    typeof shippingDetails.name === "string" &&
    shippingDetails.name.trim()
  ) {
    return shippingDetails;
  }

  if (!customerName) {
    return shippingDetails;
  }

  return {
    ...shippingDetails,
    name: customerName
  };
}

function extractMarketPickupDetails(session, customerName) {
  const metadata = session && session.metadata && typeof session.metadata === "object"
    ? session.metadata
    : {};
  const startTime =
    typeof metadata.market_pickup_start_time === "string" &&
    metadata.market_pickup_start_time.trim()
      ? metadata.market_pickup_start_time.trim()
      : null;
  const endTime =
    typeof metadata.market_pickup_end_time === "string" &&
    metadata.market_pickup_end_time.trim()
      ? metadata.market_pickup_end_time.trim()
      : null;
  const marketTitle =
    typeof metadata.market_pickup_title === "string" && metadata.market_pickup_title.trim()
      ? metadata.market_pickup_title.trim()
      : null;
  const marketLink =
    typeof metadata.market_pickup_link === "string" && metadata.market_pickup_link.trim()
      ? metadata.market_pickup_link.trim()
      : null;
  const line1 =
    typeof metadata.market_pickup_line1 === "string" && metadata.market_pickup_line1.trim()
      ? metadata.market_pickup_line1.trim()
      : null;
  const city =
    typeof metadata.market_pickup_city === "string" && metadata.market_pickup_city.trim()
      ? metadata.market_pickup_city.trim()
      : null;
  const state =
    typeof metadata.market_pickup_state === "string" && metadata.market_pickup_state.trim()
      ? metadata.market_pickup_state.trim()
      : null;
  const country =
    typeof metadata.market_pickup_country === "string" && metadata.market_pickup_country.trim()
      ? metadata.market_pickup_country.trim()
      : "US";
  const postalCode =
    typeof metadata.market_pickup_postal_code === "string" &&
    metadata.market_pickup_postal_code.trim()
      ? metadata.market_pickup_postal_code.trim()
      : null;

  if (!startTime || !line1 || !city || !state) {
    return null;
  }

  return {
    name: customerName,
    address: {
      line1,
      line2: null,
      city,
      state,
      postalCode,
      country
    },
    start_time: startTime,
    end_time: endTime,
    market_title: marketTitle,
    market_link: marketLink
  };
}

function toOrderLookupResponse(order, session) {
  const { stripeCheckoutSessionId, ...publicOrder } = order;
  return {
    ...publicOrder,
    shippingMethod: resolveShippingMethod(session, order),
    shippingAmount: resolveShippingAmount(session, order),
    shippingDetails: resolveShippingDetails(session, order),
    taxSummary: buildTaxSummary(session, order)
  };
}

async function loadStripeSession(order) {
  if (!order || !order.stripeCheckoutSessionId) {
    return null;
  }

  try {
    const stripe = getStripeClient();
    return await stripe.checkout.sessions.retrieve(order.stripeCheckoutSessionId);
  } catch (error) {
    console.warn("Unable to enrich order lookup with Stripe session details", {
      orderId: order.id,
      stripeCheckoutSessionId: order.stripeCheckoutSessionId,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

function extractOrderId(req) {
  if (req.params && typeof req.params.id === "string" && req.params.id.trim()) {
    return req.params.id.trim();
  }

  if (req.query && typeof req.query.id === "string" && req.query.id.trim()) {
    return req.query.id.trim();
  }

  const path = req.path || req.url || "";
  const match = path.match(/^\/(?:api\/)?orders\/([^/]+)\/?$/);
  if (!match || !match[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

function extractCheckoutSessionId(req) {
  if (
    req.query &&
    typeof req.query.checkoutSessionId === "string" &&
    req.query.checkoutSessionId.trim()
  ) {
    return req.query.checkoutSessionId.trim();
  }

  return null;
}

function createOrderHandler({ getPool }) {
  return async function orderHandler(req, res) {
    const orderId = extractOrderId(req);
    const checkoutSessionId = extractCheckoutSessionId(req);
    if (!orderId && !(req.method === "GET" && checkoutSessionId)) {
      return res
        .status(400)
        .json({
          error:
            "Missing order id. Use /orders/:id, ?id=<orderId>, or ?checkoutSessionId=<sessionId>"
        });
    }

    try {
      const pool = getPool();
      if (req.method === "GET") {
        const order = checkoutSessionId
          ? await getOrderRecordByStripeCheckoutSessionId(pool, checkoutSessionId)
          : await getOrderRecordById(pool, orderId);

        if (!order) {
          if (checkoutSessionId) {
            return res.status(202).json({
              status: "processing",
              message: "Order confirmation is still processing."
            });
          }

          return res.status(404).json({ error: "Order not found" });
        }

        const stripeSession = await loadStripeSession(order);
        return res.status(200).json(toOrderLookupResponse(order, stripeSession));
      }

      if (req.method === "POST") {
        const body = parseJsonBody(req);
        const action =
          body && typeof body.action === "string" ? body.action.trim().toLowerCase() : "";
        if (action !== "cancel" && action !== "checkout_cancelled") {
          throw withStatusError("Unsupported order action", 400);
        }

        const result =
          action === "cancel"
            ? await cancelPendingOrder(pool, { orderId })
            : await markOrderCheckoutCancelled(pool, { orderId });
        const order = await getOrderById(pool, orderId);

        return res.status(200).json({
          action,
          changed: result.changed,
          order
        });
      }

      res.set("Allow", "GET, POST");
      return res.status(405).json({ error: "Method not allowed" });
    } catch (error) {
      if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
      console.error("Failed to handle order request", {
        method: req.method,
        orderId,
        message: error.message
      });
      const publicMessage = statusCode >= 500 ? "Internal server error" : error.message;
      return res.status(statusCode).json({ error: publicMessage });
    }
  };
}

module.exports = {
  createOrderHandler
};
