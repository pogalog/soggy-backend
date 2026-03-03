"use strict";

const { env } = require("../config/env");
const {
  createOrGetCommission,
  updateCommissionStatus
} = require("../models/commissionModel");
const { sendMail } = require("../lib/mailer");
const {
  buildCustomerCommissionEmail,
  buildBusinessCommissionEmail,
  mapStorageImagesToLinks
} = require("../lib/commissionEmailTemplates");

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

function readOptionalString(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function readIsoDate(value, label) {
  const normalized = readRequiredString(value, label);
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) {
    throw withStatusError(`${label} must be a valid ISO-8601 timestamp`, 400);
  }

  return new Date(timestamp).toISOString();
}

function readOptionalIsoDate(value, label) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  return readIsoDate(value, label);
}

function normalizeStorageImages(storage) {
  if (!storage || storage.images === undefined) {
    return [];
  }

  if (!Array.isArray(storage.images)) {
    throw withStatusError("storage.images must be an array", 400);
  }

  return storage.images.map((image, index) => {
    if (!image || typeof image !== "object") {
      throw withStatusError(`storage.images[${index}] must be an object`, 400);
    }

    const fileName = readRequiredString(
      image.fileName,
      `storage.images[${index}].fileName`
    );
    const objectPath = readRequiredString(
      image.objectPath,
      `storage.images[${index}].objectPath`
    );
    const contentType = readRequiredString(
      image.contentType,
      `storage.images[${index}].contentType`
    );
    const size = Number(image.size);

    if (!Number.isInteger(size) || size < 0) {
      throw withStatusError(`storage.images[${index}].size must be a non-negative integer`, 400);
    }

    return {
      fileName,
      objectPath,
      contentType,
      size
    };
  });
}

function normalizeOptionalStorage(storage) {
  if (storage === undefined || storage === null) {
    return {
      uploadDirectory: null,
      images: [],
      metaPath: null,
      signedUrlExpiresAt: null,
      preparedAt: null
    };
  }

  if (!storage || typeof storage !== "object") {
    throw withStatusError("storage must be an object", 400);
  }

  return {
    uploadDirectory: readOptionalString(storage.uploadDirectory),
    images: normalizeStorageImages(storage),
    metaPath: readOptionalString(storage.metaPath),
    signedUrlExpiresAt: readOptionalIsoDate(
      storage.signedUrlExpiresAt,
      "storage.signedUrlExpiresAt"
    ),
    preparedAt: readOptionalIsoDate(storage.preparedAt, "storage.preparedAt")
  };
}

function normalizeLegacyFormPayload(body) {
  const form = body.form;
  if (!form || typeof form !== "object") {
    return null;
  }

  return {
    submissionKey: readRequiredString(body.submissionKey, "submissionKey"),
    customer: {
      name: readRequiredString(form.customerName, "form.customerName"),
      email: readRequiredString(form.customerEmail, "form.customerEmail"),
      phone: readOptionalString(form.contactPhone)
    },
    item: {
      name: readRequiredString(form.itemName, "form.itemName"),
      description: readRequiredString(form.itemDescription, "form.itemDescription")
    },
    materials: {
      yarnType: readRequiredString(form.yarnType, "form.yarnType"),
      yarnColor: readRequiredString(form.yarnColor, "form.yarnColor"),
      attachmentMaterialType: readRequiredString(
        form.attachmentMaterialType,
        "form.attachmentMaterialType"
      )
    },
    storage: normalizeOptionalStorage(body.storage)
  };
}

