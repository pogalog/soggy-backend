"use strict";

const { getProductById } = require("../models/productModel");

function extractProductId(req) {
  if (req.params && typeof req.params.id === "string" && req.params.id.trim()) {
    return req.params.id.trim();
  }

  if (req.query && typeof req.query.id === "string" && req.query.id.trim()) {
    return req.query.id.trim();
  }

  const path = req.path || req.url || "";
const match = path.match(/^\/api\/products\/([^/]+)$/);
  if (!match || !match[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

function createGetProductHandler({ getPool }) {
  return async function getProduct(req, res) {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const productId = extractProductId(req);
    if (!productId) {
      return res
        .status(400)
        .json({ error: "Missing product id. Use /products/:id or ?id=<productId>" });
    }

    try {
      const pool = getPool();
      const product = await getProductById(pool, productId);

      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      return res.status(200).json(product);
    } catch (error) {
      console.error("Failed to fetch product", {
        productId,
        message: error.message
      });
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = {
  createGetProductHandler
};
