"use strict";

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

function extractUspsErrorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message.trim();
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error.trim();
  }

  if (
    payload.error &&
    typeof payload.error === "object" &&
    typeof payload.error.message === "string" &&
    payload.error.message.trim()
  ) {
    return payload.error.message.trim();
  }

  if (typeof payload.title === "string" && payload.title.trim()) {
    return payload.title.trim();
  }

  if (Array.isArray(payload.errors) && payload.errors[0]) {
    const firstError = payload.errors[0];
    if (typeof firstError === "string" && firstError.trim()) {
      return firstError.trim();
    }

    if (
      firstError &&
      typeof firstError === "object" &&
      typeof firstError.message === "string" &&
      firstError.message.trim()
    ) {
      return firstError.message.trim();
    }
  }

  return fallback;
}

async function getUspsAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  if (!accessTokenPromise) {
    accessTokenPromise = (async () => {
      const response = await requestCarrierJson({
        carrier: "USPS",
        phase: "oauth",
        url: `${requireString(env.uspsBaseUrl, "USPS_BASE_URL").replace(/\/+$/, "")}/oauth2/v3/token`,
        init: {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            grant_type: "client_credentials",
            client_id: requireString(env.uspsConsumerKey, "USPS_CONSUMER_KEY"),
            client_secret: requireString(env.uspsConsumerSecret, "USPS_CONSUMER_SECRET")
          })
        },
        timeoutMs: env.uspsTimeoutMs
      });

      const payload = response.payload;
      if (!response.ok || !payload || typeof payload !== "object") {
        const error = withStatusError(
          extractUspsErrorMessage(
            payload,
            `USPS token request failed with status ${response.status}`
          ),
          502
        );
        error.carrier = "USPS";
        error.phase = "oauth";
        error.upstreamStatus = response.status;
        throw error;
      }

      if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
        throw withStatusError("USPS token response did not include an access token", 502);
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

async function requestUspsApi({ phase, url, init }) {
  for (let authAttempt = 1; authAttempt <= 2; authAttempt += 1) {
    const token = await getUspsAccessToken();
    const response = await requestCarrierJson({
      carrier: "USPS",
      phase,
      url,
      init: {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${token}`
        }
      },
      timeoutMs: env.uspsTimeoutMs
    });

    if ((response.status === 401 || response.status === 403) && authAttempt === 1) {
      if (cachedAccessToken === token) {
        cachedAccessToken = null;
        cachedAccessTokenExpiresAt = 0;
      }
      console.warn("USPS access token rejected; refreshing once", {
        carrier: "USPS",
        phase,
        upstreamStatus: response.status
      });
      continue;
    }

    return response;
  }

  throw withStatusError("USPS authentication failed", 502);
}

async function requestUspsBaseRate(rateRequest) {
  const response = await requestUspsApi({
    phase: "base-rate",
    url: `${requireString(env.uspsBaseUrl, "USPS_BASE_URL").replace(/\/+$/, "")}/prices/v3/base-rates/search`,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(rateRequest)
    }
  });

  const payload = response.payload;
  if (response.ok) {
    return payload;
  }

  const error = withStatusError(
    extractUspsErrorMessage(
      payload,
      `USPS base rate request failed with status ${response.status}`
    ),
    response.status === 400 || response.status === 404 || response.status === 422
      ? 422
      : 502
  );
  error.details = payload;
  error.carrier = "USPS";
  error.phase = "base-rate";
  error.upstreamStatus = response.status;
  throw error;
}

async function requestUspsServiceStandards(query) {
  const params = new URLSearchParams();

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim()) {
      params.set(key, String(value).trim());
    }
  });

  const response = await requestUspsApi({
    phase: "service-standards",
    url: `${requireString(
      env.uspsServiceStandardsBaseUrl,
      "USPS_SERVICE_STANDARDS_BASE_URL"
    ).replace(/\/+$/, "")}/service-standards/v3/estimates?${params.toString()}`,
    init: {
      method: "GET",
      headers: {
        Accept: "application/json"
      }
    }
  });

  const payload = response.payload;
  if (response.ok) {
    return payload;
  }

  const error = withStatusError(
    extractUspsErrorMessage(
      payload,
      `USPS service standards request failed with status ${response.status}`
    ),
    response.status === 400 || response.status === 404 || response.status === 422
      ? 422
      : 502
  );
  error.details = payload;
  error.carrier = "USPS";
  error.phase = "service-standards";
  error.upstreamStatus = response.status;
  throw error;
}

module.exports = {
  requestUspsBaseRate,
  requestUspsServiceStandards
};
