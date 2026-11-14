"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildDigitalDeliveryCustomerEmail,
  buildOrderConfirmationCustomerEmail
} = require("../src/lib/orderEmailTemplates");

function makeDigitalOrder() {
  return {
    id: "order-digital-1",
    status: "paid",
    currency: "USD",
    taxAmount: 0,
    totalAmount: 1200,
    items: [
      {
        productId: "pattern_1",
        productKind: "digital",
        name: "Blueberry Pattern",
        quantity: 1,
        unitAmount: 1200
      }
    ]
  };
}

test("digital-only confirmation describes secure delivery instead of production and shipping", () => {
  const email = buildOrderConfirmationCustomerEmail({
    order: makeDigitalOrder(),
    shippingDetails: null,
    shippingMethod: null,
    shippingAmount: 0,
    taxSummary: { amount: 0, jurisdictions: [] }
  });

  assert.match(email.html, /preparing your personalized PDF/);
  assert.match(email.html, /Digital delivery/);
  assert.doesNotMatch(email.html, /Shipping Information/);
  assert.doesNotMatch(email.html, /getting it into our work queue/);
});

test("digital delivery email includes the licensed copy and private fragment link", () => {
  const email = buildDigitalDeliveryCustomerEmail({
    orderId: "order-digital-1",
    downloads: [
      {
        productName: "Blueberry Pattern",
        assetLabel: "Primary download",
        copyId: "SS-1234-5678-90AB",
        expiresAt: "2026-08-22T00:00:00.000Z",
        downloadLimit: 5,
        accessUrl: "https://www.soggystitches.com/downloads/access#grant=secret"
      }
    ]
  });

  assert.match(email.html, /SS-1234-5678-90AB/);
  assert.match(email.html, /www\.soggystitches\.com/);
  assert.match(email.html, /#grant=secret/);
});
