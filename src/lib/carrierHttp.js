"use strict";

const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function withStatusError(message, statusCode, metadata = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, metadata);
  return error;
}

function parseRetryAfterMs(value) {
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 2_000);
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return Math.min(Math.max(0, timestamp - Date.now()), 2_000);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePayload(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function requestOnce({ carrier, phase, url, init, timeoutMs }) {
  const controller = new AbortController();
  let timeoutId;
  let timedOut = false;

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        withStatusError(`${carrier} ${phase} request timed out`, 504, {
          carrier,
          phase,
          retryable: true
        })
      );
    }, timeoutMs);
  });

  const requestPromise = (async () => {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal
    });
    // Read the body before clearing the timer. A carrier can send response
    // headers and then stall indefinitely while streaming the payload.
    const responseText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      payload: parsePayload(responseText)
    };
  })();

  try {
    return await Promise.race([requestPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut || (error instanceof Error && error.name === "AbortError")) {
      throw withStatusError(`${carrier} ${phase} request timed out`, 504, {
        carrier,
        phase,
        retryable: true,
        cause: error
      });
    }

    if (error && typeof error.statusCode === "number") {
      throw error;
    }

    throw withStatusError(`${carrier} ${phase} request failed`, 502, {
      carrier,
      phase,
      retryable: true,
      cause: error
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function requestCarrierJson({
  carrier,
  phase,
  url,
  init,
  timeoutMs,
  maxAttempts = 2
}) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await requestOnce({ carrier, phase, url, init, timeoutMs });
      if (
        !result.ok &&
        TRANSIENT_STATUSES.has(result.status) &&
        attempt < maxAttempts
      ) {
        const delayMs =
          parseRetryAfterMs(result.retryAfter) ?? 100 * attempt + Math.floor(Math.random() * 100);
        console.warn("Retrying transient shipping carrier response", {
          carrier,
          phase,
          upstreamStatus: result.status,
          attempt,
          delayMs
        });
        await wait(delayMs);
        continue;
      }

      return result;
    } catch (error) {
      lastError = error;
      // A timeout has already consumed the full per-attempt budget. Let the
      // other carrier answer instead of risking the platform's hard deadline.
      if (!error.retryable || error.statusCode === 504 || attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = 100 * attempt + Math.floor(Math.random() * 100);
      console.warn("Retrying shipping carrier request", {
        carrier,
        phase,
        statusCode: error.statusCode,
        attempt,
        delayMs
      });
      await wait(delayMs);
    }
  }

  throw lastError;
}

module.exports = {
  requestCarrierJson
};
