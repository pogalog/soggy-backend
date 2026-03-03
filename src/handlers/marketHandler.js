"use strict";

const { getMarkets } = require("../models/marketModel");

function createMarketHandler({ getPool }) {
  return async function marketHandler(req, res) {
    if (req.method !== "GET") {
      res.set("Allow", "GET");
      return res.status(405).json({ error: "Method not allowed" });
    }

    try {
      const pool = getPool();
      const markets = await getMarkets(pool);
      return res.status(200).json({ markets });
    } catch (error) {
      console.error("Failed to fetch markets", {
        method: req.method,
        path: req.path || req.url,
        message: error.message
      });
      return res.status(500).json({ error: "Internal server error" });
    }
  };
}

module.exports = {
  createMarketHandler
};
