"use strict";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

let cachedAccessToken = null;
let accessTokenExpiresAt = 0;

function readRequiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${label} is required`);
  }

  return normalized;
}

function encodeObjectPathForUrl(objectPath) {
  return objectPath
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < accessTokenExpiresAt - 60_000) {
    return cachedAccessToken;
  }

  const response = await fetch(METADATA_TOKEN_URL, {
    headers: {
      "Metadata-Flavor": "Google"
    }
  });

  if (!response.ok) {
    throw new Error(`Metadata token request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!payload || typeof payload.access_token !== "string") {
    throw new Error("Metadata token response did not include an access token");
  }

  cachedAccessToken = payload.access_token;
  accessTokenExpiresAt = Date.now() + Number(payload.expires_in || 0) * 1000;
  return cachedAccessToken;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GCS request failed with status ${response.status}`);
  }

  return response.json();
}

async function fetchJsonFromGcs({ bucketName, objectPath }) {
  const bucket = readRequiredString(bucketName, "bucketName");
  const path = readRequiredString(objectPath, "objectPath");
  const jsonApiUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(
    bucket
  )}/o/${encodeURIComponent(path)}?alt=media`;

  try {
    const accessToken = await getAccessToken();
    return await fetchJson(jsonApiUrl, {
      Authorization: `Bearer ${accessToken}`
    });
  } catch (error) {
    const publicUrl = `https://storage.googleapis.com/${encodeURIComponent(
      bucket
    )}/${encodeObjectPathForUrl(path)}`;
    return fetchJson(publicUrl, {});
  }
}

module.exports = {
  fetchJsonFromGcs
};
