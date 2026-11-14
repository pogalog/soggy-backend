"use strict";

const {
  createHash,
  createHmac,
  randomBytes,
  randomUUID
} = require("node:crypto");
const { env } = require("../config/env");
const {
  downloadObject,
  getSignedDownloadUrl,
  uploadObject
} = require("../lib/digitalStorageClient");
const { personalizePdf } = require("../lib/pdfPersonalization");

function hashToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createCopyId() {
  const value = randomBytes(6).toString("hex").toUpperCase();
  return `SS-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8, 12)}`;
}

function sanitizeFilename(filename) {
  const normalized = String(filename || "download.pdf")
    .replace(/\.pdf$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${normalized || "download"}-licensed.pdf`;
}

function buildAccessUrl(token) {
  const base = String(env.appBaseUrl || "https://www.soggystitches.com").replace(/\/+$/, "");
  return `${base}/downloads/access#grant=${token}`;
}

function mapAccessRow(row) {
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  const exhausted = Number(row.download_count) >= Number(row.download_limit);
  const available =
    row.entitlement_status === "available" &&
    !row.revoked_at &&
    !expired &&
    !exhausted;
  let unavailableReason = null;
  if (row.entitlement_status === "revoked" || row.revoked_at) {
    unavailableReason = "This download link has been revoked.";
  } else if (row.entitlement_status === "generating") {
    unavailableReason = "Your personalized file is still being prepared.";
  } else if (row.entitlement_status === "failed") {
    unavailableReason = "Your file could not be prepared. Please contact Soggy Stitches.";
  } else if (expired) {
    unavailableReason = "This download link has expired.";
  } else if (exhausted) {
    unavailableReason = "This download has reached its access limit.";
  }

  return {
    grantId: row.grant_id,
    entitlementId: row.entitlement_id,
    status: row.entitlement_status,
    productName: row.product_name,
    assetLabel: row.asset_label,
    originalFilename: row.original_filename,
    downloadFilename: sanitizeFilename(row.original_filename),
    copyId: row.copy_id,
    customerEmail: row.customer_email,
    storageBucket: row.personalized_bucket,
    objectPath: row.personalized_path,
    downloadCount: Number(row.download_count),
    downloadLimit: Number(row.download_limit),
    expiresAt: new Date(row.expires_at).toISOString(),
    available,
    unavailableReason
  };
}

async function getDigitalItemsForOrder(pool, orderId) {
  const result = await pool.query(
    `
      SELECT
        oi.line_id,
        oi.product_id,
        oi.name AS product_name,
        pda.id AS asset_id,
        pda.label AS asset_label,
        pda.storage_bucket,
        pda.object_path,
        pda.original_filename,
        pda.sha256,
        pda.personalization_config
      FROM order_items oi
      JOIN product_digital_assets pda
        ON pda.product_id = oi.product_id
       AND pda.status = 'active'
      WHERE oi.order_id = $1
        AND oi.product_kind = 'digital'
      ORDER BY oi.created_at, oi.line_id, pda.label, pda.version DESC
    `,
    [orderId]
  );
  return result.rows;
}

async function markEntitlementFailed(pool, entitlementId, error) {
  const message = error instanceof Error ? error.message : String(error);
  await pool.query(
    `
      UPDATE digital_entitlements
      SET status = 'failed', failure_reason = $2, updated_at = NOW()
      WHERE id = $1
    `,
    [entitlementId, message.slice(0, 2000)]
  );
  await pool.query(
    `
      INSERT INTO digital_access_events (
        entitlement_id, event_type, metadata, created_at
      )
      VALUES ($1, 'generation_failed', $2::jsonb, NOW())
    `,
    [entitlementId, JSON.stringify({ message: message.slice(0, 500) })]
  );
}

async function createAccessGrant(pool, entitlementId, expiresAt, { revokeExisting = false } = {}) {
  if (revokeExisting) {
    await pool.query(
      `
        UPDATE digital_access_grants
        SET revoked_at = COALESCE(revoked_at, NOW())
        WHERE entitlement_id = $1
      `,
      [entitlementId]
    );
  }

  const rawToken = randomBytes(32).toString("base64url");
  const grantId = `dgg_${randomUUID()}`;
  await pool.query(
    `
      INSERT INTO digital_access_grants (
        id, entitlement_id, token_hash, expires_at, created_at
      )
      VALUES ($1, $2, $3, $4, NOW())
    `,
    [grantId, entitlementId, hashToken(rawToken), expiresAt]
  );
  return rawToken;
}

async function recordDigitalDeliveryEmailResult(
  pool,
  entitlements,
  { sent, recipient, error = null }
) {
  const eventType = sent ? "delivery_email_sent" : "delivery_email_failed";
  const message = error instanceof Error ? error.message : error ? String(error) : null;
  for (const entitlement of entitlements) {
    await pool.query(
      `
        INSERT INTO digital_access_events (
          entitlement_id, event_type, metadata, created_at
        )
        VALUES ($1, $2, $3::jsonb, NOW())
      `,
      [
        entitlement.entitlementId,
        eventType,
        JSON.stringify({
          recipient,
          ...(message ? { message: message.slice(0, 500) } : {})
        })
      ]
    );
  }
}

async function fulfillDigitalOrder(
  pool,
  { orderId, customerEmail, customerName, purchasedAt = new Date() }
) {
  if (!customerEmail) {
    return {
      fulfilled: [],
      failed: [],
      skippedReason: "customer_email_missing"
    };
  }

  const digitalItems = await getDigitalItemsForOrder(pool, orderId);
  const fulfilled = [];
  const failed = [];

  for (const item of digitalItems) {
    let entitlementId = `dge_${randomUUID()}`;
    let copyId = createCopyId();
    let expiresAt = new Date(
      Date.now() + env.digitalAccessDays * 24 * 60 * 60 * 1000
    );
    const filename = sanitizeFilename(item.original_filename);
    const insertResult = await pool.query(
      `
        INSERT INTO digital_entitlements (
          id,
          order_id,
          order_line_id,
          asset_id,
          customer_email,
          customer_name,
          copy_id,
          status,
          download_limit,
          download_count,
          expires_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'generating', $8, 0, $9, NOW(), NOW())
        ON CONFLICT (order_id, order_line_id, asset_id) DO NOTHING
        RETURNING id
      `,
      [
        entitlementId,
        orderId,
        item.line_id,
        item.asset_id,
        customerEmail,
        customerName || null,
        copyId,
        env.digitalDownloadLimit,
        expiresAt
      ]
    );

    if (insertResult.rowCount === 0) {
      const existingResult = await pool.query(
        `
          SELECT
            de.*,
            EXISTS (
              SELECT 1
              FROM digital_access_events dae
              WHERE dae.entitlement_id = de.id
                AND dae.event_type = 'delivery_email_sent'
            ) AS delivery_email_sent
          FROM digital_entitlements de
          WHERE de.order_id = $1
            AND de.order_line_id = $2
            AND de.asset_id = $3
          LIMIT 1
        `,
        [orderId, item.line_id, item.asset_id]
      );
      if (existingResult.rowCount === 0) {
        continue;
      }

      const existing = existingResult.rows[0];
      if (existing.delivery_email_sent === true || existing.status === "revoked") {
        continue;
      }

      entitlementId = existing.id;
      copyId = existing.copy_id;
      expiresAt =
        new Date(existing.expires_at).getTime() > Date.now()
          ? new Date(existing.expires_at)
          : new Date(Date.now() + env.digitalAccessDays * 24 * 60 * 60 * 1000);

      if (
        existing.status === "available" &&
        existing.personalized_bucket &&
        existing.personalized_path
      ) {
        if (new Date(existing.expires_at).getTime() <= Date.now()) {
          await pool.query(
            `
              UPDATE digital_entitlements
              SET expires_at = $2, updated_at = NOW()
              WHERE id = $1
            `,
            [entitlementId, expiresAt]
          );
        }
        const rawToken = await createAccessGrant(pool, entitlementId, expiresAt, {
          revokeExisting: true
        });
        fulfilled.push({
          entitlementId,
          productName: item.product_name,
          assetLabel: item.asset_label,
          filename,
          copyId,
          accessUrl: buildAccessUrl(rawToken),
          expiresAt: expiresAt.toISOString(),
          downloadLimit: Number(existing.download_limit)
        });
        continue;
      }

      await pool.query(
        `
          UPDATE digital_entitlements
          SET
            status = 'generating',
            customer_email = $2,
            customer_name = COALESCE($3, customer_name),
            expires_at = $4,
            failure_reason = NULL,
            updated_at = NOW()
          WHERE id = $1
        `,
        [entitlementId, customerEmail, customerName || null, expiresAt]
      );
    }

    try {
      const masterBuffer = await downloadObject({
        bucketName: item.storage_bucket,
        objectPath: item.object_path
      });
      const personalizedBuffer = await personalizePdf(masterBuffer, {
        customerName,
        customerEmail,
        copyId,
        orderReference: orderId,
        purchasedAt,
        personalizationConfig: item.personalization_config || {}
      });
      const personalizedSha256 = createHash("sha256")
        .update(personalizedBuffer)
        .digest("hex");
      const personalizedPath = `digital-orders/${orderId}/${entitlementId}/${filename}`;

      await uploadObject({
        bucketName: env.digitalAssetsBucket,
        objectPath: personalizedPath,
        buffer: personalizedBuffer,
        contentType: "application/pdf"
      });

      await pool.query(
        `
          UPDATE digital_entitlements
          SET
            status = 'available',
            personalized_bucket = $2,
            personalized_path = $3,
            personalized_sha256 = $4,
            failure_reason = NULL,
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          entitlementId,
          env.digitalAssetsBucket,
          personalizedPath,
          personalizedSha256
        ]
      );

      const rawToken = await createAccessGrant(pool, entitlementId, expiresAt, {
        revokeExisting: true
      });

      fulfilled.push({
        entitlementId,
        productName: item.product_name,
        assetLabel: item.asset_label,
        filename,
        copyId,
        accessUrl: buildAccessUrl(rawToken),
        expiresAt: expiresAt.toISOString(),
        downloadLimit: env.digitalDownloadLimit
      });
    } catch (error) {
      await markEntitlementFailed(pool, entitlementId, error);
      failed.push({
        entitlementId,
        productName: item.product_name,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { fulfilled, failed, skippedReason: null };
}

async function findAccessByToken(pool, token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 200) {
    return null;
  }
  const result = await pool.query(
    `
      SELECT
        dag.id AS grant_id,
        dag.revoked_at,
        de.id AS entitlement_id,
        de.status AS entitlement_status,
        de.customer_email,
        de.copy_id,
        de.personalized_bucket,
        de.personalized_path,
        de.download_count,
        de.download_limit,
        LEAST(de.expires_at, dag.expires_at) AS expires_at,
        oi.name AS product_name,
        pda.label AS asset_label,
        pda.original_filename
      FROM digital_access_grants dag
      JOIN digital_entitlements de ON de.id = dag.entitlement_id
      JOIN order_items oi
        ON oi.order_id = de.order_id
       AND oi.line_id = de.order_line_id
      JOIN product_digital_assets pda ON pda.id = de.asset_id
      WHERE dag.token_hash = $1
      LIMIT 1
    `,
    [hashToken(token)]
  );
  return result.rowCount > 0 ? mapAccessRow(result.rows[0]) : null;
}

function hashClientIp(ipAddress) {
  if (!ipAddress || !env.digitalAccessHashSalt) {
    return null;
  }
  return createHmac("sha256", env.digitalAccessHashSalt)
    .update(String(ipAddress), "utf8")
    .digest("hex");
}

async function recordDeniedAccess(pool, access, reason, requestContext) {
  if (!access) return;
  await pool.query(
    `
      INSERT INTO digital_access_events (
        entitlement_id,
        grant_id,
        event_type,
        ip_hash,
        user_agent,
        metadata,
        created_at
      )
      VALUES ($1, $2, 'download_denied', $3, $4, $5::jsonb, NOW())
    `,
    [
      access.entitlementId,
      access.grantId,
      hashClientIp(requestContext.ipAddress),
      requestContext.userAgent || null,
      JSON.stringify({ reason })
    ]
  );
}

async function authorizeDigitalDownload(pool, token, requestContext = {}) {
  const initialAccess = await findAccessByToken(pool, token);
  if (!initialAccess) {
    return null;
  }
  if (!initialAccess.available) {
    await recordDeniedAccess(
      pool,
      initialAccess,
      initialAccess.unavailableReason,
      requestContext
    );
    return initialAccess;
  }

  const signedUrl = await getSignedDownloadUrl({
    bucketName: initialAccess.storageBucket,
    objectPath: initialAccess.objectPath,
    expiresInSeconds: env.digitalSignedUrlSeconds,
    downloadFilename: initialAccess.downloadFilename
  });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `
        SELECT
          de.id,
          de.status,
          de.download_count,
          de.download_limit,
          de.expires_at,
          dag.revoked_at,
          dag.expires_at AS grant_expires_at
        FROM digital_access_grants dag
        JOIN digital_entitlements de ON de.id = dag.entitlement_id
        WHERE dag.id = $1
        FOR UPDATE OF de, dag
      `,
      [initialAccess.grantId]
    );
    const row = result.rows[0];
    const stillAvailable =
      row &&
      row.status === "available" &&
      !row.revoked_at &&
      new Date(row.expires_at).getTime() > Date.now() &&
      new Date(row.grant_expires_at).getTime() > Date.now() &&
      Number(row.download_count) < Number(row.download_limit);
    if (!stillAvailable) {
      await client.query("ROLLBACK");
      const refreshed = await findAccessByToken(pool, token);
      if (refreshed) {
        await recordDeniedAccess(
          pool,
          refreshed,
          refreshed.unavailableReason || "Access is no longer available",
          requestContext
        );
      }
      return refreshed;
    }

    await client.query(
      `
        UPDATE digital_entitlements
        SET
          download_count = download_count + 1,
          first_download_at = COALESCE(first_download_at, NOW()),
          last_download_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [initialAccess.entitlementId]
    );
    await client.query(
      `
        INSERT INTO digital_access_events (
          entitlement_id,
          grant_id,
          event_type,
          ip_hash,
          user_agent,
          metadata,
          created_at
        )
        VALUES ($1, $2, 'download_authorized', $3, $4, $5::jsonb, NOW())
      `,
      [
        initialAccess.entitlementId,
        initialAccess.grantId,
        hashClientIp(requestContext.ipAddress),
        requestContext.userAgent || null,
        JSON.stringify({
          signedUrlSeconds: env.digitalSignedUrlSeconds
        })
      ]
    );
    await client.query("COMMIT");

    return {
      ...initialAccess,
      downloadCount: initialAccess.downloadCount + 1,
      signedUrl
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getOrderDigitalSummary(pool, orderId) {
  const result = await pool.query(
    `
      SELECT
        de.id,
        de.order_line_id,
        de.copy_id,
        de.status,
        de.download_count,
        de.download_limit,
        de.expires_at,
        de.first_download_at,
        de.last_download_at,
        oi.name AS product_name,
        pda.label AS asset_label,
        pda.original_filename
      FROM digital_entitlements de
      JOIN order_items oi
        ON oi.order_id = de.order_id
       AND oi.line_id = de.order_line_id
      JOIN product_digital_assets pda ON pda.id = de.asset_id
      WHERE de.order_id = $1
      ORDER BY oi.created_at, pda.label
    `,
    [orderId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    orderLineId: row.order_line_id,
    productName: row.product_name,
    assetLabel: row.asset_label,
    filename: row.original_filename,
    copyId: row.copy_id,
    status: row.status,
    downloadCount: Number(row.download_count),
    downloadLimit: Number(row.download_limit),
    expiresAt: new Date(row.expires_at).toISOString(),
    firstDownloadAt: row.first_download_at
      ? new Date(row.first_download_at).toISOString()
      : null,
    lastDownloadAt: row.last_download_at
      ? new Date(row.last_download_at).toISOString()
      : null
  }));
}

module.exports = {
  authorizeDigitalDownload,
  buildAccessUrl,
  createCopyId,
  findAccessByToken,
  fulfillDigitalOrder,
  getOrderDigitalSummary,
  hashToken,
  recordDigitalDeliveryEmailResult,
  sanitizeFilename
};
