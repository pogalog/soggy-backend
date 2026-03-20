"use strict";

const { getCommissionById } = require("../models/commissionModel");

function withStatusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readRequiredCommissionId(req) {
  const raw =
    req.query && typeof req.query.commission_id === "string"
      ? req.query.commission_id
      : req.query && typeof req.query.commissionId === "string"
        ? req.query.commissionId
        : "";

  const commissionId = raw.trim();
  if (!commissionId) {
    throw withStatusError("commission_id query parameter is required", 400);
  }

  return commissionId;
}

function toIsoString(value) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function toDateOnlyString(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) {
      return match[1];
    }
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function mapCommissionResponse(commission) {
  return {
    id: commission.id,
    item_name: commission.item_name,
    item_description: commission.item_description,
    yarn_type: commission.yarn_type,
    yarn_color: commission.yarn_color,
    attachment_material_type: commission.attachment_material_type,
    status: commission.status,
    time_cost: commission.time_cost,
    ship_date: toDateOnlyString(commission.ship_date),
    total_cost: commission.total_cost,
    requires_commit: commission.requires_commit,
    commitment_deposit_amount: commission.commitment_deposit_amount,
    created_at: toIsoString(commission.created_at),
    updated_at: toIsoString(commission.updated_at)
  };
}

function createGetCommissionHandler({ getPool }) {
  return async function getCommissionHandler(req, res) {
    let commissionId = null;

    try {
      if (req.method !== "GET") {
        res.set("Allow", "GET");
        return res.status(405).json({ error: "Method not allowed" });
      }

      commissionId = readRequiredCommissionId(req);
      const pool = getPool();
      const commission = await getCommissionById(pool, commissionId);

      if (!commission) {
        return res.status(404).json({ error: "Commission not found" });
      }

      return res.status(200).json({
        commission: mapCommissionResponse(commission)
      });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

      console.error("Failed to fetch commission details", {
        method: req.method,
        path: req.path || req.url,
        commissionId,
        message: error.message,
        statusCode
      });

      return res.status(statusCode).json({
        error: statusCode === 500 ? "Internal server error" : error.message
      });
    }
  };
}

module.exports = {
  createGetCommissionHandler
};
