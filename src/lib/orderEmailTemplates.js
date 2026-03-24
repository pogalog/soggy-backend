"use strict";

const { env } = require("../config/env");

const FLAT_SHIPPING_PRODUCT_ID = "sys_shipping_flat_fee";

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

function formatMoney(cents, currency) {
  const amount = Number(cents || 0);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD"
  }).format(amount / 100);
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
              Handmade work, stitched with care.
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

function buildFooterHtml() {
  return `
    <div style="padding:20px 28px 26px 28px;border-top:1px solid ${theme.shellBorder};background:
      radial-gradient(circle at bottom left, rgba(155,109,255,0.10), transparent 34%),
      linear-gradient(180deg, ${theme.footerBg} 0%, #09090d 100%);">
      <div style="padding:16px 18px;border:1px solid ${theme.panelBorder};border-radius:16px;background:rgba(255,255,255,0.015);">
        <div style="margin:0 0 10px 0;color:${theme.purpleSoft};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:13px;font-weight:700;letter-spacing:2.4px;text-transform:uppercase;">
          Reply & Contact
        </div>
        <div style="margin:0 0 8px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.6;">
          You can reply directly to this email if you need help with your order or shipping details.
        </div>
      </div>
      <div style="margin-top:14px;color:${theme.textSubtle};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:12px;line-height:1.6;">
        ${escapeHtml(env.commissionCompanyName)} | Handmade crochet work and custom pieces
      </div>
    </div>
  `;
}

function buildEmailShell({ title, bodyHtml }) {
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
        ${buildFooterHtml()}
      </div>
    </div>
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

function buildDetailRowHtml(label, htmlValue) {
  return `
    <tr>
      <td style="padding:12px 14px;border-bottom:1px solid ${theme.panelBorder};font-weight:700;vertical-align:top;width:220px;color:${theme.goldSoft};background:rgba(155,109,255,0.05);">
        ${escapeHtml(label)}
      </td>
      <td style="padding:12px 14px;border-bottom:1px solid ${theme.panelBorder};color:${theme.textPrimary};background:rgba(255,255,255,0.01);">
        ${htmlValue}
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

function isCommissionOrderItem(productId) {
  return typeof productId === "string" && /^cm_[0-9a-f]+$/i.test(productId);
}

function isShippingLineItem(item) {
  return item && item.productId === FLAT_SHIPPING_PRODUCT_ID;
}

function buildItemUrl(productId) {
  const baseUrl =
    typeof env.appBaseUrl === "string" && env.appBaseUrl.trim()
      ? env.appBaseUrl.trim().replace(/\/+$/, "")
      : "https://www.soggystitches.com";

  if (isCommissionOrderItem(productId)) {
    return `${baseUrl}/commission/${encodeURIComponent(productId)}`;
  }

  return `${baseUrl}/products/${encodeURIComponent(productId)}`;
}

function buildOrderUrl(orderId) {
  const baseUrl =
    typeof env.appBaseUrl === "string" && env.appBaseUrl.trim()
      ? env.appBaseUrl.trim().replace(/\/+$/, "")
      : "https://www.soggystitches.com";

  return `${baseUrl}/orders/${encodeURIComponent(orderId)}`;
}

function buildOrderItemsHtml(items, currency) {
  const displayItems = Array.isArray(items) ? items.filter((item) => !isShippingLineItem(item)) : [];

  if (displayItems.length === 0) {
    return "<p style=\"margin:0;color:#d7d3e2;font-size:15px;line-height:1.7;\">Order details will follow shortly.</p>";
  }

  return displayItems
    .map((item) => {
      const itemUrl = buildItemUrl(item.productId);
      const thumbnailHtml = item.stripeThumbUrl
        ? `<img src="${escapeHtml(item.stripeThumbUrl)}" alt="${escapeHtml(
            item.name
          )}" width="88" height="88" style="display:block;width:88px;height:88px;border:0;border-radius:16px;object-fit:cover;background:#1c1d24;" />`
        : `<div style="width:88px;height:88px;border-radius:16px;background:linear-gradient(135deg, rgba(155,109,255,0.14) 0%, rgba(215,178,74,0.12) 100%);border:1px solid ${theme.panelBorder};"></div>`;

      return `
        <div style="margin:0 0 14px 0;padding:16px 18px;border-radius:20px;background:${theme.mutedPanel};border:1px solid ${theme.panelBorder};">
          <table role="presentation" style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="width:104px;vertical-align:top;padding:0 16px 0 0;">
                <a href="${escapeHtml(itemUrl)}" style="text-decoration:none;">
                  ${thumbnailHtml}
                </a>
              </td>
              <td style="vertical-align:top;padding:0;">
                <a href="${escapeHtml(itemUrl)}" style="color:${theme.textPrimary};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:18px;font-weight:700;line-height:1.35;text-decoration:none;">
                  ${escapeHtml(item.name)}
                </a>
                <div style="margin-top:6px;color:${theme.textSubtle};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:13px;line-height:1.6;">
                  Item ID: ${escapeHtml(item.productId)}
                </div>
                <div style="margin-top:10px;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:14px;line-height:1.6;">
                  Qty ${escapeHtml(String(item.quantity))} · ${escapeHtml(
                    formatMoney(item.unitAmount, currency)
                  )} each
                </div>
                <div style="margin-top:12px;">
                  <a href="${escapeHtml(itemUrl)}" style="color:${theme.purpleSoft};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:14px;font-weight:700;text-decoration:none;">
                    View product
                  </a>
                </div>
              </td>
              <td style="vertical-align:top;padding:0;text-align:right;white-space:nowrap;color:${theme.textPrimary};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;font-weight:700;line-height:1.4;">
                ${escapeHtml(formatMoney(item.unitAmount * item.quantity, currency))}
              </td>
            </tr>
          </table>
        </div>
      `;
    })
    .join("");
}

