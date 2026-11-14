"use strict";

const { BUCKET, listCustomerCommissionImages } = require("../lib/commissionMedia");
const { downloadObject } = require("../lib/digitalStorageClient");

function createCommissionImageHandler({ getPool, download = downloadObject }) {
  return async function commissionImageHandler(req, res) {
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    if (req.method !== "GET") {
      res.set("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const { commissionId, imageId } = req.query || {};
    if (typeof commissionId !== "string" || typeof imageId !== "string") return res.status(400).json({ error: "commissionId and imageId are required" });
    try {
      const [image] = await listCustomerCommissionImages(getPool(), commissionId, imageId);
      if (!image) return res.status(404).json({ error: "Image not found" });
      const buffer = await download({ bucketName: BUCKET, objectPath: image.display_path });
      return res.status(200).type("image/jpeg").send(buffer);
    } catch (error) {
      console.error("Commission image unavailable", { message: error.message });
      return res.status(Number(error.code) === 404 ? 404 : 500).json({ error: "Image unavailable" });
    }
  };
}

module.exports = { createCommissionImageHandler };
