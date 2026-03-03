"use strict";

const { env } = require("../config/env");

const theme = {
  pageBg: "#f6f3ed",
  shellBorder: "#2a2a31",
  shellInner: "#0d0d12",
  panelBg: "#101116",
  panelBorder: "#2f3140",
  mutedPanel: "#15141c",
  textPrimary: "#ffffff",
  textMuted: "#d7d3e2",
  textSubtle: "#a6a1b6",
  purple: "#9b6dff",
  purpleDeep: "#5e37b8",
  purpleSoft: "#c7b1ff",
  gold: "#d7b24a",
  goldSoft: "#f2d98a",
  footerBg: "#0b0b10"
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function encodePathSegments(pathname) {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function toStorageUrl(bucketName, objectPath) {
  if (typeof objectPath !== "string" || !objectPath.trim()) {
    return null;
  }

  const bucket =
    typeof bucketName === "string" && bucketName.trim()
      ? bucketName.trim()
      : env.commissionGcsBucket;

  // Use the authenticated Cloud Storage URL shape so private bucket objects can be opened
  // by signed-in users who have Storage Object Viewer access.
  return `https://storage.cloud.google.com/${encodeURIComponent(bucket)}/${encodePathSegments(objectPath.trim())}`;
}

function buildHeaderHtml() {
  const companyName = escapeHtml(env.commissionCompanyName);
  const imageUrl =
    typeof env.commissionEmailHeaderImageUrl === "string"
      ? env.commissionEmailHeaderImageUrl.trim()
      : "";

  const imageMarkup = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="${companyName}" style="display:block;max-width:88px;width:88px;height:auto;border:0;" />`
    : "";

  return `
    <div style="padding:28px 28px 22px 28px;border-bottom:1px solid ${theme.shellBorder};background:${theme.shellInner};">
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="width:96px;vertical-align:middle;padding:0 16px 0 0;">
            ${imageMarkup}
          </td>
          <td style="vertical-align:middle;padding:0;">
            <div style="color:${theme.textPrimary};font-family:'Trebuchet MS','Avenir Next','Segoe UI',Arial,sans-serif;font-size:30px;font-weight:700;letter-spacing:0.2px;line-height:1.15;">
              ${companyName}
            </div>
            <div style="margin-top:8px;color:${theme.textSubtle};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:14px;letter-spacing:0.2px;">
              Handmade commissions, stitched with care.
            </div>
          </td>
        </tr>
      </table>
    </div>
  `;
}

function buildSectionLabel(label) {
  return `
    <div style="margin:0 0 18px 0;color:${theme.gold};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:3.5px;text-transform:uppercase;">
      ${escapeHtml(label)}
    </div>
  `;
}

function buildFooterHtml({ replyEmail, introText, labelText }) {
  const safeReplyEmail = escapeHtml(replyEmail);
  const safeIntroText = escapeHtml(introText);
  const safeLabelText = escapeHtml(labelText);

  return `
    <div style="padding:20px 28px 26px 28px;border-top:1px solid ${theme.shellBorder};background:
      radial-gradient(circle at bottom left, rgba(155,109,255,0.10), transparent 34%),
      linear-gradient(180deg, ${theme.footerBg} 0%, #09090d 100%);">
      <div style="padding:16px 18px;border:1px solid ${theme.panelBorder};border-radius:16px;background:rgba(255,255,255,0.015);">
        <div style="margin:0 0 10px 0;color:${theme.purpleSoft};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;">
          Reply & Contact
        </div>
        <div style="margin:0 0 8px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.6;">
          ${safeIntroText}
        </div>
        <div style="color:${theme.textPrimary};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:14px;font-weight:700;">
          ${safeLabelText}: ${safeReplyEmail}
        </div>
      </div>
      <div style="margin-top:14px;color:${theme.textSubtle};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.6;">
        ${escapeHtml(env.commissionCompanyName)} | Custom crochet commissions and handmade work
      </div>
    </div>
  `;
}

function buildDetailRow(label, value) {
  const displayValue =
    value === undefined || value === null || value === ""
      ? "Not provided"
      : String(value);

  return `
    <tr>
      <td style="padding:12px 14px;border-bottom:1px solid ${theme.panelBorder};font-weight:700;vertical-align:top;width:220px;color:${theme.goldSoft};background:rgba(155,109,255,0.05);">
        ${escapeHtml(label)}
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid ${theme.panelBorder};color:${theme.textPrimary};background:rgba(255,255,255,0.01);">
        ${escapeHtml(displayValue)}
      </td>
    </tr>
  `;
}

function buildColorSwatchDetailRow(label, colorValue) {
  const safeColor = escapeHtml(colorValue);

  return `
    <tr>
      <td style="padding:12px 14px;border-bottom:1px solid ${theme.panelBorder};font-weight:700;vertical-align:top;width:220px;color:${theme.goldSoft};background:rgba(155,109,255,0.05);">
        ${escapeHtml(label)}
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid ${theme.panelBorder};color:${theme.textPrimary};background:rgba(255,255,255,0.01);">
        <span style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:10px;border-radius:999px;border:1px solid rgba(255,255,255,0.24);background:${safeColor};"></span>
        <span style="vertical-align:middle;">${safeColor}</span>
      </td>
    </tr>
  `;
}

function buildTable(rows) {
  return `
    <table style="width:100%;border-collapse:collapse;background:${theme.panelBg};border:1px solid ${theme.panelBorder};border-radius:18px;overflow:hidden;">
      ${rows.join("")}
    </table>
  `;
}

function buildImageListHtml(images) {
  if (!Array.isArray(images) || images.length === 0) {
    return `
      <p style="margin:0;color:${theme.textSubtle};font-size:14px;">
        No reference images were included with this request.
      </p>
    `;
  }

  const items = images
    .map(
      (image, index) => `
        <li style="margin:0 0 10px 20px;color:${theme.textPrimary};">
          <a href="${escapeHtml(image.url)}" style="color:${theme.purple};text-decoration:none;font-weight:700;">
            ${escapeHtml(image.fileName || `Reference Image ${index + 1}`)}
          </a>
          <span style="color:${theme.textSubtle};"> (${escapeHtml(image.contentType || "unknown type")}, ${escapeHtml(String(image.size || 0))} bytes)</span>
        </li>
      `
    )
    .join("");

  return `
    <div style="padding:16px 18px;background:${theme.mutedPanel};border:1px solid ${theme.panelBorder};border-radius:16px;">
      <ul style="padding:0;margin:0;color:${theme.textPrimary};font-size:14px;">
      ${items}
      </ul>
    </div>
  `;
}

function buildEmailShell({ title, bodyHtml, footer }) {
  return `
    <div style="margin:0;padding:28px 16px;background:
      radial-gradient(circle at top left, rgba(155,109,255,0.06), transparent 24%),
      radial-gradient(circle at top right, rgba(215,178,74,0.06), transparent 20%),
      ${theme.pageBg};">
      <div style="max-width:720px;margin:0 auto;background:${theme.shellInner};border:1px solid ${theme.shellBorder};border-radius:28px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.45);">
        ${buildHeaderHtml()}
        <div style="padding:28px 28px 32px 28px;color:${theme.textPrimary};font-family:Arial,Helvetica,sans-serif;line-height:1.65;background:
          linear-gradient(180deg, rgba(255,255,255,0.015) 0%, rgba(255,255,255,0) 100%),
          ${theme.shellInner};">
          <h1 style="margin:0 0 18px 0;font-family:'Trebuchet MS','Avenir Next','Segoe UI',Arial,sans-serif;font-size:34px;font-weight:700;line-height:1.15;color:${theme.textPrimary};letter-spacing:0.1px;">${escapeHtml(title)}</h1>
          ${bodyHtml}
        </div>
        ${buildFooterHtml(footer)}
      </div>
    </div>
  `;
}

function buildCustomerCommissionEmail({ commissionId, request, imageLinks }) {
  const rows = [
    buildDetailRow("Submission Key", request.submissionKey),
    buildDetailRow("Name", request.customer.name),
    buildDetailRow("Email", request.customer.email),
    buildDetailRow("Phone", request.customer.phone || "Not provided"),
    buildDetailRow("Item", request.item.name),
    buildDetailRow("Description", request.item.description),
    buildDetailRow("Yarn Type", request.materials.yarnType),
    buildColorSwatchDetailRow("Yarn Color", request.materials.yarnColor),
    buildDetailRow(
      "Attachment Material",
      request.materials.attachmentMaterialType
    )
  ];

  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.75;">Thank you for your commission request. We have received your submission and will review the details carefully.</p>
    <p style="margin:0 0 16px 0;color:${theme.textPrimary};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.7;">
      Your request reference is <strong style="color:${theme.goldSoft};">${escapeHtml(commissionId)}</strong>.
    </p>
    ${buildSectionLabel("Request Summary")}
    ${buildTable(rows)}
    <div style="margin-top:22px;padding:20px;background:
      linear-gradient(135deg, rgba(155,109,255,0.12) 0%, rgba(215,178,74,0.08) 100%),
      ${theme.mutedPanel};border:1px solid ${theme.panelBorder};border-radius:18px;">
      ${buildSectionLabel("Next Steps")}
      <p style="margin:0 0 12px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">We will follow up by email once we have fully determined the timeframe and cost of the project. That message will include your quote for the work.</p>
      <p style="margin:0 0 12px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">Once those details are finalized, we will provide a link for you to review and agree to the terms and to make an initial payment covering material costs.</p>
      <p style="margin:0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">After the piece is finished, the remaining balance for the product, plus shipping, will be due before the order is completed and shipped.</p>
    </div>
    <p style="margin:22px 0 0 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.75;">We appreciate the opportunity to create something special for you.</p>
  `;

  return {
    subject: `We received your commission request (${commissionId})`,
    html: buildEmailShell({
      title: "Commission Request Received",
      bodyHtml,
      footer: {
        replyEmail: env.commissionFromEmail,
        introText:
          "You can reply directly to this email if you need to add details or ask questions about your request.",
        labelText: "Reply to"
      }
    })
  };
}

function buildBusinessCommissionEmail({ commissionId, request, imageLinks }) {
  const rows = [
    buildDetailRow("Commission ID", commissionId),
    buildDetailRow("Submission Key", request.submissionKey),
    buildDetailRow("Customer Name", request.customer.name),
    buildDetailRow("Customer Email", request.customer.email),
    buildDetailRow("Customer Phone", request.customer.phone || "Not provided"),
    buildDetailRow("Item", request.item.name),
    buildDetailRow("Description", request.item.description),
    buildDetailRow("Yarn Type", request.materials.yarnType),
    buildColorSwatchDetailRow("Yarn Color", request.materials.yarnColor),
    buildDetailRow(
      "Attachment Material",
      request.materials.attachmentMaterialType
    ),
    buildDetailRow("Upload Directory", request.storage.uploadDirectory),
    buildDetailRow("Meta Path", request.storage.metaPath),
    buildDetailRow(
      "Signed URL Expires",
      request.storage.signedUrlExpiresAt
    ),
    buildDetailRow("Prepared At", request.storage.preparedAt)
  ];

  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.75;">A new commission request has been submitted.</p>
    ${buildSectionLabel("Intake Details")}
    ${buildTable(rows)}
    <div style="margin-top:22px;">
      <h2 style="margin:0 0 10px 0;font-family:'Trebuchet MS','Avenir Next','Segoe UI',Arial,sans-serif;font-size:21px;font-weight:700;line-height:1.2;color:${theme.textPrimary};">Reference Images</h2>
      ${buildImageListHtml(imageLinks)}
    </div>
  `;

  return {
    subject: `New commission request (${commissionId})`,
    html: buildEmailShell({
      title: "New Commission Request",
      bodyHtml,
      footer: {
        replyEmail: request.customer.email,
        introText:
          "Reply directly to this email to respond to the customer. The message will go to their inbox via the Reply-To address.",
        labelText: "Customer Reply-To"
      }
    })
  };
}

function mapStorageImagesToLinks(storage) {
  const images = Array.isArray(storage && storage.images) ? storage.images : [];

  return images
    .map((image) => {
      if (!image || typeof image !== "object") {
        return null;
      }

      const url = toStorageUrl(env.commissionGcsBucket, image.objectPath);
      if (!url) {
        return null;
      }

      return {
        fileName:
          typeof image.fileName === "string" && image.fileName.trim()
            ? image.fileName.trim()
            : null,
        contentType:
          typeof image.contentType === "string" && image.contentType.trim()
            ? image.contentType.trim()
            : null,
        size: Number.isFinite(Number(image.size)) ? Number(image.size) : 0,
        url
      };
    })
    .filter(Boolean);
}

module.exports = {
  buildCustomerCommissionEmail,
  buildBusinessCommissionEmail,
  mapStorageImagesToLinks
};
