"use strict";

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function readInt(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

const env = {
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASS,
  dbName: process.env.DB_NAME,
  dbHost: process.env.DB_HOST,
  dbPort: readInt(process.env.DB_PORT, 5432),
  dbSsl: process.env.DB_SSL === "true",
  instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME,
  dbSocketPath: process.env.DB_SOCKET_PATH || "/cloudsql",
  dbPoolMax: readInt(process.env.DB_POOL_MAX, 5),
  dbIdleTimeoutMs: readInt(process.env.DB_IDLE_TIMEOUT_MS, 30000),
  dbConnectionTimeoutMs: readInt(process.env.DB_CONNECTION_TIMEOUT_MS, 10000),
  priceCurrency: process.env.PRICE_CURRENCY || "USD"
};

module.exports = {
  env
};
