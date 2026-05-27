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

const commissionDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric"
});

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: env.priceCurrency || "USD"
});

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

function formatDisplayDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Not provided";
  }

  return commissionDateFormatter.format(date);
}

function formatCurrencyFromCents(value) {
  const cents = Number(value);
  if (!Number.isFinite(cents)) {
    return "Not provided";
  }

  return currencyFormatter.format(cents / 100);
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

function normalizeYarnColors(value, fallbackColor) {
  const colors = Array.isArray(value) ? value : [];
  const normalizedColors = colors
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }

      const color = typeof entry.color === "string" ? entry.color.trim() : "";
      if (!color) {
        return null;
      }

      return {
        color,
        usage: typeof entry.usage === "string" ? entry.usage.trim() : ""
      };
    })
    .filter(Boolean);

  if (normalizedColors.length > 0) {
    return normalizedColors;
  }

  const normalizedFallback = typeof fallbackColor === "string" ? fallbackColor.trim() : "";
  return normalizedFallback ? [{ color: normalizedFallback, usage: "Primary color" }] : [];
}

function buildYarnColorsDetailRow(label, yarnColors, fallbackColor) {
  const normalizedColors = normalizeYarnColors(yarnColors, fallbackColor);
  const content = normalizedColors.length
    ? normalizedColors
        .map((entry) => {
          const safeColor = escapeHtml(entry.color);
          const safeUsage = entry.usage ? escapeHtml(entry.usage) : "No usage notes provided";

          return `
            <div style="margin:0 0 10px 0;">
              <span style="display:inline-block;width:14px;height:14px;vertical-align:middle;margin-right:10px;border-radius:999px;border:1px solid rgba(255,255,255,0.24);background:${safeColor};"></span>
              <span style="vertical-align:middle;font-weight:700;">${safeColor}</span>
              <div style="margin:4px 0 0 26px;color:${theme.textMuted};font-size:13px;line-height:1.55;">${safeUsage}</div>
            </div>
          `;
        })
        .join("")
    : "Not provided";

  return `
    <tr>
      <td style="padding:12px 14px;border-bottom:1px solid ${theme.panelBorder};font-weight:700;vertical-align:top;width:220px;color:${theme.goldSoft};background:rgba(155,109,255,0.05);">
        ${escapeHtml(label)}
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid ${theme.panelBorder};color:${theme.textPrimary};background:rgba(255,255,255,0.01);">
        ${content}
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

function buildActionButton(label, href) {
  return `
    <div style="margin-top:18px;text-align:center;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 24px;border-radius:999px;background:linear-gradient(135deg, ${theme.purple} 0%, ${theme.purpleDeep} 100%);color:${theme.textPrimary};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:0.2px;text-decoration:none;">
        ${escapeHtml(label)}
      </a>
    </div>
  `;
}

function buildCenteredValueBlock({ label, value, helperText }) {
  return `
    <div style="margin-top:18px;padding:20px 22px;text-align:center;background:
      linear-gradient(135deg, rgba(155,109,255,0.14) 0%, rgba(215,178,74,0.12) 100%),
      ${theme.mutedPanel};border:1px solid ${theme.panelBorder};border-radius:18px;">
      <div style="margin:0 0 8px 0;color:${theme.gold};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:3.2px;text-transform:uppercase;">
        ${escapeHtml(label)}
      </div>
      <div style="margin:0;color:${theme.textPrimary};font-family:'Trebuchet MS','Avenir Next','Segoe UI',Arial,sans-serif;font-size:31px;font-weight:700;line-height:1.2;">
        ${escapeHtml(value)}
      </div>
      ${
        helperText
          ? `<div style="margin-top:10px;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.65;">${escapeHtml(helperText)}</div>`
          : ""
      }
    </div>
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

function buildCommissionLifecycleRows(commission) {
  return [
    buildDetailRow("Commission ID", commission.id),
    buildDetailRow("Item", commission.itemName),
    buildDetailRow("Description", commission.itemDescription),
    buildDetailRow("Yarn Type", commission.yarnType),
    buildYarnColorsDetailRow("Yarn Colors", commission.yarnColors, commission.yarnColor),
    buildDetailRow(
      "Attachment Material",
      commission.attachmentMaterialType
    ),
    buildDetailRow(
      "Commission Request Date",
      formatDisplayDate(commission.createdAt)
    )
  ];
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
    buildYarnColorsDetailRow(
      "Yarn Colors",
      request.materials.yarnColors,
      request.materials.yarnColor
    ),
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
    buildYarnColorsDetailRow(
      "Yarn Colors",
      request.materials.yarnColors,
      request.materials.yarnColor
    ),
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

function buildCommissionCommitEmail({ commission }) {
  const rows = buildCommissionLifecycleRows(commission);
  const commissionUrl = `https://www.soggystitches.com/commission/${encodeURIComponent(
    commission.id
  )}`;
  const estimatedCompletionDate = new Date();
  estimatedCompletionDate.setDate(
    estimatedCompletionDate.getDate() + Number(commission.timeCostDays)
  );
  const commitmentMessage = commission.requiresCommit
    ? "After reviewing your request, we determined that a commitment deposit is needed to cover material costs before work can proceed. Please use the link below to review the deposit amount and provide payment."
    : "After reviewing your request, we are ready to move forward without an upfront materials payment. Please use the link below to confirm that you would like us to proceed with the work.";

  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.75;">We have reviewed your request and prepared a quote for the estimated time to completion and the amount we expect to charge for the work and product.</p>
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.75;">The quoted price should generally be treated as the maximum total for the commission. The final amount may be lower, but it will not exceed this quote unless a revised quote is sent after additional discovery or requested corrections.</p>
    ${buildSectionLabel("Commission Details")}
    ${buildTable(rows)}
    <div style="margin-top:22px;padding:20px;background:
      linear-gradient(135deg, rgba(155,109,255,0.12) 0%, rgba(215,178,74,0.08) 100%),
      ${theme.mutedPanel};border:1px solid ${theme.panelBorder};border-radius:18px;">
      ${buildSectionLabel("Next Step")}
      <p style="margin:0 0 12px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">${escapeHtml(commitmentMessage)}</p>
      ${
        commission.requiresCommit
          ? `<p style="margin:0 0 12px 0;color:${theme.textPrimary};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;font-weight:700;line-height:1.75;">Your commitment deposit due today is ${escapeHtml(formatCurrencyFromCents(commission.commitmentDepositCents))}.</p>`
          : ""
      }
      <p style="margin:0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">If you decide to cancel at this point, that is fine too. Please visit the same link below and let us know that you need to cancel the request.</p>
      ${buildActionButton(
        commission.requiresCommit
          ? "Review Commitment"
          : "Confirm Commission",
        commissionUrl
      )}
    </div>
    ${buildCenteredValueBlock({
      label: "Total Cost",
      value: formatCurrencyFromCents(commission.totalCostCents)
    })}
    ${
      commission.requiresCommit
        ? buildCenteredValueBlock({
            label: "Commitment Deposit",
            value: formatCurrencyFromCents(commission.commitmentDepositCents),
            helperText:
              "This deposit is the amount due now to begin work. The remaining balance is handled later."
          })
        : ""
    }
    ${buildCenteredValueBlock({
      label: "Estimated Time To Completion",
      value: formatDisplayDate(estimatedCompletionDate),
      helperText:
        "This estimated ship-by date is calculated from the date you commit to the work. If you commit later, the completion date will move accordingly."
    })}
  `;

  return {
    subject: `Your commission quote is ready (${commission.id})`,
    html: buildEmailShell({
      title: "Commission Quote Ready",
      bodyHtml,
      footer: {
        replyEmail: env.commissionFromEmail,
        introText:
          "You can reply directly to this email if you have questions about the quote or the next step.",
        labelText: "Reply to"
      }
    })
  };
}

function buildCommissionFinalizeEmail({ commission }) {
  const rows = buildCommissionLifecycleRows(commission);
  const commissionUrl = `https://www.soggystitches.com/commission/${encodeURIComponent(
    commission.id
  )}`;

  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.75;">Your commission is finished and ready for final checkout.</p>
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.75;">Please use the link below to review the completed commission and pay any remaining balance so we can prepare it for shipment.</p>
    ${buildSectionLabel("Commission Details")}
    ${buildTable(rows)}
    <div style="margin-top:22px;padding:20px;background:
      linear-gradient(135deg, rgba(155,109,255,0.12) 0%, rgba(215,178,74,0.08) 100%),
      ${theme.mutedPanel};border:1px solid ${theme.panelBorder};border-radius:18px;">
      ${buildSectionLabel("Final Checkout")}
      <p style="margin:0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">When payment is complete, we can move ahead with shipping your finished item.</p>
      ${buildActionButton("Complete Final Checkout", commissionUrl)}
    </div>
    ${buildCenteredValueBlock({
      label: "Total Cost",
      value: formatCurrencyFromCents(commission.totalCostCents)
    })}
  `;

  return {
    subject: `Your commission is ready for final checkout (${commission.id})`,
    html: buildEmailShell({
      title: "Commission Ready To Ship",
      bodyHtml,
      footer: {
        replyEmail: env.commissionFromEmail,
        introText:
          "Reply directly to this email if you need help with final checkout or shipping details.",
        labelText: "Reply to"
      }
    })
  };
}

