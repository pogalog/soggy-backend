"use strict";

const {
  authorizeDigitalDownload,
  findAccessByToken
} = require("../models/digitalFulfillmentModel");

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseJsonBody(req) {
  if (req.body === undefined || req.body === null || req.body === "") return {};
  if (Buffer.isBuffer(req.body)) {
    const text = req.body.toString("utf8").trim();
    return text ? JSON.parse(text) : {};
  }
  if (typeof req.body === "string") {
    const text = req.body.trim();
    return text ? JSON.parse(text) : {};
  }
  if (typeof req.body === "object") return req.body;
  throw withStatusError("Unsupported request body", 400);
}

function getRequestContext(req) {
  const forwarded = req.headers && req.headers["x-forwarded-for"];
  const ipAddress =
    typeof forwarded === "string" && forwarded.trim()
      ? forwarded.split(",")[0].trim()
      : req.ip || null;
  const rawUserAgent = req.headers && req.headers["user-agent"];
  const userAgent =
    typeof rawUserAgent === "string" && rawUserAgent.trim()
      ? rawUserAgent.trim().slice(0, 500)
      : null;
  return { ipAddress, userAgent };
}

function toCustomerResponse(access) {
  return {
    status: access.status,
    productName: access.productName,
    assetLabel: access.assetLabel,
    filename: access.downloadFilename,
    copyId: access.copyId,
    downloadCount: access.downloadCount,
    downloadLimit: access.downloadLimit,
    expiresAt: access.expiresAt,
    available: access.available,
    unavailableReason: access.unavailableReason
  };
}

function createDigitalDownloadHandler({ getPool }) {
  return async function digitalDownloadHandler(req, res) {
    try {
      if (req.method !== "POST") {
        res.set("Allow", "POST");
        return res.status(405).json({ error: "Method not allowed" });
      }

      const body = parseJsonBody(req);
      const action = typeof body.action === "string" ? body.action.trim() : "";
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!token || (action !== "details" && action !== "authorize")) {
        throw withStatusError("A valid download request is required", 400);
      }

      const access =
        action === "authorize"
          ? await authorizeDigitalDownload(getPool(), token, getRequestContext(req))
          : await findAccessByToken(getPool(), token);

      if (!access) {
        return res.status(404).json({
          error: "This download link is invalid or no longer available"
        });
      }

      const response = toCustomerResponse(access);
      if (action === "authorize") {
        if (!access.available || !access.signedUrl) {
          return res.status(410).json({
            ...response,
            error: access.unavailableReason || "This download is not available"
          });
        }
        response.signedUrl = access.signedUrl;
      }

      res.set("Cache-Control", "no-store");
      res.set("Referrer-Policy", "no-referrer");
      return res.status(200).json(response);
    } catch (error) {
      const statusCode = typeof error.statusCode === "number" ? error.statusCode : 500;
      console.error("Digital download request failed", {
        method: req.method,
        message: error.message
      });
      return res
        .status(statusCode)
        .json({ error: statusCode >= 500 ? "Unable to prepare the download" : error.message });
    }
  };
}

module.exports = {
  createDigitalDownloadHandler
};
