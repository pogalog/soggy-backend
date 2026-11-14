"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { createPendingOrder, markOrderPaidAndDecrementInventory } = require("../src/models/orderModel");
const { COMMISSION_COMMERCE_SELECT, getCommissionPurchase } = require("../src/lib/commissionCommerce");
const { deliverCommissionEmail } = require("../src/lib/commissionEmailDelivery");
const { buildCommissionFinalizeEmail } = require("../src/lib/commissionEmailTemplates");

test("commission payments, order linkage, shipping sync and email retry against PostgreSQL", { skip: !process.env.COMMISSION_TEST_DATABASE_URL }, async (t) => {
  const { updateCommissionById } = require("../../soggy-admin-backend/src/models/commissionModel");
  const url = new URL(process.env.COMMISSION_TEST_DATABASE_URL);
  assert.equal(url.pathname, "/soggy_commission_test", "Use the dedicated disposable test database");
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  t.after(() => pool.end());
  const root = path.resolve(__dirname, "..");
  await pool.query(await fs.readFile(path.join(root, "commission-schema.sql"), "utf8"));
  await pool.query(await fs.readFile(path.join(root, "order-schema.sql"), "utf8"));
  await pool.query(await fs.readFile(path.join(root, "sql-util/commission-checkout-migration.sql"), "utf8"));
  // The full production scheduler isn't involved in already-finished pieces.
  await pool.query("CREATE TABLE IF NOT EXISTS work_reservations (order_id text, status text, reserved_at timestamptz)");
  const id = `cm_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`INSERT INTO commissions (id, submission_key, item_name, item_description, yarn_type, yarn_color, attachment_material_type, storage_bucket, status, requires_commit, commitment_deposit_amount, total_cost)
    VALUES ($1, $1, 'Test dragon', 'Handmade dragon', 'Cotton', 'Blue', 'None', 'test-only', 'quoted', true, 2500, 10000)`, [id]);
  const row = async () => (await pool.query(`${COMMISSION_COMMERCE_SELECT} WHERE c.id = $1`, [id])).rows[0];
  const purchaseItem = async () => {
    const purchase = getCommissionPurchase(await row());
    return { productId: id, productKind: purchase.kind, sku: id, name: purchase.title, unitAmount: purchase.amount, quantity: 1, workUnits: 0 };
  };
  const pending = async (items) => createPendingOrder(pool, { cartSessionId: "test-cart", channel: "online", currency: "USD", items, shippingMethod: "USPS Priority Mail", shippingAmount: 800, shippingDetails: { name: "Test Customer", address: { city: "Atlanta" } } });
  const pay = async (order) => markOrderPaidAndDecrementInventory(pool, { orderId: order.id, stripeCheckoutSessionId: `cs_${order.id}`, stripePaymentIntentId: `pi_${order.id}`, amountSubtotal: order.subtotalAmount, amountShipping: 800, amountTax: 0, amountTotal: order.totalAmount, customerEmail: "test@example.invalid" });

  const deposit = await pending([await purchaseItem()]);
  assert.equal((await row()).commitment_paid_amount, 0, "An unpaid checkout must not count as money received");
  await assert.rejects(pending([await purchaseItem()]), /active checkout/);
  const paidDeposit = await pay(deposit);
  assert.deepEqual(paidDeposit.committedCommissionIds, [id]);
  assert.equal((await row()).status, "committed");
  assert.equal((await row()).commitment_paid_amount, 2500);
  assert.equal((await pay(deposit)).alreadyPaid, true);

  await pool.query("UPDATE commissions SET status = 'ready_to_ship', commitment_deposit_amount = 4000, shipping_profile = $2 WHERE id = $1", [id, { weightLbs: 1, dimensionsIn: { length: 10, width: 8, height: 4 } }]);
  const finalItem = await purchaseItem();
  assert.equal(finalItem.unitAmount, 7500);
  await assert.rejects(pending([{ ...finalItem, unitAmount: 1 }]), /pricing or status changed/);
  const final = await pending([finalItem]);
  assert.equal((await row()).final_order_id, final.id);
  assert.equal((await row()).status, "ready_to_ship", "Starting checkout must not mark payment received");
  await assert.rejects(pending([finalItem]), /active checkout/);
  await assert.rejects(updateCommissionById(pool, { id, hasStatus: true, status: "shipped" }), /Orders/);
  const paidFinal = await pay(final);
  assert.deepEqual(paidFinal.committedCommissionIds, []);
  assert.equal((await row()).status, "payment_received");
  const order = (await pool.query("SELECT * FROM orders WHERE id = $1", [final.id])).rows[0];
  assert.equal(order.status, "ready_to_ship");
  assert.equal(order.shipping_details.name, "Test Customer");
  await assert.rejects(updateCommissionById(pool, { id, hasStatus: true, status: "ready_to_ship", expectedStatus: "ready_to_ship" }), /changed since/);
  await pool.query("UPDATE orders SET status = 'shipped', shipped_at = NOW(), fulfillment_carrier = 'USPS', tracking_number = 'TEST123' WHERE id = $1", [final.id]);
  assert.equal((await row()).status, "shipped");
  assert.ok((await row()).ship_date);
  assert.equal((await pay(final)).alreadyPaid, true);
  assert.equal((await row()).status, "shipped", "Duplicate payment events must not regress shipping");

  let attempts = 0;
  const email = { commissionId: id, action: "finalize", message: { to: "test@example.invalid", subject: "Ready", html: "Checkout" }, send: async () => { attempts++; if (attempts === 1) throw new Error("SMTP temporarily unavailable"); } };
  await assert.rejects(deliverCommissionEmail(pool, email), /SMTP/);
  assert.equal((await deliverCommissionEmail(pool, email)).alreadySent, false);
  assert.equal((await deliverCommissionEmail(pool, email)).alreadySent, true);
  assert.equal(attempts, 2);
  const template = buildCommissionFinalizeEmail({ commission: { id, itemName: "Test dragon", totalCostCents: 10000, commitmentPaidCents: 2500 } });
  assert.match(template.html, /\$75\.00/);
  assert.match(template.html, /Complete Final Checkout/);
  assert.ok(template.html.includes(`/commission/${id}`));
});
