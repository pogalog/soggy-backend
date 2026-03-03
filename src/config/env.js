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

function readPositiveInt(value, fallback) {
  const parsed = readInt(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function readBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  if (value === true || value === "true") {
    return true;
  }

  if (value === false || value === "false") {
    return false;
  }

  return fallback;
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
  priceCurrency: process.env.PRICE_CURRENCY || "USD",
  maxCartQty: readPositiveInt(process.env.MAX_CART_QTY, 5),
  appBaseUrl: process.env.APP_BASE_URL,
  stripeSecretKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  stripeTaxCode: process.env.STRIPE_TAX_CODE,
  commissionGcsBucket:
    process.env.COMMISSION_GCS_BUCKET || "soggy-commission-requests",
  commissionFromEmail:
    process.env.COMMISSION_FROM_EMAIL || "soggystitches@gmail.com",
  commissionBusinessEmail:
    process.env.COMMISSION_BUSINESS_EMAIL || "soggystitches@gmail.com",
  commissionCompanyName:
    process.env.COMMISSION_COMPANY_NAME || "Soggy Stitches",
  commissionEmailHeaderImageUrl:
    process.env.COMMISSION_EMAIL_HEADER_IMAGE_URL ||
    "https://storage.googleapis.com/soggy-public/emails/logo-fly.svg",
  smtpService: process.env.SMTP_SERVICE,
  smtpHost: process.env.SMTP_HOST,
  smtpPort: readInt(process.env.SMTP_PORT, 587),
  smtpSecure: readBoolean(process.env.SMTP_SECURE, false),
  smtpUser: process.env.SMTP_USER,
  smtpPass: process.env.SMTP_PASS
};

module.exports = {
  env
};
