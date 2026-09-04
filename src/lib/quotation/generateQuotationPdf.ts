import { readFileSync } from "fs";
import path from "path";
import PDFDocument from "pdfkit";
import type { QuotationDocument } from "@/lib/costings/quotationDocument";

/**
 * PDF counterpart to generateQuotationXlsx.ts, same brand palette and content
 * (2023-12-18 Brand Guidelines: colour p31, letterhead p37). Kept as a
 * separate generator rather than converting the XLSX, because a spreadsheet
 * and a print-ready document want different page mechanics — the PDF has to
 * decide where a page breaks and repeat the table header there, which a
 * worksheet never needs to.
 *
 * Typography: the guideline face is Montserrat, but there is no bundled .ttf
 * to embed (unlike the XLSX, which just names the font and lets Excel/
 * LibreOffice substitute one if it's missing — a PDF has no such fallback,
 * the glyphs have to actually be embedded). Uses PDFKit's built-in Helvetica
 * family instead: a clean grotesk in the same spirit, zero extra assets.
 */
const PURPLE = "#552C59";
const YELLOW = "#FDEE0A";
const OFFWHITE = "#F8F8F9";
const RULE = "#D8D2D9";
const INK = "#1A1A1A";
const INK_SOFT = "#6B6B6B";
const WHITE = "#FFFFFF";

const COMPANY = {
  name: "PT Cahaya Bukit Perunggu",
  tagline: "Innovative Metal Solutions",
  addressLine1: "Kampung Belimbing, RT 20 / RW 08",
  addressLine2: "Kec. Kosambi, Tangerang, Indonesia 15212",
  phone: "021 - 55933653",
  email: "info@ptcbp.com",
  web: "www.ptcbp.com",
};

const SIGN_OFF = "Melayani Sepenuh Hati";

const JAKARTA_DATE = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "long",
  year: "numeric",
});

function money(n: number): string {
  return n.toLocaleString("id-ID");
}

function logoBuffer(): Buffer | null {
  try {
    return readFileSync(path.join(process.cwd(), "src/assets/brand/cbp-logo.png"));
  } catch {
    return null;
  }
}

// A4 in points, matching generateQuotationXlsx's portrait/fit-to-width intent.
const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;

// Column layout — proportioned like the XLSX's 5/44/9/16/18 width ratios.
const COL = {
  no: { x: MARGIN, w: 30 },
  desc: { x: MARGIN + 30, w: 245 },
  qty: { x: MARGIN + 30 + 245, w: 45 },
  price: { x: MARGIN + 30 + 245 + 45, w: 90 },
  total: { x: MARGIN + 30 + 245 + 45 + 90, w: 105 },
};

export async function generateQuotationPdf(doc: QuotationDocument): Promise<Buffer> {
  const pdf = new PDFDocument({ size: "A4", margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } });
  const chunks: Buffer[] = [];
  pdf.on("data", (c) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));

  drawLetterhead(pdf);
  let y = drawTitleAndMeta(pdf, doc);
  y = drawTableHeader(pdf, y);

  doc.lines.forEach((line, i) => {
    if (y + estimateRowHeight(pdf, line) > PAGE.height - MARGIN - 60) {
      pdf.addPage();
      y = MARGIN;
      y = drawTableHeader(pdf, y);
    }
    y = drawItemRow(pdf, y, line, i % 2 === 1);
  });

  if (y + 40 > PAGE.height - MARGIN - 60) {
    pdf.addPage();
    y = MARGIN;
  }
  y = drawTotal(pdf, y, doc.totalExPpn);
  y = drawTerms(pdf, y, doc);
  drawSignatureAndFooter(pdf, y, doc);

  pdf.end();
  return done;
}

