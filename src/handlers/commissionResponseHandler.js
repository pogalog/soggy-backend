"use strict";

const { env } = require("../config/env");
const { sendMail } = require("../lib/mailer");
const { fetchJsonFromGcs } = require("../lib/gcsJsonClient");
const {
  buildCommissionCustomerDecisionBusinessEmail,
  buildCommissionCustomerDecisionCustomerEmail
} = require("../lib/commissionEmailTemplates");
const {
  getCommissionForFollowUp,
  updateCommissionStatusIfCurrent
} = require("../models/commissionModel");

const ACTION_STATUS = {
  commit: "customer_committed",
  cancel: "customer_cancelled"
};

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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
    const text = req.body.toString("utf8").trim();
    return text ? JSON.parse(text) : {};
  }

  if (typeof req.body === "string") {
    const text = req.body.trim();
    return text ? JSON.parse(text) : {};
  }

  if (typeof req.body === "object") {
    return req.body;
  }

  throw new Error("Unsupported request body format");
}

function readRequiredString(value, fieldName) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw withStatusError(`${fieldName} is required`, 400);
  }

  return normalized;
}

function normalizeAction(value) {
  const action = readRequiredString(value, "action").toLowerCase();
  if (action !== "commit" && action !== "cancel") {
    throw withStatusError("action must be either 'commit' or 'cancel'", 400);
  }

  return action;
}

function normalizeRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw withStatusError("Request body must be a JSON object", 400);
  }

  return {
    commissionId: readRequiredString(body.commissionId, "commissionId"),
    action: normalizeAction(body.action)
  };
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

async function loadCustomerEmailForNotice(commission) {
  try {
    const meta = await fetchJsonFromGcs({
      bucketName: commission.storageBucket || env.commissionGcsBucket,
      objectPath: commission.metaPath
    });
    return extractCustomerEmail(meta);
  } catch (error) {
    console.warn("Unable to load customer email for commission business notice", {
      commissionId: commission.id,
      message: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function resolveCurrentState(commission, action) {
  const targetStatus = ACTION_STATUS[action];
  if (commission.status === targetStatus) {
    return { mode: "already_done", targetStatus };
  }

  if (commission.status === ACTION_STATUS.cancel && action === "commit") {
    throw withStatusError(
      "This commission has already been cancelled. Reply to the original email or submit a new commission request if you would like to reopen the conversation.",
      409
    );
  }

  if (commission.status === ACTION_STATUS.commit && action === "cancel") {
    throw withStatusError("This commission has already been confirmed.", 409);
  }

  return { mode: "update", targetStatus };
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function createCommissionResponseHandler({ getPool }) {
  return async function commissionResponseHandler(req, res) {
    let commissionId = null;
    let action = null;

    try {
      if (req.method !== "POST") {
        return methodNotAllowed(res);
      }

      ensureJsonContentType(req);
      const body = parseJsonBody(req);
      const request = normalizeRequest(body);
      commissionId = request.commissionId;
      action = request.action;

      const pool = getPool();
      const commission = await getCommissionForFollowUp(pool, commissionId);
      if (!commission) {
        throw withStatusError("Commission not found", 404);
      }

      const state = resolveCurrentState(commission, action);
      if (state.mode === "already_done") {
        return res.status(200).json({
          ok: true,
          alreadyProcessed: true,
          commissionId,
          action,
          status: state.targetStatus
        });
      }

      const updated = await updateCommissionStatusIfCurrent(pool, {
        commissionId,
        currentStatus: commission.status,
        nextStatus: state.targetStatus
      });

      if (!updated) {
        throw withStatusError(
          "Commission status changed before this request could be processed. Please refresh and try again.",
          409
        );
      }

      const customerEmail = await loadCustomerEmailForNotice(commission);
      const emailMessage = buildCommissionCustomerDecisionBusinessEmail({
        commission: {
          ...commission,
          status: updated.status
        },
        action,
        customerEmail: customerEmail || "Not available"
      });
      const customerEmailMessage = buildCommissionCustomerDecisionCustomerEmail({
        commission: {
          ...commission,
          status: updated.status
        },
        action
      });

      await sendMail({
        from: env.commissionFromEmail,
        to: env.commissionBusinessEmail,
        replyTo: customerEmail || env.commissionFromEmail,
        subject: emailMessage.subject,
        html: emailMessage.html
      });

      if (customerEmail) {
        await sendMail({
          from: env.commissionFromEmail,
          to: customerEmail,
          replyTo: env.commissionFromEmail,
          subject: customerEmailMessage.subject,
          html: customerEmailMessage.html
        });
      }

      return res.status(200).json({
        ok: true,
        commissionId,
        action,
        status: updated.status
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
        action,
        message: error.message,
        code: error.code
      };

      if (statusCode >= 500) {
        console.error("Failed to process commission customer response", logPayload);
      } else {
        console.warn("Rejected commission customer response", logPayload);
      }

      return res.status(statusCode).json({
        error:
          statusCode >= 500
            ? "Unable to process commission response right now"
            : error.message
      });
    }
  };
}

module.exports = {
  createCommissionResponseHandler
};
