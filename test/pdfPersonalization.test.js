"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PDFDocument } = require("pdf-lib");
const {
  maskEmail,
  personalizePdf
} = require("../src/lib/pdfPersonalization");

test("personalization adds a license page without resizing the source page", async () => {
  const master = await PDFDocument.create();
  master.addPage([612, 792]);
  const masterBytes = await master.save();

  const personalizedBytes = await personalizePdf(Buffer.from(masterBytes), {
    customerName: "Blue Berry",
    customerEmail: "blueberry@example.com",
    copyId: "SS-1234-5678-90AB",
    orderReference: "order-123",
    purchasedAt: new Date("2026-07-23T12:00:00Z"),
    personalizationConfig: {
      mode: "license_page_footer",
      website: "www.soggystitches.com"
    }
  });

  const personalized = await PDFDocument.load(personalizedBytes);
  assert.equal(personalized.getPageCount(), 2);
  assert.deepEqual(personalized.getPage(1).getSize(), { width: 612, height: 792 });
  assert.equal(personalized.getCreator(), "Soggy Stitches");
  assert.equal(personalized.getSubject(), "Licensed copy SS-1234-5678-90AB");
  assert.match(personalized.getKeywords() || "", /SS-1234-5678-90AB/);
});

test("customer email is masked before it is printed into a PDF", () => {
  assert.equal(maskEmail("blueberry@example.com"), "bl*******@example.com");
  assert.equal(maskEmail("x@example.com"), "x***@example.com");
});
