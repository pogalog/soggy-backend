"use strict";

const { createGetProductHandler } = require("./src/handlers/getProductHandler");
const { createCartHandler } = require("./src/handlers/cartHandler");
const { createApiHandler } = require("./src/handlers/apiHandler");
const { getPool } = require("./src/db/pool");

const productHandler = createGetProductHandler({ getPool });
const cartHandler = createCartHandler({ getPool });
const api = createApiHandler({
  productHandler,
  cartHandler
});

module.exports = {
  // Backward-compatible aliases: old targets now route both products and carts.
  getProduct: api,
  cartService: api,
  api
};
