"use strict";

const { Buffer } = require("node:buffer");
const { randomUUID } = require("node:crypto");
const { env } = require("../config/env");

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw withStatusError(`${label} is required`, 500);
  }

  return normalized;
}

function buildBasicAuthHeader() {
  const clientId = requireString(env.upsClientId, "UPS_CLIENT_ID");
  const clientSecret = requireString(env.upsClientSecret, "UPS_CLIENT_SECRET");
  const encoded = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

async function readResponsePayload(response) {
  const text = await response.text().catch(() => "");
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw withStatusError("UPS request timed out", 504);
    }

    const wrappedError = withStatusError("UPS request failed", 502);
    wrappedError.cause = error;
    throw wrappedError;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getUpsAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const response = await fetchWithTimeout(
    `${requireString(env.upsBaseUrl, "UPS_BASE_URL").replace(/\/+$/, "")}/security/v1/oauth/token`,
    {
      method: "POST",
      headers: {
        Authorization: buildBasicAuthHeader(),
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    },
    env.upsTimeoutMs
  );

  const payload = await readResponsePayload(response);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw withStatusError(
      `UPS token request failed with status ${response.status}`,
      502
    );
  }

  if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw withStatusError("UPS token response did not include an access token", 502);
  }

  const expiresInSeconds = Number(payload.expires_in);
  cachedAccessToken = payload.access_token.trim();
  cachedAccessTokenExpiresAt =
    Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000;

  return cachedAccessToken;
}

async function requestUpsShopRates(rateRequest) {
  const token = await getUpsAccessToken();
  const response = await fetchWithTimeout(
    `${requireString(env.upsBaseUrl, "UPS_BASE_URL").replace(/\/+$/, "")}/api/rating/${requireString(
      env.upsRateVersion,
      "UPS_RATE_VERSION"
    )}/Shop?additionalinfo=timeintransit`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        transId: randomUUID().replace(/-/g, "").slice(0, 32),
        transactionSrc: "soggy-stitches"
      },
      body: JSON.stringify(rateRequest)
    },
    env.upsTimeoutMs
  );

  const payload = await readResponsePayload(response);
  if (response.ok) {
    return payload;
  }

  const errorMessage =
    payload &&
    typeof payload === "object" &&
    payload.response &&
    typeof payload.response === "object" &&
    Array.isArray(payload.response.errors) &&
    payload.response.errors[0] &&
    typeof payload.response.errors[0].message === "string"
      ? payload.response.errors[0].message
      : `UPS rating request failed with status ${response.status}`;

  const error = withStatusError(
    errorMessage,
    response.status === 400 || response.status === 422 ? 422 : 502
  );
  error.details = payload;
  throw error;
}

module.exports = {
  requestUpsShopRates
};
