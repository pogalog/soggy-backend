"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  consumesProductionCapacity,
  hasFixedSingleQuantity,
  isDigitalProduct,
  requiresShipping
} = require("../src/lib/productCapabilities");

test("digital products are single-copy, instant-delivery purchases", () => {
  const product = { kind: "digital" };

  assert.equal(isDigitalProduct(product), true);
  assert.equal(consumesProductionCapacity(product), false);
  assert.equal(requiresShipping(product), false);
  assert.equal(hasFixedSingleQuantity(product), true);
});

test("physical products retain production and shipping behavior", () => {
  const product = { productKind: "repeatable" };

  assert.equal(isDigitalProduct(product), false);
  assert.equal(consumesProductionCapacity(product), true);
  assert.equal(requiresShipping(product), true);
  assert.equal(hasFixedSingleQuantity(product), false);
});
