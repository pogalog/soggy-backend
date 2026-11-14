"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const nodemailer = require("nodemailer");
const { listCustomerCommissionImages, customerImageResponse, buildCommissionImageAttachments } = require("../src/lib/commissionMedia");
const { createCommissionImageHandler } = require("../src/handlers/commissionImageHandler");
const { buildCommissionFinalizeEmail } = require("../src/lib/commissionEmailTemplates");
const { createApiHandler } = require("../src/handlers/apiHandler");
const id = "12345678-1234-4234-8234-123456789abc";
const row = { id, commission_id: "cm_test", display_path: `test/finished/${id}/display.jpg`, email_path: `test/finished/${id}/email.jpg`, original_path: `test/finished/${id}/original`, alt: "Finished dragon", width: 800, height: 600 };
const commission = { id: "cm_test", itemName: '<Dragon & "friend">', totalCostCents: 10000, commitmentPaidCents: 2500 };
function response() {
  return { headers: {}, set(key, value) { this.headers[key] = value; return this; }, status(code) { this.code = code; return this; }, type(value) { this.contentType = value; return this; }, json(value) { this.body = value; return this; }, send(value) { this.body = value; return this; } };
}

test("customer media lookup requires owning commission, published stage and a valid photo UUID", async () => {
  let calls = 0;
  const pool = { query: async (sql, values) => {
    calls++;
    assert.match(sql, /JOIN commissions/);
    assert.match(sql, /c.id = \$1 AND c.status = ANY/);
    assert.match(sql, /i.id = \$3/);
    assert.deepEqual(values, ["cm_test", ["ready_to_ship", "read_to_ship", "payment_received", "shipped", "closed"], id]);
    return { rows: [row] };
  } };
  assert.deepEqual(await listCustomerCommissionImages(pool, "cm_test", "../meta.json"), []);
  assert.equal(calls, 0);
  assert.deepEqual(await listCustomerCommissionImages(pool, "cm_test", id), [row]);
  assert.deepEqual(Object.keys(customerImageResponse(row)), ["id", "alt", "width", "height"]);
});

test("image handler streams only registered finished JPEGs, ignoring arbitrary bucket/path input", async () => {
  const handler = createCommissionImageHandler({ getPool: () => ({ query: async () => ({ rows: [row] }) }), download: async (target) => {
    assert.deepEqual(target, { bucketName: "soggy-commission-requests", objectPath: row.display_path });
    return Buffer.from("jpeg");
  } });
  const res = response();
  await handler({ method: "GET", query: { commissionId: "cm_test", imageId: id, objectPath: "test/meta.json", bucket: "private" } }, res);
  assert.equal(res.code, 200);
  assert.equal(res.contentType, "image/jpeg");
  assert.equal(res.headers["Cache-Control"], "private, no-store");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
});

test("unpublished, deleted and mismatched images never trigger a storage read", async () => {
  const handler = createCommissionImageHandler({ getPool: () => ({ query: async () => ({ rows: [] }) }), download: async () => assert.fail("No download allowed") });
  const res = response();
  await handler({ method: "GET", query: { commissionId: "cm_other", imageId: id } }, res);
  assert.equal(res.code, 404);
});

test("ready email embeds bounded image attachments with matching MIME content IDs and escaped text", async () => {
  const attachments = await buildCommissionImageAttachments({ query: async () => ({ rows: [row] }) }, "cm_test", async (target) => {
    assert.equal(target.objectPath, row.email_path);
    return Buffer.from("jpeg fixture");
  });
  const email = buildCommissionFinalizeEmail({ commission, images: attachments });
  assert.match(email.html, /Take a look at what we made for you!/);
  assert.ok(email.html.includes(`cid:${attachments[0].cid}`));
  assert.match(email.html, /&lt;Dragon &amp; &quot;friend&quot;&gt;/);
  assert.match(email.html, /\$75\.00/);
  assert.doesNotMatch(email.html, /undefined|soggy-commission-requests/);
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const sent = await transport.sendMail({ from: "test@example.invalid", to: "customer@example.invalid", ...email, attachments });
  const mime = sent.message.toString();
  assert.match(mime, /multipart\/related/);
  assert.ok(mime.replace(/\r\n[ \t]+/g, " ").toLowerCase().includes(`content-id: <${attachments[0].cid}>`));
  assert.match(mime, /Content-Disposition: inline/);
  assert.doesNotMatch(buildCommissionFinalizeEmail({ commission }).html, /Take a look at what we made for you!/);
  await assert.rejects(buildCommissionImageAttachments({ query: async () => ({ rows: [row] }) }, "cm_test", async () => Buffer.alloc(512 * 1024 + 1)), /size limit/);
});

test("customer image route reaches the image handler", async () => {
  let called = false;
  const handler = createApiHandler({ commissionImageHandler: async () => { called = true; } });
  await handler({ method: "GET", path: "/api/commissions/images", query: {} }, response());
  assert.equal(called, true);
});