function drawLetterhead(pdf: PDFKit.PDFDocument) {
  const logo = logoBuffer();
  if (logo) {
    // Native logo is 2899x819 (~3.54:1); 130px wide keeps that ratio.
    pdf.image(logo, MARGIN, MARGIN, { width: 130, height: 36.7 });
  }

  pdf
    .font("Helvetica")
    .fontSize(8)
    .fillColor(INK_SOFT)
    .text(COMPANY.addressLine1, MARGIN, MARGIN, { width: CONTENT_WIDTH, align: "right" })
    .text(COMPANY.addressLine2, { width: CONTENT_WIDTH, align: "right" })
    .text(`${COMPANY.phone}  ·  ${COMPANY.email}`, { width: CONTENT_WIDTH, align: "right" })
    .text(COMPANY.web, { width: CONTENT_WIDTH, align: "right" });

  const ruleY = MARGIN + 48;
  pdf.rect(MARGIN, ruleY, 28, 4).fill(YELLOW);
  pdf.rect(MARGIN + 28, ruleY, CONTENT_WIDTH - 28, 4).fill(PURPLE);
}

function drawTitleAndMeta(pdf: PDFKit.PDFDocument, doc: QuotationDocument): number {
  let y = MARGIN + 64;
  pdf
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor(PURPLE)
    .text(doc.revisionNo > 0 ? `PENAWARAN HARGA (Rev. ${doc.revisionNo})` : "PENAWARAN HARGA", MARGIN, y, {
      width: CONTENT_WIDTH * 0.6,
    });
  pdf
    .font("Helvetica-Bold")
    .fontSize(11)
    .fillColor(doc.quotationNo ? PURPLE : INK_SOFT)
    .text(doc.quotationNo ?? "DRAFT — belum difinalisasi", MARGIN, y + 2, { width: CONTENT_WIDTH, align: "right" });
  y += 30;

  const issued = doc.finalizedAt ?? new Date();
  const meta: [string, string][] = [
    ["Kepada", doc.customerName || "—"],
    ["Tanggal", JAKARTA_DATE.format(issued)],
    ["Masa berlaku", `${doc.validityDays} hari`],
  ];
  for (const [label, value] of meta) {
    pdf.font("Helvetica").fontSize(9).fillColor(INK_SOFT).text(label, MARGIN, y, { width: 90 });
    pdf
      .font(label === "Kepada" ? "Helvetica-Bold" : "Helvetica")
      .fontSize(10)
      .fillColor(INK)
      .text(value, MARGIN + 90, y, { width: CONTENT_WIDTH - 90 });
    y += 16;
  }
  return y + 10;
}

function drawTableHeader(pdf: PDFKit.PDFDocument, y: number): number {
  const rowH = 22;
  pdf.rect(MARGIN, y, CONTENT_WIDTH, rowH).fill(PURPLE);
  pdf.font("Helvetica-Bold").fontSize(9.5).fillColor(WHITE);
  pdf.text("No", COL.no.x, y + 6, { width: COL.no.w, align: "center" });
  pdf.text("Deskripsi", COL.desc.x + 4, y + 6, { width: COL.desc.w - 8 });
  pdf.text("Qty", COL.qty.x, y + 6, { width: COL.qty.w, align: "right" });
  pdf.text("Harga Satuan", COL.price.x, y + 6, { width: COL.price.w - 4, align: "right" });
  pdf.text("Jumlah", COL.total.x, y + 6, { width: COL.total.w - 4, align: "right" });
  return y + rowH;
}

function descriptionText(line: QuotationDocument["lines"][number]): string {
  // Same convention as the XLSX: a set's components print as a bullet
  // breakdown inside the same cell, under the set's own description — one
  // priced line, with what it contains shown underneath (DEC-017).
  const breakdown = line.components
    .map((c) => `    • ${c.qtyPerSet > 1 ? `${c.qtyPerSet}x ` : ""}${c.description ?? "—"}`)
    .join("\n");
  return [line.description ?? "—", breakdown].filter(Boolean).join("\n");
}

function estimateRowHeight(pdf: PDFKit.PDFDocument, line: QuotationDocument["lines"][number]): number {
  pdf.font("Helvetica").fontSize(9.5);
  const h = pdf.heightOfString(descriptionText(line), { width: COL.desc.w - 8 });
  return Math.max(18, h + 10);
}

