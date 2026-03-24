"use strict";

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const IMAGE_NAME_PATTERN = /\.(avif|gif|jpe?g|png|webp)$/i;

let cachedAccessToken = null;
let accessTokenExpiresAt = 0;

function readRequiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new Error(`${label} is required`);
  }

  return normalized;
}

function normalizeObjectPrefix(value) {
  return readRequiredString(value, "objectPrefix").replace(/^\/+/, "");
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

function toPublicGcsUrl(bucketName, objectPath) {
  const bucket = readRequiredString(bucketName, "bucketName");
  const path = readRequiredString(objectPath, "objectPath");
  return `https://storage.googleapis.com/${encodeURIComponent(bucket)}/${encodeObjectPathForUrl(
    path
  )}`;
}

async function listObjectNamesFromGcsPrefix({ bucketName, objectPrefix, maxResults = 20 }) {
  const bucket = readRequiredString(bucketName, "bucketName");
  const prefix = normalizeObjectPrefix(objectPrefix);
  const accessToken = await getAccessToken();

  const url = new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`
  );
  url.searchParams.set("prefix", prefix.endsWith("/") ? prefix : `${prefix}/`);
  url.searchParams.set("fields", "items/name");
  url.searchParams.set("maxResults", String(Math.max(1, Math.floor(maxResults))));

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`GCS object listing failed with status ${response.status}`);
  }

  const payload = await response.json();
  const items = Array.isArray(payload && payload.items) ? payload.items : [];

  return items
    .map((item) =>
      item && typeof item === "object" && typeof item.name === "string" ? item.name : null
    )
    .filter((name) => typeof name === "string" && name.trim() && !name.endsWith("/"))
    .sort((a, b) => a.localeCompare(b));
}

async function findFirstImageUrlInGcsPrefix({ bucketName, objectPrefix }) {
  const objectNames = await listObjectNamesFromGcsPrefix({
    bucketName,
    objectPrefix,
    maxResults: 50
  });

  const imageObjectName =
    objectNames.find((objectName) => IMAGE_NAME_PATTERN.test(objectName)) || objectNames[0];

  if (!imageObjectName) {
    return null;
  }

  return toPublicGcsUrl(bucketName, imageObjectName);
}

module.exports = {
  findFirstImageUrlInGcsPrefix,
  toPublicGcsUrl
};
