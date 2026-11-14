"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  doesCartRequireShipping
} = require("../src/handlers/checkoutHandler");

test("digital-only online checkout does not require shipping", () => {
  assert.equal(
    doesCartRequireShipping({
      shippingMethod: "shipping",
      channel: "online",
      items: [{ kind: "digital" }]
    }),
    false
  );
});

test("online checkout with a physical item requires shipping", () => {
  assert.equal(
    doesCartRequireShipping({
      shippingMethod: "shipping",
      channel: "online",
      items: [{ kind: "digital" }, { kind: "repeatable" }]
    }),
    true
  );
});
