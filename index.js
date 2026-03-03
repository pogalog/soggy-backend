"use strict";

const { createGetProductHandler } = require("./src/handlers/getProductHandler");
const { createCartHandler } = require("./src/handlers/cartHandler");
const { createCommissionFormHandler } = require("./src/handlers/commissionFormHandler");
const { createCheckoutHandler } = require("./src/handlers/checkoutHandler");
const { createStripeWebhookHandler } = require("./src/handlers/stripeWebhookHandler");
const { createApiHandler } = require("./src/handlers/apiHandler");
const { getPool } = require("./src/db/pool");

const productHandler = createGetProductHandler({ getPool });
const cartHandler = createCartHandler({ getPool });
const commissionFormHandler = createCommissionFormHandler({ getPool });
const checkoutHandler = createCheckoutHandler({ getPool });
const stripeWebhookHandler = createStripeWebhookHandler({ getPool });
const api = createApiHandler({
  productHandler,
  cartHandler,
  commissionFormHandler,
  checkoutHandler,
  stripeWebhookHandler
});

module.exports = {
  // Backward-compatible aliases: old targets now route both products and carts.
  getProduct: api,
  cartService: api,
  api
};
