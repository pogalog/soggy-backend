"use strict";

const { createGetCommissionHandler } = require("./src/handlers/getCommissionHandler");
const { createGetProductHandler } = require("./src/handlers/getProductHandler");
const { createProductCatalogHandler } = require("./src/handlers/productCatalogHandler");
const { createCartHandler } = require("./src/handlers/cartHandler");
const { createOrderHandler } = require("./src/handlers/orderHandler");
const { createCommissionFormHandler } = require("./src/handlers/commissionFormHandler");
const { createCommissionResponseHandler } = require("./src/handlers/commissionResponseHandler");
const {
  createCommissionLifecycleHandler
} = require("./src/handlers/commissionLifecycleHandler");
const { createCheckoutHandler } = require("./src/handlers/checkoutHandler");
const { createWorkEstimateHandler } = require("./src/handlers/workEstimateHandler");
const { createWorkReservationHandler } = require("./src/handlers/workReservationHandler");
const { createShippingQuoteHandler } = require("./src/handlers/shippingQuoteHandler");
const { createStripeWebhookHandler } = require("./src/handlers/stripeWebhookHandler");
const {
  createDigitalDownloadHandler
} = require("./src/handlers/digitalDownloadHandler");
const { createMarketHandler } = require("./src/handlers/marketHandler");
const { createSiteContentHandler } = require("./src/handlers/siteContentHandler");
const { createApiHandler } = require("./src/handlers/apiHandler");
const { getPool } = require("./src/db/pool");
const { createCommissionImageHandler } = require("./src/handlers/commissionImageHandler");

const commissionDetailsHandler = createGetCommissionHandler({ getPool });
const productHandler = createGetProductHandler({ getPool });
const productCatalogHandler = createProductCatalogHandler({ getPool });
const cartHandler = createCartHandler({ getPool });
const orderHandler = createOrderHandler({ getPool });
const commissionFormHandler = createCommissionFormHandler({ getPool });
const commissionResponseHandler = createCommissionResponseHandler({ getPool });
const commissionLifecycleHandler = createCommissionLifecycleHandler({ getPool });
const checkoutHandler = createCheckoutHandler({ getPool });
const workEstimateHandler = createWorkEstimateHandler({ getPool });
const workReservationHandler = createWorkReservationHandler({ getPool });
const shippingQuoteHandler = createShippingQuoteHandler({ getPool });
const stripeWebhookHandler = createStripeWebhookHandler({ getPool });
const digitalDownloadHandler = createDigitalDownloadHandler({ getPool });
const marketHandler = createMarketHandler({ getPool });
const siteContentHandler = createSiteContentHandler({ getPool });
const api = createApiHandler({
  commissionImageHandler: createCommissionImageHandler({ getPool }),
  productHandler,
  productCatalogHandler,
  commissionDetailsHandler,
  cartHandler,
  orderHandler,
  commissionResponseHandler,
  commissionLifecycleHandler,
  commissionFormHandler,
  checkoutHandler,
  workEstimateHandler,
  workReservationHandler,
  shippingQuoteHandler,
  digitalDownloadHandler,
  stripeWebhookHandler,
  marketHandler,
  siteContentHandler
});

module.exports = {
  // Backward-compatible aliases: old targets now route both products and carts.
  getProduct: api,
  cartService: api,
  api
};
