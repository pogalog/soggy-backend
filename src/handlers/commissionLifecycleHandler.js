"use strict";

const { env } = require("../config/env");
const { sendMail } = require("../lib/mailer");
const { fetchJsonFromGcs } = require("../lib/gcsJsonClient");
const {
  buildCommissionCommitEmail,
  buildCommissionFinalizeEmail
} = require("../lib/commissionEmailTemplates");
const { getCommissionForFollowUp } = require("../models/commissionModel");

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizePath(req) {
  const raw = req.path || req.url || "/";
  return String(raw).split("?")[0] || "/";
}

function resolveAction(req) {
  const path = normalizePath(req);

  if (
    path === "/commissions/commit" ||
    path === "/commissions/commit/" ||
    path === "/api/commissions/commit" ||
    path === "/api/commissions/commit/"
  ) {
    return "commit";
  }

  if (
    path === "/commission/finalize" ||
    path === "/commission/finalize/" ||
    path === "/commissions/finalize" ||
    path === "/commissions/finalize/" ||
    path === "/api/commission/finalize" ||
    path === "/api/commission/finalize/" ||
    path === "/api/commissions/finalize" ||
    path === "/api/commissions/finalize/"
  ) {
    return "finalize";
  }

  return null;
}

function ensureJsonContentType(req) {
  const contentType = (req.headers && req.headers["content-type"]) || "";
  if (!contentType) {
    return;
  }

  const isJson =
    (typeof req.is === "function" && req.is("application/json")) ||
    String(contentType).toLowerCase().includes("application/json");

  if (!isJson) {
    throw withStatusError("Content-Type must be application/json", 415);
  }
}

function parseJsonBody(req) {
  if (req.body === undefined || req.body === null || req.body === "") {
    return {};
  }

  if (Buffer.isBuffer(req.body)) {
    const bodyText = req.body.toString("utf8").trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }

  if (typeof req.body === "string") {
    const bodyText = req.body.trim();
    return bodyText ? JSON.parse(bodyText) : {};
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  throw new Error("Unsupported request body format");
}

function readRequiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw withStatusError(`${label} is required`, 400);
  }

  return normalized;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeRequest(body) {
  if (!body || typeof body !== "object") {
    throw withStatusError("Request body must be a JSON object", 400);
  }

  return {
    commissionId: readRequiredString(body.commissionId, "commissionId")
  };
}

function extractCustomerEmail(meta) {
  const candidates = [
    meta && meta.customerEmail,
    meta && meta.customer && meta.customer.email,
    meta && meta.form && meta.form.customerEmail,
    meta && meta.request && meta.request.customerEmail,
    meta && meta.request && meta.request.customer && meta.request.customer.email,
    meta && meta.request && meta.request.form && meta.request.form.customerEmail,
    meta && meta.payload && meta.payload.customerEmail,
    meta && meta.payload && meta.payload.customer && meta.payload.customer.email,
    meta && meta.payload && meta.payload.form && meta.payload.form.customerEmail
  ];

  const email = candidates.find(
    (candidate) => typeof candidate === "string" && candidate.trim()
  );

  if (!email || !isValidEmail(email.trim())) {
    throw withStatusError(
      "Unable to determine customer email from commission meta.json",
      422
    );
  }

  return email.trim();
}

function validateCommissionForAction(commission, action) {
  if (!commission.metaPath) {
    throw withStatusError("Commission is missing meta_path", 422);
  }

  if (!Number.isInteger(commission.totalCostCents)) {
    throw withStatusError("Commission is missing a valid total_cost value", 422);
  }

  if (
    action === "commit" &&
    commission.requiresCommit &&
    !Number.isInteger(commission.commitmentDepositCents)
  ) {
    throw withStatusError(
      "Commission is missing a valid commitment_deposit_amount value",
      422
    );
  }

  if (action === "commit" && !Number.isInteger(commission.timeCostDays)) {
    throw withStatusError("Commission is missing a valid time_cost value", 422);
  }
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function buildEmailMessage(action, commission) {
  if (action === "commit") {
    return buildCommissionCommitEmail({ commission });
  }

  return buildCommissionFinalizeEmail({ commission });
}

function buildSuccessMessage(action) {
  if (action === "commit") {
    return "Commission commitment email queued.";
  }

  return "Commission finalization email queued.";
}

function buildFailureMessage(action) {
  if (action === "commit") {
    return "Unable to send commission commitment email";
  }

  return "Unable to send commission finalization email";
}

function createCommissionLifecycleHandler({ getPool }) {
  return async function commissionLifecycleHandler(req, res) {
    const action = resolveAction(req);
    let commissionId = null;

    try {
      if (req.method !== "POST") {
        return methodNotAllowed(res);
      }

      if (!action) {
        return res.status(404).json({ error: "Route not found" });
      }

      ensureJsonContentType(req);
      const body = parseJsonBody(req);
      const request = normalizeRequest(body);
      commissionId = request.commissionId;

      const pool = getPool();
      const commission = await getCommissionForFollowUp(pool, commissionId);
      if (!commission) {
        throw withStatusError("Commission not found", 404);
      }

      validateCommissionForAction(commission, action);

      const meta = await fetchJsonFromGcs({
        bucketName: commission.storageBucket || env.commissionGcsBucket,
        objectPath: commission.metaPath
      });
      const customerEmail = extractCustomerEmail(meta);
      const emailMessage = buildEmailMessage(action, commission);

      await sendMail({
        from: env.commissionFromEmail,
        to: customerEmail,
        replyTo: env.commissionFromEmail,
        subject: emailMessage.subject,
        html: emailMessage.html
      });

      return res.status(200).json({
        ok: true,
        commissionId,
        customerEmail,
        message: buildSuccessMessage(action)
      });
    } catch (error) {
      if (error instanceof SyntaxError || error.type === "entity.parse.failed") {
        return res.status(400).json({ error: "Invalid JSON body" });
      }

      const isMailerDependencyError = error && error.code === "MODULE_NOT_FOUND";
      const statusCode =
        typeof error.statusCode === "number"
          ? error.statusCode
          : isMailerDependencyError
            ? 500
            : 502;

      const logPayload = {
        method: req.method,
        path: req.path || req.url,
        commissionId,
        message: error.message,
        code: error.code
      };

      if (statusCode >= 500) {
        console.error("Failed to process commission lifecycle email", logPayload);
      } else {
        console.warn("Rejected commission lifecycle email request", logPayload);
      }

      return res.status(statusCode).json({
        error: statusCode >= 500 ? buildFailureMessage(action) : error.message
      });
    }
  };
}

module.exports = {
  createCommissionLifecycleHandler
};
