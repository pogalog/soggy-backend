"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");
const { env } = require("../config/env");

const TOKEN_VERSION = 1;

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireSigningSecret() {
  const secret =
    typeof env.shippingQuoteSigningSecret === "string"
      ? env.shippingQuoteSigningSecret.trim()
      : "";
  if (secret.length < 32) {
    throw withStatusError(
      "SHIPPING_QUOTE_SIGNING_SECRET must contain at least 32 characters",
      500
    );
  }
  return secret;
}

function sign(encodedPayload, secret) {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function normalizeQuoteOption(option) {
  return {
    optionId: option.optionId,
    carrier: option.carrier,
    serviceCode: option.serviceCode ?? null,
    mailClass: option.mailClass ?? null,
    serviceName: option.serviceName,
    amountCents: option.amountCents,
    currency: option.currency,
    amountDisplay: option.amountDisplay,
    businessDaysInTransit: option.businessDaysInTransit ?? null,
    estimatedDeliveryDate: option.estimatedDeliveryDate ?? null,
    estimatedDeliveryTime: option.estimatedDeliveryTime ?? null,
    negotiated: Boolean(option.negotiated),
    quotedAt: option.quotedAt
  };
}

function createShippingQuoteToken({
  cartSessionId,
  shippingDetails,
  packageSummary,
  options,
  now = Date.now()
}) {
  const issuedAt = Math.floor(now / 1000);
  const ttlSeconds = env.shippingQuoteTtlSeconds;
  const payload = {
    version: TOKEN_VERSION,
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
    cartSessionId,
    shippingDetails,
    packageSummary,
    options: options.map(normalizeQuoteOption)
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload, requireSigningSecret())}`;
}

function valuesMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function verifyShippingQuoteToken({
  token,
  cartSessionId,
  shippingDetails,
  packageSummary,
  selectedOptionId,
  now = Date.now()
}) {
  const [encodedPayload, encodedSignature, ...extraParts] = String(token || "").split(".");
  if (!encodedPayload || !encodedSignature || extraParts.length > 0) {
    throw withStatusError("Shipping quote is invalid. Refresh shipping options and try again.", 422);
  }

  const expectedSignature = sign(encodedPayload, requireSigningSecret());
  const receivedBuffer = Buffer.from(encodedSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw withStatusError("Shipping quote is invalid. Refresh shipping options and try again.", 422);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw withStatusError("Shipping quote is invalid. Refresh shipping options and try again.", 422);
  }

  const nowSeconds = Math.floor(now / 1000);
  if (
    !payload ||
    payload.version !== TOKEN_VERSION ||
    !Number.isFinite(payload.expiresAt) ||
    nowSeconds > payload.expiresAt
  ) {
    throw withStatusError("Shipping quote expired. Refresh shipping options and try again.", 422);
  }

  if (
    payload.cartSessionId !== cartSessionId ||
    !valuesMatch(payload.shippingDetails, shippingDetails) ||
    !valuesMatch(payload.packageSummary, packageSummary)
  ) {
    throw withStatusError(
      "The cart or shipping address changed. Refresh shipping options and try again.",
      422
    );
  }

  const options = Array.isArray(payload.options) ? payload.options : [];
  const selectedOption = options.find((option) => option.optionId === selectedOptionId);
  if (!selectedOption) {
    throw withStatusError(
      "Selected shipping option is no longer available. Refresh shipping options and try again.",
      422
    );
  }

  return {
    shippingRequired: true,
    packageSummary,
    options,
    defaultOptionId: null,
    quote: selectedOption,
    selectedOption
  };
}

module.exports = {
  createShippingQuoteToken,
  verifyShippingQuoteToken
};
