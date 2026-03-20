"use strict";

const { env } = require("../config/env");
const { getStripeClient } = require("../lib/stripeClient");
const { sendMail } = require("../lib/mailer");
const { fetchJsonFromGcs } = require("../lib/gcsJsonClient");
const {
  buildCommissionCustomerDecisionBusinessEmail,
  buildCommissionCustomerDecisionCustomerEmail
} = require("../lib/commissionEmailTemplates");
const { getCommissionForFollowUp } = require("../models/commissionModel");
const { markOrderPaidAndDecrementInventory } = require("../models/orderModel");

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

  if (!orderId) {
    throw withStatusError(
      "Stripe checkout.session.completed missing metadata.order_id",
      400
    );
  }

  const result = await markOrderPaidAndDecrementInventory(pool, {
    orderId,
    stripeCheckoutSessionId: typeof session.id === "string" ? session.id : null,
    stripePaymentIntentId:
      typeof session.payment_intent === "string" ? session.payment_intent : null,
    currency: normalizeStripeCurrency(session.currency),
    amountSubtotal: Number(session.amount_subtotal),
    amountTax: Number(session.total_details && session.total_details.amount_tax),
    amountTotal: Number(session.amount_total)
  });

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