function computeItemSubtotal(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => !isShippingLineItem(item))
    .reduce(
      (sum, item) => sum + Number(item.unitAmount || 0) * Number(item.quantity || 0),
      0
    );
}

function deriveShippingAmount(order, shippingAmount) {
  if (Number.isFinite(Number(shippingAmount))) {
    return Number(shippingAmount);
  }

  if (order && Number.isFinite(Number(order.shippingAmount))) {
    return Number(order.shippingAmount);
  }

  const shippingItem = Array.isArray(order && order.items)
    ? order.items.find((item) => isShippingLineItem(item))
    : null;

  return shippingItem
    ? Number(shippingItem.unitAmount || 0) * Number(shippingItem.quantity || 0)
    : 0;
}

function deriveShippingMethod(order, shippingMethod, shippingAmount) {
  if (typeof shippingMethod === "string" && shippingMethod.trim()) {
    return shippingMethod.trim();
  }

  if (order && typeof order.shippingMethod === "string" && order.shippingMethod.trim()) {
    return order.shippingMethod.trim();
  }

  return deriveShippingAmount(order, shippingAmount) > 0 ? "Standard shipping" : "Not provided";
}

function deriveShippingEstimate(order) {
  const quote = order && order.shippingQuote && typeof order.shippingQuote === "object"
    ? order.shippingQuote
    : null;

  if (!quote || typeof quote.estimatedDeliveryDate !== "string" || !quote.estimatedDeliveryDate.trim()) {
    return null;
  }

  const dateValue = quote.estimatedDeliveryDate.trim();
  if (!/^\d{8}$/.test(dateValue)) {
    return dateValue;
  }

  const formattedDate = `${dateValue.slice(0, 4)}-${dateValue.slice(4, 6)}-${dateValue.slice(6, 8)}`;
  const parsed = new Date(`${formattedDate}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    return dateValue;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium"
  }).format(parsed);
}

function buildTaxLabel(taxSummary) {
  const jurisdictions =
    taxSummary && Array.isArray(taxSummary.jurisdictions)
      ? taxSummary.jurisdictions.filter(
          (value) => typeof value === "string" && value.trim()
        )
      : [];

  if (jurisdictions.length === 0) {
    return "Taxes";
  }

  return `Taxes (${jurisdictions.join(", ")})`;
}

function buildCostBreakdownHtml({ order, shippingAmount, taxSummary }) {
  const currency = order && typeof order.currency === "string" ? order.currency : "USD";
  const itemSubtotal = computeItemSubtotal(order.items);
  const resolvedShippingAmount = deriveShippingAmount(order, shippingAmount);
  const taxAmount =
    taxSummary && Number.isFinite(Number(taxSummary.amount))
      ? Number(taxSummary.amount)
      : Number(order.taxAmount || 0);

  return buildTable([
    buildDetailRow("Items subtotal", formatMoney(itemSubtotal, currency)),
    buildDetailRow(
      "Shipping",
      resolvedShippingAmount > 0 ? formatMoney(resolvedShippingAmount, currency) : "Included"
    ),
    buildDetailRow(buildTaxLabel(taxSummary), formatMoney(taxAmount, currency)),
    buildDetailRow("Grand total", formatMoney(order.totalAmount, currency))
  ]);
}

function buildShippingAddressValue(shippingDetails) {
  if (!shippingDetails || !shippingDetails.address) {
    return "Not available from the completed checkout session.";
  }

  const address = shippingDetails.address;
  const lines = [
    shippingDetails.name,
    address.line1,
    address.line2,
    [address.city, address.state, address.postalCode].filter(Boolean).join(", "),
    address.country
  ].filter(Boolean);

  return lines.map((line) => escapeHtml(line)).join("<br />");
}

function buildShippingInfoTable({ shippingDetails, shippingMethod, shippingAmount, order }) {
  const currency = order && typeof order.currency === "string" ? order.currency : "USD";
  const rows = [
    buildDetailRow("Shipping method", deriveShippingMethod(order, shippingMethod, shippingAmount)),
    buildDetailRow(
      "Shipping cost",
      formatMoney(deriveShippingAmount(order, shippingAmount), currency)
    ),
    ...(deriveShippingEstimate(order)
      ? [buildDetailRow("Estimated delivery", deriveShippingEstimate(order))]
      : []),
    buildDetailRowHtml("Shipping address", buildShippingAddressValue(shippingDetails))
  ];

  return buildTable(rows);
}

function buildOrderConfirmationCustomerEmail({
  order,
  shippingDetails,
  shippingMethod,
  shippingAmount,
  taxSummary
}) {
  const companyName = escapeHtml(env.commissionCompanyName || "Soggy Stitches");
  const orderUrl = buildOrderUrl(order.id);

  const bodyHtml = `
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:17px;line-height:1.75;">
      Thank you for your order. Your payment has been received, your order is confirmed, and we are getting it into our work queue.
    </p>
    <p style="margin:0 0 16px 0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:16px;line-height:1.75;">
      We will begin work on it and notify you once it ships. If you need to check back on the order later, keep the order ID below handy.
    </p>
    <div style="margin:0 0 22px 0;padding:18px 20px;border-radius:18px;background:
      linear-gradient(135deg, rgba(155,109,255,0.12) 0%, rgba(215,178,74,0.08) 100%),
      ${theme.mutedPanel};border:1px solid ${theme.panelBorder};">
      ${buildSectionLabel("Order Snapshot")}
      <div style="color:${theme.textPrimary};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">
        <strong style="color:${theme.goldSoft};">Order ID:</strong>
        <span style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${escapeHtml(
          order.id
        )}</span>
      </div>
      <div style="margin-top:8px;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">
        Status: ${escapeHtml(order.status)}
      </div>
    </div>

    ${buildSectionLabel("Items")}
    ${buildOrderItemsHtml(order.items, order.currency)}

    <div style="margin-top:22px;">
      ${buildSectionLabel("Cost Breakdown")}
      ${buildCostBreakdownHtml({ order, shippingAmount, taxSummary })}
    </div>

    <div style="margin-top:22px;">
      ${buildSectionLabel("Shipping Information")}
      ${buildShippingInfoTable({ shippingDetails, shippingMethod, shippingAmount, order })}
    </div>

    <div style="margin-top:22px;padding:20px;background:${theme.mutedPanel};border:1px solid ${theme.panelBorder};border-radius:18px;">
      ${buildSectionLabel("Need Anything Else?")}
      <p style="margin:0;color:${theme.textMuted};font-family:'Trebuchet MS','Segoe UI',Arial,sans-serif;font-size:15px;line-height:1.75;">
        Each item name above links back to its product page. If you need to reference the order later, use the button below to jump to your order page on the site.
      </p>
      ${buildActionButton("View Order", orderUrl)}
    </div>
  `;

  return {
    subject: `${companyName}: Order confirmation (${order.id})`,
    html: buildEmailShell({
      title: "Thank you for your order!",
      bodyHtml
    })
  };
}

module.exports = {
  buildOrderConfirmationCustomerEmail
};
