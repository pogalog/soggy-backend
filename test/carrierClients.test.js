"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { env } = require("../src/config/env");
const { requestCarrierJson } = require("../src/lib/carrierHttp");
const { withProviderDeadline } = require("../src/lib/shippingQuote");

const originalFetch = global.fetch;

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function freshUspsClient() {
  const modulePath = require.resolve("../src/lib/uspsClient");
  delete require.cache[modulePath];
  return require(modulePath);
}

function freshUpsClient() {
  const modulePath = require.resolve("../src/lib/upsClient");
  delete require.cache[modulePath];
  return require(modulePath);
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("USPS shares one OAuth request across concurrent rate calls", async () => {
  env.uspsBaseUrl = "https://usps.test";
  env.uspsServiceStandardsBaseUrl = "https://usps.test";
  env.uspsConsumerKey = "consumer-key";
  env.uspsConsumerSecret = "consumer-secret";
  env.uspsTimeoutMs = 100;
  let tokenRequests = 0;

  global.fetch = async (url, init) => {
    if (String(url).includes("/oauth2/v3/token")) {
      tokenRequests += 1;
      await Promise.resolve();
      return jsonResponse({ access_token: "shared-token", expires_in: 3600 });
    }

    assert.equal(init.headers.Authorization, "Bearer shared-token");
    return jsonResponse({ ok: true });
  };

  const { requestUspsBaseRate, requestUspsServiceStandards } = freshUspsClient();
  await Promise.all([
    requestUspsBaseRate({ mailClass: "USPS_GROUND_ADVANTAGE" }),
    requestUspsServiceStandards({ mailClass: "USPS_GROUND_ADVANTAGE" }),
    requestUspsBaseRate({ mailClass: "PRIORITY_MAIL" }),
    requestUspsServiceStandards({ mailClass: "PRIORITY_MAIL" })
  ]);

  assert.equal(tokenRequests, 1);
});

test("USPS refreshes a cached token once after a 401", async () => {
  env.uspsBaseUrl = "https://usps.test";
  env.uspsServiceStandardsBaseUrl = "https://usps.test";
  env.uspsConsumerKey = "consumer-key";
  env.uspsConsumerSecret = "consumer-secret";
  env.uspsTimeoutMs = 100;
  let tokenRequests = 0;
  let apiRequests = 0;

  global.fetch = async (url, init) => {
    if (String(url).includes("/oauth2/v3/token")) {
      tokenRequests += 1;
      return jsonResponse({ access_token: `token-${tokenRequests}`, expires_in: 3600 });
    }

    apiRequests += 1;
    if (apiRequests === 1) {
      assert.equal(init.headers.Authorization, "Bearer token-1");
      return jsonResponse({ message: "expired" }, 401);
    }
    assert.equal(init.headers.Authorization, "Bearer token-2");
    return jsonResponse({ price: 12.34 });
  };

  const { requestUspsBaseRate } = freshUspsClient();
  const result = await requestUspsBaseRate({ mailClass: "PRIORITY_MAIL" });

  assert.deepEqual(result, { price: 12.34 });
  assert.equal(tokenRequests, 2);
  assert.equal(apiRequests, 2);
});

test("UPS refreshes a cached token once after a 401", async () => {
  env.upsBaseUrl = "https://ups.test";
  env.upsClientId = "client-id";
  env.upsClientSecret = "client-secret";
  env.upsRateVersion = "v1";
  env.upsTimeoutMs = 100;
  let tokenRequests = 0;
  let apiRequests = 0;

  global.fetch = async (url, init) => {
    if (String(url).includes("/oauth/token")) {
      tokenRequests += 1;
      return jsonResponse({ access_token: `ups-token-${tokenRequests}`, expires_in: 3600 });
    }

    apiRequests += 1;
    if (apiRequests === 1) {
      assert.equal(init.headers.Authorization, "Bearer ups-token-1");
      return jsonResponse({}, 401);
    }
    assert.equal(init.headers.Authorization, "Bearer ups-token-2");
    return jsonResponse({ RateResponse: { RatedShipment: [] } });
  };

  const { requestUpsShopRates } = freshUpsClient();
  await requestUpsShopRates({ RateRequest: {} });

  assert.equal(tokenRequests, 2);
  assert.equal(apiRequests, 2);
});

test("carrier timeout includes a response body that stalls after headers", async () => {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => new Promise(() => {})
  });

  const startedAt = Date.now();
  await assert.rejects(
    requestCarrierJson({
      carrier: "USPS",
      phase: "base-rate",
      url: "https://usps.test/rates",
      init: { method: "POST" },
      timeoutMs: 20,
      maxAttempts: 1
    }),
    (error) => error.statusCode === 504 && error.phase === "base-rate"
  );
  assert.ok(Date.now() - startedAt < 250);
});

test("a provider cannot consume the Cloud Function hard timeout", async () => {
  env.shippingProviderDeadlineMs = 20;

  await assert.rejects(
    withProviderDeadline("UPS", () => new Promise(() => {})),
    (error) =>
      error.statusCode === 504 &&
      error.carrier === "UPS" &&
      error.phase === "provider-deadline"
  );
});
