"use strict";

function normalizePath(req) {
  const raw = req.path || req.url || "/";
  const pathOnly = String(raw).split("?")[0] || "/";
  return pathOnly;
}

function isCartRequest(req) {
  const path = normalizePath(req);
  if (path === "/cart" || path.startsWith("/cart/")) {
    return true;
  }
  if (path === "/api/cart" || path.startsWith("/api/cart/")) {
    return true;
  }

  if (req.query && typeof req.query.sessionId === "string" && req.query.sessionId.trim()) {
    return true;
  }

  // Only cart uses non-GET methods in this service.
  return req.method !== "GET";
}

function isProductRequest(req) {
  const path = normalizePath(req);
  if (path === "/products" || path.startsWith("/products/")) {
    return true;
  }
  if (path === "/api/products" || path.startsWith("/api/products/")) {
    return true;
  }

  return Boolean(req.query && typeof req.query.id === "string" && req.query.id.trim());
}

function createApiHandler({ productHandler, cartHandler }) {
  return async function api(req, res) {
    try {
      if (isCartRequest(req)) {
        return cartHandler(req, res);
      }

      if (isProductRequest(req)) {
        return productHandler(req, res);
      }

      return res.status(404).json({
        error: "Route not found. Use /products/:id or /cart/:sessionId"
      });
    } catch (error) {
      console.error("Unhandled API routing error", {
        method: req.method,
        path: req.path || req.url,
        message: error.message
      });
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = {
  createApiHandler
};
