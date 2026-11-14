"use strict";

const { downloadObject } = require("./digitalStorageClient");
const BUCKET = "soggy-commission-requests";
const VISIBLE_STATUSES = ["ready_to_ship", "read_to_ship", "payment_received", "shipped", "closed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function listCustomerCommissionImages(pool, commissionId, imageId = null) {
  if (imageId !== null && !UUID.test(imageId)) return [];
  const { rows } = await pool.query(`SELECT i.* FROM commission_product_images i
    JOIN commissions c ON c.id = i.commission_id
    WHERE c.id = $1 AND c.status = ANY($2::text[])
    ${imageId === null ? "" : "AND i.id = $3"}
    ORDER BY i.created_at, i.id`, imageId === null ? [commissionId, VISIBLE_STATUSES] : [commissionId, VISIBLE_STATUSES, imageId]);
  return rows;
}

function customerImageResponse(row) {
  return { id: row.id, alt: row.alt, width: row.width, height: row.height };
}

async function buildCommissionImageAttachments(pool, commissionId, download = downloadObject) {
  const images = await listCustomerCommissionImages(pool, commissionId);
  // At most twelve 512-KiB images are accepted on upload; bound legacy/corrupt data too.
  return Promise.all(images.slice(0, 12).map(async (image) => {
    const content = await download({ bucketName: BUCKET, objectPath: image.email_path });
    if (content.length > 512 * 1024) throw new Error("Commission email image exceeds size limit");
    return { filename: `finished-${image.id}.jpg`, cid: `commission-${image.id}@soggystitches.com`,
      contentType: "image/jpeg", contentDisposition: "inline", content };
  }));
}

module.exports = { BUCKET, listCustomerCommissionImages, customerImageResponse, buildCommissionImageAttachments };
