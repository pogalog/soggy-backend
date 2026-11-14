"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { getCommissionPurchase, normalizeCommissionStatus } = require("../src/lib/commissionCommerce");
const { requiresShipping, consumesProductionCapacity, hasFixedSingleQuantity } = require("../src/lib/productCapabilities");

test("final checkout deducts the deposit actually paid, not today's requested deposit", () => {
  const result = getCommissionPurchase({ status: "ready_to_ship", total_cost: 10000, commitment_paid_amount: 2500, commitment_deposit_amount: 4000, item_name: "Dragon" });
  assert.equal(result.amount, 7500);
  assert.equal(result.kind, "commission_final");
  assert.equal(requiresShipping(result), true);
  assert.equal(consumesProductionCapacity(result), false);
  assert.equal(hasFixedSingleQuantity(result), true);
});

test("final checkout works without a deposit and with a fully paid item subtotal", () => {
  assert.equal(getCommissionPurchase({ status: "ready_to_ship", total_cost: 10000, requires_commit: false }).amount, 10000);
  assert.equal(getCommissionPurchase({ status: "ready_to_ship", total_cost: 10000, commitment_paid_amount: 10000 }).amount, 0);
  assert.equal(getCommissionPurchase({ status: "ready_to_ship", total_cost: 10000, commitment_paid_amount: 11000 }), null);
  assert.equal(getCommissionPurchase({ status: "ready_to_ship", total_cost: null }), null);
});

test("only a quoted commission with an unpaid positive deposit can purchase a commitment", () => {
  const quote = { status: "quoted", requires_commit: true, commitment_deposit_amount: 2000 };
  assert.equal(getCommissionPurchase(quote).amount, 2000);
  assert.equal(requiresShipping(getCommissionPurchase(quote)), false);
  for (const status of ["received", "committed", "customer_committed", "in_progress", "payment_received", "shipped", "closed", "admin_cancelled"]) {
    assert.equal(getCommissionPurchase({ ...quote, status }), null);
  }
  assert.equal(getCommissionPurchase({ ...quote, commitment_paid_amount: 2000 }), null);
  assert.equal(getCommissionPurchase({ ...quote, commitment_deposit_amount: null }), null);
  assert.equal(normalizeCommissionStatus("customer_committed"), "committed");
});
