"use strict";

const { randomUUID } = require("node:crypto");

const {
  createCart,
  getCartBySessionId,
  updateCart,
  deleteCart
} = require("../models/cartModel");

function parseJsonBody(req) {
  if (req.body === undefined || req.body === null || req.body === "") {
    return {};
  }

  if (Buffer.isBuffer(req.body)) {
    const bodyText = req.body.toString("utf8").trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }

  if (typeof req.body === "string") {
    const bodyText = req.body.trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  throw new Error("Unsupported request body format");
}

function extractSessionId(req, body) {
  if (req.params && typeof req.params.sessionId === "string" && req.params.sessionId.trim()) {
    return req.params.sessionId.trim();
  }

  if (req.query && typeof req.query.sessionId === "string" && req.query.sessionId.trim()) {
    return req.query.sessionId.trim();
  }

  if (body && typeof body.sessionId === "string" && body.sessionId.trim()) {
    return body.sessionId.trim();
  }

  const path = req.path || req.url || "";
  const match = path.match(/^\/(?:api\/)?cart\/([^/]+)\/?$/);
  if (!match || !match[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

function requireSessionId(req, body) {
  const sessionId = extractSessionId(req, body);
  if (!sessionId) {
    throw withStatusError(
      "Missing sessionId. Use /cart/:sessionId or ?sessionId=<sessionId>",
      400
    );
  }

  return sessionId;
}

function generateSessionId() {
  return `sess_${randomUUID()}`;
}

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function logWarning(message, details) {
  console.warn(message, details);
}

function ensureJsonContentType(req) {
  if (req.method !== "POST" && req.method !== "PUT") {
    return;
  }

  const contentType = (req.headers && req.headers["content-type"]) || "";
  if (!contentType) {
    return;
  }

  const isJson =
    (typeof req.is === "function" && req.is("application/json")) ||
    String(contentType).toLowerCase().includes("application/json");

  if (!isJson) {
    throw withStatusError("Content-Type must be application/json", 415);
  }
}

function normalizeCartItems(items, { allowEmpty }) {
  if (!Array.isArray(items)) {
    throw withStatusError("Request body must include items[]", 400);
  }

  if (!allowEmpty && items.length === 0) {
    throw withStatusError("New carts must include at least one item", 400);
  }

  const seen = new Set();

  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw withStatusError(`items[${index}] must be an object`, 400);
    }

    const productIdSource =
      typeof item.productId === "string" ? item.productId : item.product_id;
    const productId =
      typeof productIdSource === "string" ? productIdSource.trim() : "";

    if (!productId) {
      throw withStatusError(`items[${index}].productId is required`, 400);
    }

    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw withStatusError(`items[${index}].quantity must be a positive integer`, 400);
    }

    if (seen.has(productId)) {
      throw withStatusError(`Duplicate productId in items: ${productId}`, 400);
    }
    seen.add(productId);

    return {
      productId,
      quantity
    };
  });
}

function methodNotAllowed(res) {
  res.set("Allow", "GET, POST, PUT, DELETE");
  return res.status(405).json({ error: "Method not allowed" });
}

function createCartHandler({ getPool }) {
  return async function cartService(req, res) {
    let body = {};
    let sessionId = null;

    try {
      ensureJsonContentType(req);

      if (req.method === "POST" || req.method === "PUT") {
        body = parseJsonBody(req);
      }

      if (req.method === "GET") {
        sessionId = requireSessionId(req, body);
        const pool = getPool();
        const cart = await getCartBySessionId(pool, sessionId);
        return res.status(200).json(cart);
      }

      if (req.method === "POST") {
        sessionId = extractSessionId(req, body) || generateSessionId();
        const items = normalizeCartItems(body.items, { allowEmpty: false });
        const pool = getPool();
        const cart = await createCart(pool, { sessionId, items });
        return res.status(201).json(cart);
      }

      if (req.method === "PUT") {
        sessionId = requireSessionId(req, body);
        const items = normalizeCartItems(body.items, { allowEmpty: true });
        const pool = getPool();
        const cart = await updateCart(pool, { sessionId, items });
        return res.status(200).json(cart);
      }

      if (req.method === "DELETE") {
        sessionId = requireSessionId(req, body);
        const pool = getPool();
        const result = await deleteCart(pool, sessionId);
        return res.status(200).json(result);
      }

      return methodNotAllowed(res);
    } catch (error) {
      if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
        logWarning("Rejected cart request with invalid JSON", {
          method: req.method,
          path: req.path || req.url
        });
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const statusCode =
        typeof error.statusCode === "number"
          ? error.statusCode
          : error.code === "23505"
            ? 409
            : 500;

      const logDetails = {
        method: req.method,
        path: req.path || req.url,
        sessionId,
        message: error.message,
        code: error.code
      };

      if (statusCode >= 500) {
        console.error("Failed to handle cart request", logDetails);
      } else {
        logWarning("Rejected cart request", logDetails);
      }

      const publicMessage = statusCode === 500 ? "Internal server error" : error.message;
      return res.status(statusCode).json({ error: publicMessage });
    }
  };
}

module.exports = {
  createCartHandler
};
