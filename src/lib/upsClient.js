"use strict";

const { Buffer } = require("node:buffer");
const { randomUUID } = require("node:crypto");
const { env } = require("../config/env");
const { requestCarrierJson } = require("./carrierHttp");

let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;
let accessTokenPromise = null;

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

async function getUpsAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  if (!accessTokenPromise) {
    accessTokenPromise = (async () => {
      const response = await requestCarrierJson({
        carrier: "UPS",
        phase: "oauth",
        url: `${requireString(env.upsBaseUrl, "UPS_BASE_URL").replace(/\/+$/, "")}/security/v1/oauth/token`,
        init: {
          method: "POST",
          headers: {
            Authorization: buildBasicAuthHeader(),
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: "grant_type=client_credentials"
        },
        timeoutMs: env.upsTimeoutMs
      });

      const payload = response.payload;
      if (!response.ok || !payload || typeof payload !== "object") {
        const error = withStatusError(
          `UPS token request failed with status ${response.status}`,
          502
        );
        error.carrier = "UPS";
        error.phase = "oauth";
        error.upstreamStatus = response.status;
        throw error;
      }

      if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
        throw withStatusError("UPS token response did not include an access token", 502);
      }

      const expiresInSeconds = Number(payload.expires_in);
      cachedAccessToken = payload.access_token.trim();
      cachedAccessTokenExpiresAt =
        Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000;

      return cachedAccessToken;
    })();
  }

  const pendingToken = accessTokenPromise;
  try {
    return await pendingToken;
  } finally {
    if (accessTokenPromise === pendingToken) {
      accessTokenPromise = null;
    }
  }
}

async function requestUpsShopRates(rateRequest) {
  for (let authAttempt = 1; authAttempt <= 2; authAttempt += 1) {
    const token = await getUpsAccessToken();
    const response = await requestCarrierJson({
      carrier: "UPS",
      phase: "rating",
      url: `${requireString(env.upsBaseUrl, "UPS_BASE_URL").replace(/\/+$/, "")}/api/rating/${requireString(
        env.upsRateVersion,
        "UPS_RATE_VERSION"
      )}/Shop?additionalinfo=timeintransit`,
      init: {
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
      timeoutMs: env.upsTimeoutMs
    });

    const payload = response.payload;
    if (response.ok) {
      return payload;
    }

    if ((response.status === 401 || response.status === 403) && authAttempt === 1) {
      if (cachedAccessToken === token) {
        cachedAccessToken = null;
        cachedAccessTokenExpiresAt = 0;
      }
      console.warn("UPS access token rejected; refreshing once", {
        carrier: "UPS",
        phase: "rating",
        upstreamStatus: response.status
      });
      continue;
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
    error.carrier = "UPS";
    error.phase = "rating";
    error.upstreamStatus = response.status;
    error.details = payload;
    throw error;
  }

  throw withStatusError("UPS authentication failed", 502);
}

module.exports = {
  requestUpsShopRates
};
