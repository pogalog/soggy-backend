"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { env } = require("../src/config/env");
const {
  createShippingQuoteToken,
  verifyShippingQuoteToken
} = require("../src/lib/shippingQuoteToken");

const shippingDetails = {
  name: "Test Customer",
  address: {
    line1: "123 Main St",
    line2: null,
    city: "Atlanta",
    state: "GA",
    postalCode: "30301",
    country: "US"
  }
};
const packageSummary = {
  weightLbs: 1.25,
  dimensionsIn: { length: 10, width: 8, height: 4 },
  totalUnits: 1
};
const option = {
  optionId: "USPS:PRIORITY_MAIL",
  carrier: "USPS",
  serviceCode: null,
  mailClass: "PRIORITY_MAIL",
  serviceName: "Priority Mail",
  amountCents: 995,
  currency: "USD",
  amountDisplay: "$9.95",
  businessDaysInTransit: 2,
  estimatedDeliveryDate: "2026-07-22",
  estimatedDeliveryTime: null,
  negotiated: false,
  quotedAt: "2026-07-20T04:00:00.000Z"
};

test.beforeEach(() => {
  env.shippingQuoteSigningSecret = "test-secret-with-at-least-thirty-two-characters";
  env.shippingQuoteTtlSeconds = 1800;
});

test("signed quote can be selected without another carrier request", () => {
  const token = createShippingQuoteToken({
    cartSessionId: "sess_123",
    shippingDetails,
    packageSummary,
    options: [option],
    now: 1_000_000
  });
  const result = verifyShippingQuoteToken({
    token,
    cartSessionId: "sess_123",
    shippingDetails,
    packageSummary,
    selectedOptionId: option.optionId,
    now: 1_001_000
  });

  assert.deepEqual(result.selectedOption, option);
});

test("signed quote rejects tampering and cart changes", () => {
  const token = createShippingQuoteToken({
    cartSessionId: "sess_123",
    shippingDetails,
    packageSummary,
    options: [option],
    now: 1_000_000
  });

  assert.throws(
    () =>
      verifyShippingQuoteToken({
        token: `${token.slice(0, -1)}x`,
        cartSessionId: "sess_123",
        shippingDetails,
        packageSummary,
        selectedOptionId: option.optionId,
        now: 1_001_000
      }),
    (error) => error.statusCode === 422
  );

  assert.throws(
    () =>
      verifyShippingQuoteToken({
        token,
        cartSessionId: "sess_123",
        shippingDetails,
        packageSummary: { ...packageSummary, totalUnits: 2 },
        selectedOptionId: option.optionId,
        now: 1_001_000
      }),
    (error) => error.statusCode === 422
  );
});
