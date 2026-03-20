"use strict";

const { randomBytes } = require("node:crypto");

function generateCommissionId() {
  return `cm_${randomBytes(13).toString("hex")}`;
}

function normalizeBoolean(value) {
  if (value === true || value === false) {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return false;
}

async function getCommissionBySubmissionKey(pool, submissionKey) {
  const result = await pool.query(
    `
      SELECT id, status, created_at, updated_at
      FROM commissions
      WHERE submission_key = $1
      LIMIT 1
    `,
    [submissionKey]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    id: result.rows[0].id,
    status: result.rows[0].status,
    createdAt: new Date(result.rows[0].created_at).toISOString(),
    updatedAt: new Date(result.rows[0].updated_at).toISOString()
  };
}

async function createOrGetCommission(
  pool,
  {
    submissionKey,
    itemName,
    itemDescription,
    yarnType,
    yarnColor,
    attachmentMaterialType,
    storageBucket,
    uploadDirectory,
    storageImages,
    metaPath,
    signedUrlExpiresAt,
    preparedAt,
    status
  }
) {
  const existing = await getCommissionBySubmissionKey(pool, submissionKey);
  if (existing) {
    return {
      ...existing,
      created: false
    };
  }

  const commissionId = generateCommissionId();

  try {
    const result = await pool.query(
      `
        INSERT INTO commissions (
          id,
          submission_key,
          item_name,
          item_description,
          yarn_type,
          yarn_color,
          attachment_material_type,
          storage_bucket,
          upload_directory,
          storage_images,
          meta_path,
          signed_url_expires_at,
          prepared_at,
          status,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, NOW(), NOW()
        )
        RETURNING id, status, created_at, updated_at
      `,
      [
        commissionId,
        submissionKey,
        itemName,
        itemDescription,
        yarnType,
        yarnColor,
        attachmentMaterialType,
        storageBucket,
        uploadDirectory || null,
        JSON.stringify(storageImages),
        metaPath || null,
        signedUrlExpiresAt || null,
        preparedAt || null,
        status
      ]
    );

    return {
      id: result.rows[0].id,
      status: result.rows[0].status,
      createdAt: new Date(result.rows[0].created_at).toISOString(),
      updatedAt: new Date(result.rows[0].updated_at).toISOString(),
      created: true
    };
  } catch (error) {
    if (error.code === "23505") {
      const conflicted = await getCommissionBySubmissionKey(pool, submissionKey);
      if (conflicted) {
        return {
          ...conflicted,
          created: false
        };
      }
    }

    throw error;
  }
}

async function updateCommissionStatus(pool, { commissionId, status }) {
  const result = await pool.query(
    `
      UPDATE commissions
      SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, created_at, updated_at
    `,
    [commissionId, status]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    id: result.rows[0].id,
    status: result.rows[0].status,
    createdAt: new Date(result.rows[0].created_at).toISOString(),
    updatedAt: new Date(result.rows[0].updated_at).toISOString()
  };
}

async function updateCommissionStatusIfCurrent(
  pool,
  { commissionId, currentStatus, nextStatus }
) {
  const result = await pool.query(
    `
      UPDATE commissions
      SET status = $3, updated_at = NOW()
      WHERE id = $1
        AND status = $2
      RETURNING id, status, created_at, updated_at
    `,
    [commissionId, currentStatus, nextStatus]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    id: result.rows[0].id,
    status: result.rows[0].status,
    createdAt: new Date(result.rows[0].created_at).toISOString(),
    updatedAt: new Date(result.rows[0].updated_at).toISOString()
  };
}

async function getCommissionForFollowUp(pool, commissionId) {
  const result = await pool.query(
    `
      SELECT
        id,
        item_name,
        item_description,
        yarn_type,
        yarn_color,
        attachment_material_type,
        status,
        requires_commit,
        commitment_deposit_amount,
        time_cost,
        ship_date,
        total_cost,
        storage_bucket,
        meta_path,
        created_at
      FROM commissions
      WHERE id = $1
      LIMIT 1
    `,
    [commissionId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    itemName: row.item_name,
    itemDescription: row.item_description,
    yarnType: row.yarn_type,
    yarnColor: row.yarn_color,
    attachmentMaterialType: row.attachment_material_type,
    status: row.status,
    requiresCommit: normalizeBoolean(row.requires_commit),
    commitmentDepositCents:
      row.commitment_deposit_amount === null || row.commitment_deposit_amount === undefined
        ? null
        : Number(row.commitment_deposit_amount),
    timeCostDays:
      row.time_cost === null || row.time_cost === undefined
        ? null
        : Number(row.time_cost),
    shipDate:
      row.ship_date === null || row.ship_date === undefined
        ? null
        : new Date(row.ship_date).toISOString().slice(0, 10),
    totalCostCents:
      row.total_cost === null || row.total_cost === undefined
        ? null
        : Number(row.total_cost),
    storageBucket: row.storage_bucket,
    metaPath: row.meta_path,
    createdAt: new Date(row.created_at).toISOString()
  };
}

async function getCommissionById(pool, commissionId) {
  const result = await pool.query(
    `
      SELECT
        id,
        item_name,
        item_description,
        yarn_type,
        yarn_color,
        attachment_material_type,
        status,
        time_cost,
        ship_date,
        total_cost,
        requires_commit,
        commitment_deposit_amount,
        created_at,
        updated_at
      FROM commissions
      WHERE id = $1
      LIMIT 1
    `,
    [commissionId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return result.rows[0];
}

module.exports = {
  createOrGetCommission,
  updateCommissionStatus,
  updateCommissionStatusIfCurrent,
  getCommissionForFollowUp,
  getCommissionById
};
