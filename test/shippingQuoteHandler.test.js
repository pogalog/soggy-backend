"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeRequestedCarriers
} = require("../src/handlers/shippingQuoteHandler");

test("shipping quotes default to both carriers", () => {
  assert.deepEqual(normalizeRequestedCarriers(undefined), ["UPS", "USPS"]);
});

test("shipping quotes accept one normalized carrier", () => {
  assert.deepEqual(normalizeRequestedCarriers(["usps", "USPS"]), ["USPS"]);
  assert.deepEqual(normalizeRequestedCarriers(["ups"]), ["UPS"]);
});

test("shipping quotes reject unsupported or empty carrier lists", () => {
  assert.throws(
    () => normalizeRequestedCarriers([]),
    (error) => error.statusCode === 400
  );
  assert.throws(
    () => normalizeRequestedCarriers(["FedEx"]),
    (error) => error.statusCode === 400
  );
});
