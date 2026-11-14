"use strict";

const { PDFDocument, StandardFonts, grayscale, rgb } = require("pdf-lib");

function maskEmail(email) {
  const normalized = typeof email === "string" ? email.trim() : "";
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return "purchaser";
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  const visible = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${visible}${"*".repeat(Math.max(3, Math.min(8, local.length - visible.length)))}@${domain}`;
}

function toPdfSafeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E\u00A9]/g, "?")
    .trim();
}

function fitText(text, font, size, maxWidth) {
  let result = toPdfSafeText(text);
  if (font.widthOfTextAtSize(result, size) <= maxWidth) {
    return result;
  }
  while (result.length > 4 && font.widthOfTextAtSize(`${result}...`, size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}...`;
}

function getLicenseeLabel({ customerName, customerEmail }) {
  const name = toPdfSafeText(customerName);
  const email = maskEmail(customerEmail);
  return name ? `${name} (${email})` : email;
}

function drawCenteredText(page, font, text, options) {
  const safeText = fitText(text, font, options.size, options.maxWidth);
  const width = font.widthOfTextAtSize(safeText, options.size);
  page.drawText(safeText, {
    x: Math.max(options.margin, (page.getWidth() - width) / 2),
    y: options.y,
    font,
    size: options.size,
    color: options.color,
    opacity: options.opacity
  });
}

async function personalizePdf(masterBuffer, details) {
  const document = await PDFDocument.load(masterBuffer, {
    updateMetadata: false
  });
  const pages = document.getPages();
  if (pages.length === 0) {
    throw new Error("Master PDF does not contain any pages");
  }

  const regularFont = await document.embedFont(StandardFonts.Helvetica);
  const boldFont = await document.embedFont(StandardFonts.HelveticaBold);
  const licensee = getLicenseeLabel(details);
  const copyId = toPdfSafeText(details.copyId);
  const orderReference = toPdfSafeText(details.orderReference);
  const year = new Date(details.purchasedAt || Date.now()).getUTCFullYear();
  const website =
    toPdfSafeText(details.personalizationConfig?.website) || "www.soggystitches.com";
  const copyrightLine = `\u00A9 ${year} Soggy Stitches. All rights reserved. ${website}`;
  const mode = details.personalizationConfig?.mode || "license_page_footer";

  if (mode === "license_page" || mode === "license_page_footer") {
    const firstPage = pages[0];
    const licensePage = document.insertPage(0, [
      firstPage.getWidth(),
      firstPage.getHeight()
    ]);
    const pageWidth = licensePage.getWidth();
    const pageHeight = licensePage.getHeight();
    const maxWidth = Math.max(120, pageWidth - 96);

    drawCenteredText(licensePage, boldFont, "Soggy Stitches", {
      y: pageHeight * 0.76,
      size: Math.min(30, Math.max(18, pageWidth / 18)),
      maxWidth,
      margin: 48,
      color: rgb(0.25, 0.12, 0.42),
      opacity: 1
    });
    drawCenteredText(licensePage, boldFont, "Personal-use licensed copy", {
      y: pageHeight * 0.67,
      size: Math.min(18, Math.max(12, pageWidth / 30)),
      maxWidth,
      margin: 48,
      color: grayscale(0.15),
      opacity: 1
    });
    drawCenteredText(licensePage, regularFont, `Licensed to ${licensee}`, {
      y: pageHeight * 0.56,
      size: 12,
      maxWidth,
      margin: 48,
      color: grayscale(0.2),
      opacity: 1
    });
    drawCenteredText(licensePage, regularFont, `Order ${orderReference} | Copy ${copyId}`, {
      y: pageHeight * 0.51,
      size: 10,
      maxWidth,
      margin: 48,
      color: grayscale(0.35),
      opacity: 1
    });
    drawCenteredText(
      licensePage,
      regularFont,
      "This copy is licensed to the purchaser for personal use and may not be redistributed.",
      {
        y: pageHeight * 0.4,
        size: 9,
        maxWidth,
        margin: 48,
        color: grayscale(0.35),
        opacity: 1
      }
    );
    drawCenteredText(licensePage, regularFont, copyrightLine, {
      y: 44,
      size: 8,
      maxWidth,
      margin: 48,
      color: grayscale(0.4),
      opacity: 1
    });
  }

  if (mode === "footer" || mode === "license_page_footer") {
    for (const page of pages) {
      const pageWidth = page.getWidth();
      if (pageWidth < 180 || page.getHeight() < 120) {
        continue;
      }
      const maxWidth = pageWidth - 32;
      drawCenteredText(page, regularFont, `Licensed to ${licensee} | Copy ${copyId}`, {
        y: 14,
        size: 6.5,
        maxWidth,
        margin: 16,
        color: grayscale(0.25),
        opacity: 0.68
      });
      drawCenteredText(page, regularFont, copyrightLine, {
        y: 5.5,
        size: 6,
        maxWidth,
        margin: 16,
        color: grayscale(0.35),
        opacity: 0.62
      });
    }
  }

  document.setCreator("Soggy Stitches");
  document.setProducer("Soggy Stitches Digital Fulfillment");
  document.setSubject(`Licensed copy ${copyId}`);
  document.setKeywords(["Soggy Stitches", "licensed copy", copyId]);
  document.setModificationDate(new Date());

  return Buffer.from(await document.save());
}

module.exports = {
  getLicenseeLabel,
  maskEmail,
  personalizePdf,
  toPdfSafeText
};
