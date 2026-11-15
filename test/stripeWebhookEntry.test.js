"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStripeWebhookEntry } = require("../src/handlers/apiHandler");

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function setup() {
  const calls = [];
  const entry = createStripeWebhookEntry({
    stripeWebhookHandler: async (req, res) => {
      calls.push(req.path);
      return res.status(200).json({ received: true });
    }
  });
  return { entry, calls };
}

for (const path of ["/api/stripe/webhook", "/api/stripe/webhook/", "/stripe/webhook"]) {
  test(`public webhook entry forwards ${path} to the Stripe handler`, async () => {
    const { entry, calls } = setup();
    const res = fakeRes();
    await entry({ method: "POST", path }, res);
    assert.deepEqual(calls, [path]);
    assert.equal(res.statusCode, 200);
  });
}

// The webhook function is public, so it must not expose any other API route.
for (const path of [
  "/",
  "/products/prod_1",
  "/cart/sess_1",
  "/api/orders/ord_1",
  "/api/checkout/session",
  "/api/shipping/quote",
  "/markets",
  "/api/stripe/webhook/extra",
  "/api/stripe/webhooks"
]) {
  test(`public webhook entry returns 404 for ${path} without calling the handler`, async () => {
    const { entry, calls } = setup();
    const res = fakeRes();
    await entry({ method: "GET", path }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(calls, []);
  });
}

test("query strings do not bypass the path check", async () => {
  const { entry, calls } = setup();
  const res = fakeRes();
  await entry({ method: "GET", url: "/products/prod_1?x=/api/stripe/webhook" }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(calls, []);
});
