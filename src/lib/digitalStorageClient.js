"use strict";

const { Storage } = require("@google-cloud/storage");
const { env } = require("../config/env");

let storageClient;

function getStorageClient() {
  if (!storageClient) {
    storageClient = env.gcpProjectId
      ? new Storage({ projectId: env.gcpProjectId })
      : new Storage();
  }
  return storageClient;
}

async function downloadObject({ bucketName, objectPath }) {
  const [buffer] = await getStorageClient().bucket(bucketName).file(objectPath).download();
  return buffer;
}

async function uploadObject({ bucketName, objectPath, buffer, contentType }) {
  await getStorageClient().bucket(bucketName).file(objectPath).save(buffer, {
    resumable: false,
    contentType,
    metadata: {
      cacheControl: "private, no-store, max-age=0",
      contentDisposition: "attachment"
    }
  });
}

async function getSignedDownloadUrl({
  bucketName,
  objectPath,
  expiresInSeconds,
  downloadFilename
}) {
  const expires = Date.now() + Math.max(30, Number(expiresInSeconds) || 120) * 1000;
  const [url] = await getStorageClient()
    .bucket(bucketName)
    .file(objectPath)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires,
      responseDisposition: `attachment; filename="${String(downloadFilename || "download.pdf").replace(/["\r\n]/g, "")}"`
    });
  return url;
}

module.exports = {
  downloadObject,
  getSignedDownloadUrl,
  uploadObject
};
