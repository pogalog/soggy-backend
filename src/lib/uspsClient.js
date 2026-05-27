"use strict";

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
      throw withStatusError("USPS request timed out", 504);
    }

    const wrappedError = withStatusError("USPS request failed", 502);
    wrappedError.cause = error;
    throw wrappedError;
  } finally {
    clearTimeout(timeoutId);
  }
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

  const response = await fetchWithTimeout(
    `${requireString(env.uspsBaseUrl, "USPS_BASE_URL").replace(/\/+$/, "")}/oauth2/v3/token`,
    {
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
    env.uspsTimeoutMs
  );

  const payload = await readResponsePayload(response);
  if (!response.ok || !payload || typeof payload !== "object") {
    throw withStatusError(
      extractUspsErrorMessage(
        payload,
        `USPS token request failed with status ${response.status}`
      ),
      502
    );
  }

  if (typeof payload.access_token !== "string" || !payload.access_token.trim()) {
    throw withStatusError("USPS token response did not include an access token", 502);
  }

  const expiresInSeconds = Number(payload.expires_in);
  cachedAccessToken = payload.access_token.trim();
  cachedAccessTokenExpiresAt =
    Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000;

  return cachedAccessToken;
}

async function requestUspsBaseRate(rateRequest) {
  const token = await getUspsAccessToken();
  const response = await fetchWithTimeout(
    `${requireString(env.uspsBaseUrl, "USPS_BASE_URL").replace(/\/+$/, "")}/prices/v3/base-rates/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(rateRequest)
    },
    env.uspsTimeoutMs
  );

  const payload = await readResponsePayload(response);
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
  throw error;
}

async function requestUspsServiceStandards(query) {
  const token = await getUspsAccessToken();
  const params = new URLSearchParams();

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim()) {
      params.set(key, String(value).trim());
    }
  });

  const response = await fetchWithTimeout(
    `${requireString(
      env.uspsServiceStandardsBaseUrl,
      "USPS_SERVICE_STANDARDS_BASE_URL"
    ).replace(/\/+$/, "")}/service-standards/v3/estimates?${params.toString()}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json"
      }
    },
    env.uspsTimeoutMs
  );

  const payload = await readResponsePayload(response);
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
  throw error;
}

module.exports = {
  requestUspsBaseRate,
  requestUspsServiceStandards
};
