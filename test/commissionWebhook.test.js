"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { env } = require("../src/config/env");
const { getStripeClient } = require("../src/lib/stripeClient");
const { createStripeWebhookHandler } = require("../src/handlers/stripeWebhookHandler");

test("signed checkout events wait for payment and support delayed and zero-balance payments", async () => {
  env.stripeSecretKey = "sk_test_offline_fixture";
  env.stripeWebhookSecret = "whsec_offline_fixture";
  const stripe = getStripeClient();
  let calls = 0;
  const handler = createStripeWebhookHandler({
    getPool: () => ({}),
    reconcileCheckout: async () => { calls++; return { orderId: "order-test", alreadyPaid: false }; }
  });
  for (const [type, payment_status, expectedCalls] of [
    ["checkout.session.completed", "unpaid", 0],
    ["checkout.session.async_payment_succeeded", "paid", 1],
    ["checkout.session.completed", "paid", 2],
    ["checkout.session.completed", "no_payment_required", 3],
  ]) {
    const payload = JSON.stringify({ id: "evt_fixture", type, data: { object: { id: "cs_fixture", payment_status } } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: env.stripeWebhookSecret });
    let status, body;
    const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
    await handler({ method: "POST", headers: { "stripe-signature": signature }, rawBody: Buffer.from(payload) }, res);
    assert.equal(status, 200);
    assert.equal(calls, expectedCalls);
    assert.equal(body.orderProcessed === null, payment_status === "unpaid");
  }
});