function buildCommissionCustomerDecisionBusinessEmail({
  commission,
  action,
  customerEmail
}) {
  const rows = [
    buildDetailRow("Commission ID", commission.id),
    buildDetailRow("Customer action", action === "cancel" ? "Cancelled" : "Committed"),
    buildDetailRow("Customer email", customerEmail),
    buildDetailRow("Item", commission.itemName),
    buildDetailRow("Description", commission.itemDescription),
    buildDetailRow("Quoted total", formatCurrencyFromCents(commission.totalCostCents)),
    buildDetailRow(
      "Commitment deposit",
      commission.requiresCommit
        ? formatCurrencyFromCents(commission.commitmentDepositCents)
        : "Not required"
    ),
    buildDetailRow(
      "Estimated ship-by",
      commission.shipDate ? formatDisplayDate(commission.shipDate) : "Not provided"
    ),
    buildDetailRow("Current status", commission.status)
  ];

  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.75;">
      The customer has ${action === "cancel" ? "cancelled" : "confirmed"} the commission request.
    </p>
    ${buildSectionLabel("Commission Details")}
    ${buildTable(rows)}
  `;

  return {
    subject: `${
      action === "cancel" ? "Commission cancelled" : "Commission confirmed"
    } (${commission.id})`,
    html: buildEmailShell({
      title: action === "cancel" ? "Commission Cancelled" : "Commission Confirmed",
      bodyHtml,
      footer: {
        replyEmail: env.commissionBusinessEmail,
        introText:
          "Reply directly to the customer if you need to follow up about this commission update.",
        labelText: "Business inbox"
      }
    })
  };
}

function buildCommissionCustomerDecisionCustomerEmail({ commission, action }) {
  const rows = [
    buildDetailRow("Commission ID", commission.id),
    buildDetailRow("Item", commission.itemName),
    buildDetailRow("Description", commission.itemDescription),
    buildDetailRow("Quoted total", formatCurrencyFromCents(commission.totalCostCents)),
    buildDetailRow(
      "Commitment deposit",
      commission.requiresCommit
        ? formatCurrencyFromCents(commission.commitmentDepositCents)
        : "Not required"
    ),
    buildDetailRow(
      "Estimated ship-by",
      commission.shipDate ? formatDisplayDate(commission.shipDate) : "Not provided"
    )
  ];

  const bodyHtml =
    action === "cancel"
      ? `
        <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.75;">
          Your commission request has been marked as cancelled.
        </p>
        <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.75;">
          We are so sorry to see you go. We hope you will seek our services for your future creations.
        </p>
        ${buildSectionLabel("Commission Details")}
        ${buildTable(rows)}
      `
      : `
        <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.75;">
          Your commission is now moving forward.
        </p>
        <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.75;">
          Thank you for choosing Soggy Stitches.
        </p>
        ${buildSectionLabel("Commission Details")}
        ${buildTable(rows)}
      `;

  return {
    subject: `${
      action === "cancel" ? "Commission request cancelled" : "Commission confirmed"
    } (${commission.id})`,
    html: buildEmailShell({
      title: action === "cancel" ? "Commission Cancelled" : "Commission Confirmed",
      bodyHtml,
      footer: {
        replyEmail: env.commissionFromEmail,
        introText:
          action === "cancel"
            ? "Reply directly to this email if you would like to revisit the project in the future."
            : "Reply directly to this email if you have any questions while we prepare your commission.",
        labelText: "Reply to"
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
  buildCommissionCommitEmail,
  buildCommissionFinalizeEmail,
  buildCommissionCustomerDecisionBusinessEmail,
  buildCommissionCustomerDecisionCustomerEmail,
  mapStorageImagesToLinks
};
