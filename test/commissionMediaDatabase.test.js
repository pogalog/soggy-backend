"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { listCustomerCommissionImages } = require("../src/lib/commissionMedia");

test("finished media is isolated from references, gated by status and revoked on deletion in PostgreSQL", { skip: !process.env.COMMISSION_TEST_DATABASE_URL }, async (t) => {
  const { createAdminCommissionMediaHandler } = require("../../soggy-admin-backend/src/handlers/adminCommissionMediaHandler");
  const url = new URL(process.env.COMMISSION_TEST_DATABASE_URL);
  assert.equal(url.pathname, "/soggy_commission_test", "Use the dedicated disposable test database");
  const pool = new Pool({ connectionString: url.toString() });
  const commissionId = `cm_${randomUUID()}`;
  t.after(async () => {
    try { await pool.query("DELETE FROM commissions WHERE id = $1", [commissionId]); }
    finally { await pool.end(); }
  });
  const migration = await fs.readFile(path.join(__dirname, "../sql-util/commission-media-migration.sql"), "utf8");
  await pool.query(migration);
  await pool.query(migration);
  await pool.query(`INSERT INTO commissions (id, submission_key, item_name, item_description, yarn_type, yarn_color, attachment_material_type, storage_bucket, upload_directory, status, storage_images)
    VALUES ($1,$1,'Test dragon','Test','Cotton','Blue','None','soggy-commission-requests','requests/media-test','in_progress','[{"objectPath":"requests/media-test/customer-reference.jpg"}]')`, [commissionId]);
  function response() { return { set() { return this; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
  const objects = new Map();
  const handler = createAdminCommissionMediaHandler({ getPool: () => pool,
    prepare: async () => ({ display: Buffer.from("display"), email: Buffer.from("email"), width: 800, height: 600 }),
    objectStorage: { async uploadBuffer({ objectPath, buffer }) { objects.set(objectPath, buffer); }, async deleteObject({ objectPath }) { objects.delete(objectPath); } }
  });
  const request = { method: "POST", query: { commissionId }, headers: { "content-type": "multipart/form-data; boundary=fixture" },
    rawBody: Buffer.from('--fixture\r\nContent-Disposition: form-data; name="image"; filename="test.png"\r\nContent-Type: image/png\r\n\r\nfixture\r\n--fixture--\r\n') };
  const res = response();
  await handler(request, res);
  assert.equal(res.code, 201);
  const imageId = res.body.image.id;
  assert.equal(objects.size, 3);
  assert.equal((await listCustomerCommissionImages(pool, commissionId)).length, 0);
  for (const status of ["quoted", "committed", "in_progress", "ready_to_ship", "payment_received", "shipped", "closed", "admin_cancelled"]) {
    await pool.query("UPDATE commissions SET status = $2 WHERE id = $1", [commissionId, status]);
    const visible = ["ready_to_ship", "payment_received", "shipped", "closed"].includes(status);
    assert.equal((await listCustomerCommissionImages(pool, commissionId, imageId)).length, visible ? 1 : 0, status);
  }
  await pool.query("UPDATE commissions SET status = 'ready_to_ship' WHERE id = $1", [commissionId]);
  assert.equal((await listCustomerCommissionImages(pool, "cm_wrong", imageId)).length, 0);
  const deleted = response();
  await handler({ method: "DELETE", query: { commissionId, imageId } }, deleted);
  assert.equal(deleted.code, 200);
  assert.equal(objects.size, 0);
  assert.equal((await listCustomerCommissionImages(pool, commissionId)).length, 0);
  const row = (await pool.query("SELECT storage_images FROM commissions WHERE id = $1", [commissionId])).rows[0];
  assert.equal(row.storage_images[0].objectPath, "requests/media-test/customer-reference.jpg");
});