function drawItemRow(
  pdf: PDFKit.PDFDocument,
  y: number,
  line: QuotationDocument["lines"][number],
  shaded: boolean,
): number {
  const rowH = estimateRowHeight(pdf, line);
  if (shaded) pdf.rect(MARGIN, y, CONTENT_WIDTH, rowH).fill(OFFWHITE);

  pdf.font("Helvetica").fontSize(9.5).fillColor(INK);
  pdf.text(String(line.lineNo), COL.no.x, y + 5, { width: COL.no.w, align: "center" });
  pdf.text(descriptionText(line), COL.desc.x + 4, y + 5, { width: COL.desc.w - 8 });
  pdf.text(String(line.qty), COL.qty.x, y + 5, { width: COL.qty.w, align: "right" });
  pdf.text(money(line.unitSellingPrice), COL.price.x, y + 5, { width: COL.price.w - 4, align: "right" });
  pdf.text(money(line.orderTotal), COL.total.x, y + 5, { width: COL.total.w - 4, align: "right" });

  pdf
    .moveTo(MARGIN, y + rowH)
    .lineTo(MARGIN + CONTENT_WIDTH, y + rowH)
    .strokeColor(RULE)
    .lineWidth(0.5)
    .stroke();
  return y + rowH;
}

function drawTotal(pdf: PDFKit.PDFDocument, y: number, totalExPpn: number): number {
  y += 6;
  const rowH = 24;
  const labelW = COL.no.w + COL.desc.w + COL.qty.w + COL.price.w;
  pdf.font("Helvetica-Bold").fontSize(10).fillColor(PURPLE);
  pdf.text("TOTAL (belum termasuk PPN)", MARGIN, y + 7, { width: labelW - 8, align: "right" });
  pdf.rect(COL.total.x, y, COL.total.w, rowH).fill(YELLOW);
  pdf.font("Helvetica-Bold").fontSize(11).fillColor(PURPLE);
  pdf.text(money(totalExPpn), COL.total.x, y + 7, { width: COL.total.w - 4, align: "right" });
  return y + rowH + 20;
}

function drawTerms(pdf: PDFKit.PDFDocument, y: number, doc: QuotationDocument): number {
  pdf.font("Helvetica-Bold").fontSize(10).fillColor(PURPLE).text("Syarat & Ketentuan", MARGIN, y);
  y += 16;

  const allTerms = [...doc.terms];
  if (doc.paymentTerms) allTerms.push(`Termin pembayaran: ${doc.paymentTerms}`);

  pdf.font("Helvetica").fontSize(9).fillColor(INK);
  allTerms.forEach((text, i) => {
    const label = `${i + 1}.`;
    pdf.text(label, MARGIN, y, { width: 18 });
    const h = pdf.heightOfString(text, { width: CONTENT_WIDTH - 22 });
    pdf.text(text, MARGIN + 22, y, { width: CONTENT_WIDTH - 22 });
    y += Math.max(13, h + 4);
  });
  return y + 16;
}

function drawSignatureAndFooter(pdf: PDFKit.PDFDocument, y: number, doc: QuotationDocument) {
  const signX = MARGIN + CONTENT_WIDTH - 200;
  if (y + 90 > PAGE.height - MARGIN - 30) {
    pdf.addPage();
    y = MARGIN;
  }

  pdf.font("Helvetica").fontSize(9.5).fillColor(PURPLE).text(SIGN_OFF, signX, y, { width: 200 });
  pdf
    .font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(INK)
    .text(doc.preparedBy ?? "", signX, y + 46, { width: 200 });
  let signY = y + 60;
  if (doc.preparedByTitle) {
    pdf.font("Helvetica").fontSize(9).fillColor(INK_SOFT).text(doc.preparedByTitle, signX, signY, { width: 200 });
    signY += 13;
  }

  const footerY = PAGE.height - MARGIN - 20;
  pdf.rect(MARGIN, footerY, CONTENT_WIDTH - 60, 3).fill(PURPLE);
  pdf.rect(MARGIN + CONTENT_WIDTH - 60, footerY, 60, 3).fill(YELLOW);
  pdf
    .font("Helvetica-Oblique")
    .fontSize(9)
    .fillColor(PURPLE)
    .text(COMPANY.tagline, MARGIN, footerY + 6, { width: CONTENT_WIDTH, align: "center" });
}
