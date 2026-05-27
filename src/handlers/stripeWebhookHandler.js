"use strict";

const { env } = require("../config/env");
const { getStripeClient } = require("../lib/stripeClient");
const { sendMail } = require("../lib/mailer");
const { fetchJsonFromGcs } = require("../lib/gcsJsonClient");
const {
  buildOrderConfirmationBusinessEmail,
  buildOrderConfirmationCustomerEmail
} = require("../lib/orderEmailTemplates");
const {
  buildCommissionCustomerDecisionBusinessEmail,
  buildCommissionCustomerDecisionCustomerEmail
} = require("../lib/commissionEmailTemplates");
const { getCommissionForFollowUp } = require("../models/commissionModel");
const {
  createPaidOrderFromCheckoutSession,
  getOrderById,
  markOrderPaidAndDecrementInventory
} = require("../models/orderModel");

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getStripeSignature(req) {
  const signature = req.headers && (req.headers["stripe-signature"] || req.headers["Stripe-Signature"]);
  if (!signature || typeof signature !== "string") {
    throw withStatusError("Missing Stripe-Signature header", 400);
  }

  return signature;
}

function getRawBodyBuffer(req) {
  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (typeof req.body === "string") {
    return Buffer.from(req.body, "utf8");
  }

  // Do not reconstruct JSON from req.body objects; signature verification requires the original bytes.
  throw withStatusError(
    "Raw request body unavailable for Stripe signature verification",
    500
  );
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function normalizeStripeCurrency(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  return value.trim().toUpperCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function extractCustomerEmail(meta) {
  const candidates = [
    meta && meta.customerEmail,
    meta && meta.customer && meta.customer.email,
    meta && meta.form && meta.form.customerEmail,
    meta && meta.request && meta.request.customerEmail,
    meta && meta.request && meta.request.customer && meta.request.customer.email,
    meta && meta.request && meta.request.form && meta.request.form.customerEmail,
    meta && meta.payload && meta.payload.customerEmail,
    meta && meta.payload && meta.payload.customer && meta.payload.customer.email,
    meta && meta.payload && meta.payload.form && meta.payload.form.customerEmail
  ];

  const email = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );

  if (!email || !isValidEmail(email.trim())) {
    throw withStatusError(
      "Unable to determine customer email from commission meta.json",
      422
    );
  }

  return email.trim();
}

function extractCheckoutCustomerEmail(session) {
  const candidates = [
    session && session.customer_details && session.customer_details.email,
    session && session.customer_email
  ];

  const email = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );

  if (!email || !isValidEmail(email.trim())) {
    return null;
  }

  return email.trim();
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

function buildTaxSummary(session) {
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

  return {
    amount: Number(session && session.total_details && session.total_details.amount_tax),
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

function extractCheckoutChannel(session) {
  const channel =
    session && session.metadata && typeof session.metadata.channel === "string"
      ? session.metadata.channel.trim()
      : "";

  return channel === "market" ? "market" : "online";
}

function extractCheckoutCartSessionId(session) {
  const metadataCartSessionId =
    session && session.metadata && typeof session.metadata.cart_session_id === "string"
      ? session.metadata.cart_session_id.trim()
      : "";

  if (metadataCartSessionId) {
    return metadataCartSessionId;
  }

  return typeof session.client_reference_id === "string" && session.client_reference_id.trim()
    ? session.client_reference_id.trim()
    : null;
}

function readProductMetadata(product, key) {
  return product &&
    typeof product === "object" &&
    product.metadata &&
    typeof product.metadata === "object" &&
    typeof product.metadata[key] === "string" &&
    product.metadata[key].trim()
    ? product.metadata[key].trim()
    : null;
}

function normalizeCheckoutLineItem(lineItem) {
  const price = lineItem && lineItem.price && typeof lineItem.price === "object" ? lineItem.price : null;
  const product =
    price && price.product && typeof price.product === "object" ? price.product : null;
  const productId = readProductMetadata(product, "product_id");
  const sku = readProductMetadata(product, "sku") || productId;
  const variantId = readProductMetadata(product, "variant_id");
  const variantLabel = readProductMetadata(product, "variant_label");
  const optionSummary = readProductMetadata(product, "option_summary");
  const name =
    typeof lineItem.description === "string" && lineItem.description.trim()
      ? lineItem.description.trim()
      : product && typeof product.name === "string" && product.name.trim()
        ? product.name.trim()
        : null;
  const unitAmount =
    price && Number.isInteger(Number(price.unit_amount))
      ? Number(price.unit_amount)
      : Number(lineItem.amount_subtotal) > 0 && Number(lineItem.quantity) > 0
        ? Math.round(Number(lineItem.amount_subtotal) / Number(lineItem.quantity))
        : null;
  const quantity = Number(lineItem.quantity);
  const stripeThumbUrl =
    product &&
    Array.isArray(product.images) &&
    typeof product.images[0] === "string" &&
    product.images[0].trim()
      ? product.images[0].trim()
      : null;

  if (!productId || !sku || !name || !Number.isInteger(unitAmount) || !Number.isInteger(quantity) || quantity <= 0) {
    return null;
  }

  return {
    lineId: `ordln_${lineItem.id || sku || productId}`,
    productId,
    variantId,
    variantLabel,
    optionSummary,
    sku,
    name,
    unitAmount,
    quantity,
    stripeThumbUrl
  };
}

async function listCheckoutOrderItems(stripe, sessionId) {
  const items = [];
  let startingAfter = null;

  while (true) {
    const page = await stripe.checkout.sessions.listLineItems(sessionId, {
      limit: 100,
      starting_after: startingAfter || undefined,
      expand: ["data.price.product"]
    });

    for (const rawItem of page.data || []) {
      const item = normalizeCheckoutLineItem(rawItem);
      if (item) {
        items.push(item);
      }
    }

    if (!page.has_more || !Array.isArray(page.data) || page.data.length === 0) {
      break;
    }

    startingAfter = page.data[page.data.length - 1].id;
  }

  return items;
}

async function notifyBusinessOfCommittedCommission(pool, commissionId) {
  const commission = await getCommissionForFollowUp(pool, commissionId);
  if (!commission) {
    throw withStatusError(`Commission not found for order item ${commissionId}`, 404);
  }

  let customerEmail = null;
  try {
    const meta = await fetchJsonFromGcs({
      bucketName: commission.storageBucket || env.commissionGcsBucket,
      objectPath: commission.metaPath
    });
    customerEmail = extractCustomerEmail(meta);
  } catch (error) {
    console.warn("Unable to load customer email for committed commission notice", {
      commissionId,
      message: error instanceof Error ? error.message : String(error)
    });
  }

  const emailMessage = buildCommissionCustomerDecisionBusinessEmail({
    commission: {
      ...commission,
      status: "customer_committed"
    },
    action: "commit",
    customerEmail: customerEmail || "Not available"
  });
  const customerEmailMessage = buildCommissionCustomerDecisionCustomerEmail({
    commission: {
      ...commission,
      status: "customer_committed"
    },
    action: "commit"
  });

  await sendMail({
    from: env.commissionFromEmail,
    to: env.commissionBusinessEmail,
    replyTo: customerEmail || env.commissionFromEmail,
    subject: emailMessage.subject,
    html: emailMessage.html
  });

  if (customerEmail) {
    await sendMail({
      from: env.commissionFromEmail,
      to: customerEmail,
      replyTo: env.commissionFromEmail,
      subject: customerEmailMessage.subject,
      html: customerEmailMessage.html
    });
  }
}

async function handleCheckoutSessionCompleted(pool, session) {
  const metadata = session && session.metadata ? session.metadata : {};
  const orderId =
    metadata && typeof metadata.order_id === "string" && metadata.order_id.trim()
      ? metadata.order_id.trim()
      : null;

  const stripeCheckoutSessionId =
    typeof session.id === "string" && session.id.trim() ? session.id.trim() : null;
  if (!stripeCheckoutSessionId) {
    throw withStatusError("Stripe checkout.session.completed missing session id", 400);
  }

  let result;
  let resolvedOrderId = orderId;
  const existingOrder = resolvedOrderId ? await getOrderById(pool, resolvedOrderId) : null;

  if (resolvedOrderId) {
    const resolvedShippingDetails = resolveShippingDetails(session, existingOrder);
    result = await markOrderPaidAndDecrementInventory(pool, {
      orderId: resolvedOrderId,
      stripeCheckoutSessionId,
      stripePaymentIntentId:
        typeof session.payment_intent === "string" ? session.payment_intent : null,
      currency: normalizeStripeCurrency(session.currency),
      amountSubtotal: Number(session.amount_subtotal),
      amountShipping: Number(session.total_details && session.total_details.amount_shipping),
      amountTax: Number(session.total_details && session.total_details.amount_tax),
      amountTotal: Number(session.amount_total),
      shippingDetails: resolvedShippingDetails,
      shippingMethod:
        existingOrder && typeof existingOrder.shippingMethod === "string"
          ? existingOrder.shippingMethod
          : resolveShippingMethod(session, existingOrder)
    });
  } else {
    const cartSessionId = extractCheckoutCartSessionId(session);
    if (!cartSessionId) {
      throw withStatusError(
        "Stripe checkout.session.completed missing cart session identifier",
        400
      );
    }

    const stripe = getStripeClient();
    const orderItems = await listCheckoutOrderItems(stripe, stripeCheckoutSessionId);
    const resolvedShippingDetails = resolveShippingDetails(session, null);
    result = await createPaidOrderFromCheckoutSession(pool, {
      cartSessionId,
      channel: extractCheckoutChannel(session),
      currency: normalizeStripeCurrency(session.currency) || String(env.priceCurrency || "USD").toUpperCase(),
      items: orderItems,
      stripeCheckoutSessionId,
      stripePaymentIntentId:
        typeof session.payment_intent === "string" ? session.payment_intent : null,
      amountSubtotal: Number(session.amount_subtotal),
      amountShipping: Number(session.total_details && session.total_details.amount_shipping),
      amountTax: Number(session.total_details && session.total_details.amount_tax),
      amountTotal: Number(session.amount_total),
      shippingMethod: resolveShippingMethod(session, null),
      shippingDetails: resolvedShippingDetails
    });
    resolvedOrderId = result.orderId;
  }

  if (result && result.alreadyPaid === false) {
    const customerEmail = extractCheckoutCustomerEmail(session);
    let orderForEmail = null;
    const loadOrderForEmail = async () => {
      if (orderForEmail) {
        return orderForEmail;
      }

      orderForEmail = await getOrderById(pool, resolvedOrderId);
      if (!orderForEmail) {
        throw withStatusError("Order not found after payment reconciliation", 404);
      }

      return orderForEmail;
    };

    if (!customerEmail) {
      console.warn("Checkout completed without customer email; skipping confirmation email", {
        orderId: resolvedOrderId,
        stripeCheckoutSessionId
      });
    } else {
      try {
        const order = await loadOrderForEmail();
        const emailMessage = buildOrderConfirmationCustomerEmail({
          order,
          shippingDetails: resolveShippingDetails(session, order),
          shippingMethod: resolveShippingMethod(session, order),
          shippingAmount: Number(session.total_details && session.total_details.amount_shipping),
          taxSummary: buildTaxSummary(session)
        });
        await sendMail({
          from: env.commissionFromEmail,
          to: customerEmail,
          replyTo: env.commissionFromEmail,
          subject: emailMessage.subject,
          html: emailMessage.html
        });
      } catch (error) {
        console.error("Failed to send order confirmation email", {
          orderId: resolvedOrderId,
          stripeCheckoutSessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }

    try {
      const order = await loadOrderForEmail();
      const businessEmailMessage = buildOrderConfirmationBusinessEmail({
        order,
        customerEmail,
        shippingDetails: resolveShippingDetails(session, order),
        shippingMethod: resolveShippingMethod(session, order),
        shippingAmount: Number(session.total_details && session.total_details.amount_shipping),
        taxSummary: buildTaxSummary(session)
      });
      await sendMail({
        from: env.commissionFromEmail,
        to: env.commissionBusinessEmail,
        replyTo: customerEmail || env.commissionFromEmail,
        subject: businessEmailMessage.subject,
        html: businessEmailMessage.html
      });
    } catch (error) {
      console.error("Failed to send business order notification email", {
        orderId: resolvedOrderId,
        stripeCheckoutSessionId,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  if (
    result &&
    result.alreadyPaid === false &&
    Array.isArray(result.committedCommissionIds) &&
    result.committedCommissionIds.length > 0
  ) {
    for (const commissionId of result.committedCommissionIds) {
      await notifyBusinessOfCommittedCommission(pool, commissionId);
    }
  }

  return result;
}

function createStripeWebhookHandler({ getPool }) {
  return async function stripeWebhookHandler(req, res) {
    try {
      if (req.method !== "POST") {
        return methodNotAllowed(res);
      }

      if (!env.stripeWebhookSecret) {
        throw withStatusError("STRIPE_WEBHOOK_SECRET is not configured", 500);
      }

      const stripe = getStripeClient();
      const signature = getStripeSignature(req);
      const rawBody = getRawBodyBuffer(req);

      // Stripe requires the exact raw request bytes for signature verification.
      const event = stripe.webhooks.constructEvent(
        rawBody,
        signature,
        env.stripeWebhookSecret
      );

      const pool = getPool();
      let processingResult = null;

      switch (event.type) {
        case "checkout.session.completed":
          processingResult = await handleCheckoutSessionCompleted(pool, event.data.object);
          break;
        case "checkout.session.async_payment_failed":
          // TODO: mark order payment failed and release reservations (if reservation is added).
          break;
        case "charge.refunded":
          // TODO: add refund handling and inventory reconciliation policy.
          break;
        default:
          break;
      }

      return res.status(200).json({
        received: true,
        eventType: event.type,
        orderProcessed:
          processingResult && typeof processingResult.alreadyPaid === "boolean"
            ? {
                orderId: processingResult.orderId,
                alreadyPaid: processingResult.alreadyPaid
              }
            : null
      });
    } catch (error) {
      const message = typeof error.message === "string" ? error.message : "Webhook error";
      const isSignatureError =
        error && typeof error.type === "string" && error.type === "StripeSignatureVerificationError";
      const statusCode =
        typeof error.statusCode === "number"
          ? error.statusCode
          : isSignatureError
            ? 400
            : 500;

      const logPayload = {
        method: req.method,
        path: req.path || req.url,
        message,
        type: error.type,
        code: error.code
      };

      if (statusCode >= 500) {
        console.error("Failed to process Stripe webhook", logPayload);
      } else {
        console.warn("Rejected Stripe webhook", logPayload);
      }

      return res.status(statusCode).json({
        error: statusCode === 500 ? "Internal server error" : message
      });
    }
  };
}

module.exports = {
  createStripeWebhookHandler
};