function normalizeCommissionRequest(body) {
  if (!body || typeof body !== "object") {
    throw withStatusError("Request body must be a JSON object", 400);
  }

  const legacyPayload = normalizeLegacyFormPayload(body);
  if (legacyPayload) {
    if (!isValidEmail(legacyPayload.customer.email)) {
      throw withStatusError("form.customerEmail must be a valid email address", 400);
    }

    return legacyPayload;
  }

  const customer = body.customer;
  const item = body.item;
  const materials = body.materials;
  const storage = normalizeOptionalStorage(body.storage);

  if (!customer || typeof customer !== "object") {
    throw withStatusError("customer is required", 400);
  }
  if (!item || typeof item !== "object") {
    throw withStatusError("item is required", 400);
  }
  if (!materials || typeof materials !== "object") {
    throw withStatusError("materials is required", 400);
  }

  const normalized = {
    submissionKey: readRequiredString(body.submissionKey, "submissionKey"),
    customer: {
      name: readRequiredString(customer.name, "customer.name"),
      email: readRequiredString(customer.email, "customer.email"),
      phone: readOptionalString(customer.phone)
    },
    item: {
      name: readRequiredString(item.name, "item.name"),
      description: readRequiredString(item.description, "item.description")
    },
    materials: {
      yarnType: readRequiredString(materials.yarnType, "materials.yarnType"),
      yarnColor: readRequiredString(materials.yarnColor, "materials.yarnColor"),
      attachmentMaterialType: readRequiredString(
        materials.attachmentMaterialType,
        "materials.attachmentMaterialType"
      )
    },
    storage
  };

  if (!isValidEmail(normalized.customer.email)) {
    throw withStatusError("customer.email must be a valid email address", 400);
  }

  return normalized;
}

function methodNotAllowed(res) {
  res.set("Allow", "POST");
  return res.status(405).json({ error: "Method not allowed" });
}

function createCommissionFormHandler({ getPool }) {
  return async function commissionFormHandler(req, res) {
    let commissionId = null;

    try {
      if (req.method !== "POST") {
        return methodNotAllowed(res);
      }

      ensureJsonContentType(req);
      const body = parseJsonBody(req);
      const request = normalizeCommissionRequest(body);

      const pool = getPool();
      const commission = await createOrGetCommission(pool, {
        // Persist only non-PII request details. Customer contact data is used only in outbound emails.
        submissionKey: request.submissionKey,
        itemName: request.item.name,
        itemDescription: request.item.description,
        yarnType: request.materials.yarnType,
        yarnColor: request.materials.yarnColor,
        attachmentMaterialType: request.materials.attachmentMaterialType,
        storageBucket: env.commissionGcsBucket,
        uploadDirectory: request.storage.uploadDirectory,
        storageImages: request.storage.images,
        metaPath: request.storage.metaPath,
        signedUrlExpiresAt: request.storage.signedUrlExpiresAt,
        preparedAt: request.storage.preparedAt,
        status: "email_pending"
      });
      commissionId = commission.id;

      if (commission.status !== "received") {
        const imageLinks = mapStorageImagesToLinks(request.storage);
        const customerEmailMessage = buildCustomerCommissionEmail({
          commissionId,
          request,
          imageLinks
        });
        const businessEmailMessage = buildBusinessCommissionEmail({
          commissionId,
          request,
          imageLinks
        });

        await Promise.all([
          sendMail({
            from: env.commissionFromEmail,
            to: request.customer.email,
            replyTo: env.commissionFromEmail,
            subject: customerEmailMessage.subject,
            html: customerEmailMessage.html
          }),
          sendMail({
            from: env.commissionFromEmail,
            to: env.commissionBusinessEmail,
            replyTo: request.customer.email,
            subject: businessEmailMessage.subject,
            html: businessEmailMessage.html
          })
        ]);

        await updateCommissionStatus(pool, {
          commissionId,
          status: "received"
        });
      }

      return res.status(commission.created ? 201 : 200).json({
        ok: true,
        commissionId,
        status: "received",
        customerEmail: request.customer.email,
        message: "Commission request received and confirmation email queued."
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
        console.error("Failed to process commission request", logPayload);
      } else {
        console.warn("Rejected commission request", logPayload);
      }

      return res.status(statusCode).json({
        error: statusCode >= 500 ? "Unable to submit commission request" : error.message
      });
    }
  };
}

module.exports = {
  createCommissionFormHandler
};
