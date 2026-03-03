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

  return false;
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

function isCheckoutSessionRequest(req) {
  const path = normalizePath(req);
  return (
    path === "/checkout/session" ||
    path === "/checkout/session/" ||
    path === "/api/checkout/session" ||
    path === "/api/checkout/session/"
  );
}

function isStripeWebhookRequest(req) {
  const path = normalizePath(req);
  return (
    path === "/stripe/webhook" ||
    path === "/stripe/webhook/" ||
    path === "/api/stripe/webhook" ||
    path === "/api/stripe/webhook/"
  );
}

function isCommissionFormRequest(req) {
  const path = normalizePath(req);
  return (
    path === "/commissions" ||
    path === "/commissions/" ||
    path === "/api/commissions" ||
    path === "/api/commissions/" ||
    path === "/commission/form" ||
    path === "/commission/form/" ||
    path === "/api/commission/form" ||
    path === "/api/commission/form/"
  );
}

function createApiHandler({
  productHandler,
  cartHandler,
  checkoutHandler,
  stripeWebhookHandler,
  commissionFormHandler
}) {
  return async function api(req, res) {
    try {
      if (stripeWebhookHandler && isStripeWebhookRequest(req)) {
        return stripeWebhookHandler(req, res);
      }

      if (commissionFormHandler && isCommissionFormRequest(req)) {
        return commissionFormHandler(req, res);
      }

      if (checkoutHandler && isCheckoutSessionRequest(req)) {
        return checkoutHandler(req, res);
      }

      if (isCartRequest(req)) {
        return cartHandler(req, res);
      }

      if (isProductRequest(req)) {
        return productHandler(req, res);
      }

      return res.status(404).json({
        error:
          "Route not found. Use /products/:id, /cart/:sessionId, /commissions, /api/checkout/session, or /api/stripe/webhook"
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
