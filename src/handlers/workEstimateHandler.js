"use strict";

const { getCartBySessionId } = require("../models/cartModel");
const { getProductsForCheckoutByIds } = require("../models/productModel");
const { estimateWorkForCart } = require("../models/workQueueModel");
const {
  buildReservationItems,
  normalizeRequest
} = require("./workReservationHandler");

function parseJsonBody(req) {
  if (req.body === undefined || req.body === null || req.body === "") return {};
  if (Buffer.isBuffer(req.body)) {
    const bodyText = req.body.toString("utf8").trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }
  if (typeof req.body === "string") {
    const bodyText = req.body.trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }
  if (typeof req.body === "object") return req.body;
  throw new Error("Unsupported request body format");
}

function ensureJsonContentType(req) {
  const contentType = (req.headers && req.headers["content-type"]) || "";
  if (!contentType) return;

  const isJson =
    (typeof req.is === "function" && req.is("application/json")) ||
    String(contentType).toLowerCase().includes("application/json");

  if (!isJson) {
    const error = new Error("Content-Type must be application/json");
    error.statusCode = 415;
    throw error;
  }
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function createWorkEstimateHandler({ getPool }) {
  return async function workEstimateHandler(req, res) {
    let cartSessionId = null;

    try {
      if (req.method !== "POST") {
        return methodNotAllowed(res);
      }

      ensureJsonContentType(req);
      const request = normalizeRequest(parseJsonBody(req));
      cartSessionId = request.cartSessionId;

      const pool = getPool();
      const cart = await getCartBySessionId(pool, cartSessionId);
      if (!Array.isArray(cart.items) || cart.items.length === 0) {
        return res.status(200).json({
          estimate: null,
          shipByDate: null
        });
      }

      const productIds = cart.items.map((item) => item.productId);
      const productsById = await getProductsForCheckoutByIds(pool, productIds);
      const preparedItems = buildReservationItems({
        cartItems: cart.items,
        productsById
      });
      const estimate = await estimateWorkForCart(pool, {
        cartSessionId,
        items: preparedItems
      });

      return res.status(200).json({
        estimate,
        shipByDate: estimate ? estimate.shipByDate : null
      });
    } catch (error) {
      if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
      const logPayload = {
        method: req.method,
        path: req.path || req.url,
        cartSessionId,
        message: error.message,
        code: error.code
      };

      if (statusCode >= 500) {
        console.error("Failed to estimate work", logPayload);
      } else {
        console.warn("Rejected work estimate request", logPayload);
      }

      const responseBody = {
        error: statusCode === 500 ? "Internal server error" : error.message
      };
      if (statusCode < 500 && error.details !== undefined) {
        responseBody.details = error.details;
      }

      return res.status(statusCode).json(responseBody);
    }
  };
}

module.exports = {
  createWorkEstimateHandler
};
