"use strict";

const { createGetCommissionHandler } = require("./src/handlers/getCommissionHandler");
const { createGetProductHandler } = require("./src/handlers/getProductHandler");
const { createCartHandler } = require("./src/handlers/cartHandler");
const { createCommissionFormHandler } = require("./src/handlers/commissionFormHandler");
const { createCommissionResponseHandler } = require("./src/handlers/commissionResponseHandler");
const {
  createCommissionLifecycleHandler
} = require("./src/handlers/commissionLifecycleHandler");
const { createCheckoutHandler } = require("./src/handlers/checkoutHandler");
const { createStripeWebhookHandler } = require("./src/handlers/stripeWebhookHandler");
const { createMarketHandler } = require("./src/handlers/marketHandler");
const { createApiHandler } = require("./src/handlers/apiHandler");
const { getPool } = require("./src/db/pool");

const commissionDetailsHandler = createGetCommissionHandler({ getPool });
const productHandler = createGetProductHandler({ getPool });
const cartHandler = createCartHandler({ getPool });
const commissionFormHandler = createCommissionFormHandler({ getPool });
const commissionResponseHandler = createCommissionResponseHandler({ getPool });
const commissionLifecycleHandler = createCommissionLifecycleHandler({ getPool });
const checkoutHandler = createCheckoutHandler({ getPool });
const stripeWebhookHandler = createStripeWebhookHandler({ getPool });
const marketHandler = createMarketHandler({ getPool });
const api = createApiHandler({
  productHandler,
  commissionDetailsHandler,
  cartHandler,
  commissionResponseHandler,
  commissionLifecycleHandler,
  commissionFormHandler,
  checkoutHandler,
  stripeWebhookHandler,
  marketHandler
});

module.exports = {
  // Backward-compatible aliases: old targets now route both products and carts.
  getProduct: api,
  cartService: api,
  api
};
