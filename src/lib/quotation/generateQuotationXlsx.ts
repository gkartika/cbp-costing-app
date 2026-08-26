import { readFileSync } from "fs";
import path from "path";
import ExcelJS from "exceljs";
import type { QuotationDocument } from "@/lib/costings/quotationDocument";

/**
 * CBP brand palette and letterhead, taken from the 2023-12-18 Brand Guidelines
 * (colour palette p31, typography p32, letterhead p37). DEC-016 is closed:
 * these are the real assets, no longer placeholders.
 *
 * ExcelJS wants ARGB, so each hex is prefixed FF (fully opaque).
 */
const PURPLE = "FF552C59"; // #552C59 — Warna Utama
const YELLOW = "FFFDEE0A"; // #FDEE0A — Warna Sekunder
const OFFWHITE = "FFF8F8F9"; // #F8F8F9
const RULE = "FFD8D2D9"; // tinted neutral derived from the purple, for hairlines
const INK_SOFT = "FF6B6B6B";

/** Montserrat per the guidelines; Calibri is the fallback Excel will actually have. */
const FONT = "Montserrat";

const COMPANY = {
  name: "PT Cahaya Bukit Perunggu",
  tagline: "Innovative Metal Solutions",
  addressLine1: "Kampung Belimbing, RT 20 / RW 08",
  addressLine2: "Kec. Kosambi, Tangerang, Indonesia 15212",
  phone: "021 - 55933653",
  email: "info@ptcbp.com",
  web: "www.ptcbp.com",
};

/** CBP's sign-off above the salesperson's name, in place of a generic closing. */
const SIGN_OFF = "Melayani Sepenuh Hati";

const MONEY = '#,##0';

const JAKARTA_DATE = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "long",
  year: "numeric",
});

function logoBuffer(): Buffer | null {
  // Bundled with the source rather than read from a URL so an export never
  // depends on network or on Next's static route being reachable.
  try {
    return readFileSync(path.join(process.cwd(), "src/assets/brand/cbp-logo.png"));
  } catch {
    // A missing asset must not break pricing output — the quotation still
    // carries the company name block below the logo slot.
    return null;
  }
}

export async function generateQuotationXlsx(doc: QuotationDocument): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = COMPANY.name;
  wb.created = new Date();

  const sheet = wb.addWorksheet("Quotation", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } },
    views: [{ showGridLines: false }],
  });

  sheet.columns = [
    { width: 5 }, // No
    { width: 44 }, // Description
    { width: 9 }, // Qty
    { width: 16 }, // Unit price
    { width: 18 }, // Total
  ];

  // ---------------------------------------------------------------- letterhead
  const logo = logoBuffer();
  if (logo) {
    const imageId = wb.addImage({ buffer: new Uint8Array(logo) as unknown as ExcelJS.Buffer, extension: "png" });
    // Native logo is 2899x819 (~3.54:1); 190px wide keeps that ratio exactly.
    sheet.addImage(imageId, { tl: { col: 0.15, row: 0.3 }, ext: { width: 190, height: 54 } });
  }
  sheet.getRow(1).height = 22;
  sheet.getRow(2).height = 22;
  sheet.getRow(3).height = 16;

  // Contact block, right-aligned opposite the logo, as on the letterhead.
  const contact = [COMPANY.addressLine1, COMPANY.addressLine2, `${COMPANY.phone}  ·  ${COMPANY.email}`, COMPANY.web];
  contact.forEach((text, i) => {
    const row = i + 1;
    sheet.mergeCells(row, 3, row, 5);
    const cell = sheet.getCell(row, 3);
    cell.value = text;
    cell.font = { name: FONT, size: 8, color: { argb: INK_SOFT } };
    cell.alignment = { horizontal: "right", vertical: "middle" };
  });

  // Brand rule: purple bar with a yellow tab, echoing the logomark's two colours.
  sheet.getRow(5).height = 5;
  for (let c = 1; c <= 5; c++) {
    sheet.getCell(5, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: c === 1 ? YELLOW : PURPLE } };
  }

  // ---------------------------------------------------------------- title
  sheet.getRow(7).height = 26;
  sheet.mergeCells("A7:C7");
  const title = sheet.getCell("A7");
  title.value = doc.revisionNo > 0 ? `PENAWARAN HARGA (Rev. ${doc.revisionNo})` : "PENAWARAN HARGA";
  title.font = { name: FONT, size: 16, bold: true, color: { argb: PURPLE } };
  title.alignment = { vertical: "middle" };

  sheet.mergeCells("D7:E7");
  const noCell = sheet.getCell("D7");
  noCell.value = doc.quotationNo ?? "DRAFT — belum difinalisasi";
  noCell.font = { name: FONT, size: 11, bold: true, color: { argb: doc.quotationNo ? PURPLE : INK_SOFT } };
  noCell.alignment = { horizontal: "right", vertical: "middle" };

  // ---------------------------------------------------------------- meta
  const issued = doc.finalizedAt ?? new Date();
  const meta: [string, string][] = [
    ["Kepada", doc.customerName || "—"],
    ["Tanggal", JAKARTA_DATE.format(issued)],
    ["Masa berlaku", `${doc.validityDays} hari`],
  ];
  meta.forEach(([label, value], i) => {
    const row = 9 + i;
    sheet.getCell(row, 1).value = label;
    sheet.getCell(row, 1).font = { name: FONT, size: 9, color: { argb: INK_SOFT } };
    sheet.mergeCells(row, 2, row, 3);
    sheet.getCell(row, 2).value = value;
    sheet.getCell(row, 2).font = { name: FONT, size: 10, bold: label === "Kepada" };
  });

  // ---------------------------------------------------------------- items
  const headerRowNo = 13;
  const header = sheet.getRow(headerRowNo);
  header.values = ["No", "Deskripsi", "Qty", "Harga Satuan", "Jumlah"];
  header.height = 20;
  header.eachCell((cell, col) => {
    cell.font = { name: FONT, size: 9.5, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PURPLE } };
    cell.alignment = { vertical: "middle", horizontal: col === 2 ? "left" : col === 1 ? "center" : "right" };
  });

  doc.lines.forEach((line, i) => {
    const r = headerRowNo + 1 + i;
    const row = sheet.getRow(r);
    row.values = [line.lineNo, line.description ?? "—", line.qty, line.unitSellingPrice, line.orderTotal];
    row.height = 18;
    row.eachCell((cell, col) => {
      cell.font = { name: FONT, size: 9.5 };
      cell.alignment = { vertical: "middle", horizontal: col === 2 ? "left" : col === 1 ? "center" : "right" };
      if (col >= 3) cell.numFmt = MONEY;
      cell.border = { bottom: { style: "hair", color: { argb: RULE } } };
      // Zebra banding keeps long item lists readable in print.
      if (i % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: OFFWHITE } };
    });
  });

  // ---------------------------------------------------------------- total
  const totalRowNo = headerRowNo + doc.lines.length + 1;
  const totalRow = sheet.getRow(totalRowNo);
  totalRow.height = 22;
  sheet.mergeCells(totalRowNo, 1, totalRowNo, 4);
  const totalLabel = sheet.getCell(totalRowNo, 1);
  totalLabel.value = "TOTAL (belum termasuk PPN)";
  totalLabel.font = { name: FONT, size: 10, bold: true, color: { argb: PURPLE } };
  totalLabel.alignment = { horizontal: "right", vertical: "middle" };
  const totalValue = sheet.getCell(totalRowNo, 5);
  totalValue.value = doc.totalExPpn;
  totalValue.numFmt = MONEY;
  totalValue.font = { name: FONT, size: 11, bold: true, color: { argb: PURPLE } };
  totalValue.alignment = { horizontal: "right", vertical: "middle" };
  totalValue.fill = { type: "pattern", pattern: "solid", fgColor: { argb: YELLOW } };

  // ---------------------------------------------------------------- terms
  let r = totalRowNo + 2;
  const termsTitle = sheet.getCell(r, 1);
  termsTitle.value = "Syarat & Ketentuan";
  termsTitle.font = { name: FONT, size: 10, bold: true, color: { argb: PURPLE } };
  r += 1;

  const allTerms = [...doc.terms];
  // Payment terms are per-account, so they join the list only when the customer
  // actually has one recorded — an empty line would read as an omission.
  if (doc.paymentTerms) allTerms.push(`Termin pembayaran: ${doc.paymentTerms}`);

  allTerms.forEach((text, i) => {
    const row = r + i;
    sheet.getCell(row, 1).value = `${i + 1}.`;
    sheet.getCell(row, 1).font = { name: FONT, size: 9, color: { argb: INK_SOFT } };
    sheet.getCell(row, 1).alignment = { horizontal: "right" };
    sheet.mergeCells(row, 2, row, 5);
    const cell = sheet.getCell(row, 2);
    cell.value = text;
    cell.font = { name: FONT, size: 9 };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  r += allTerms.length + 2;

  // ---------------------------------------------------------------- signature
  // CBP's own sign-off, not a generic "Hormat kami". The company name is not
  // repeated here — the letterhead above already carries it, and repeating it
  // under the signature crowds the block CBP asked for.
  sheet.getCell(r, 4).value = SIGN_OFF;
  sheet.getCell(r, 4).font = { name: FONT, size: 9.5, color: { argb: PURPLE } };
  sheet.getCell(r + 4, 4).value = doc.preparedBy ?? "";
  sheet.getCell(r + 4, 4).font = { name: FONT, size: 10, bold: true };

  // Jabatan is optional: printed under the name when set, omitted entirely
  // otherwise rather than leaving a blank line that reads as a missing title.
  let signRow = r + 5;
  if (doc.preparedByTitle) {
    sheet.getCell(signRow, 4).value = doc.preparedByTitle;
    sheet.getCell(signRow, 4).font = { name: FONT, size: 9, color: { argb: INK_SOFT } };
    signRow += 1;
  }

  // ---------------------------------------------------------------- footer
  const footerRow = signRow + 2;
  for (let c = 1; c <= 5; c++) {
    sheet.getCell(footerRow, c).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: c === 5 ? YELLOW : PURPLE },
    };
  }
  sheet.getRow(footerRow).height = 4;
  sheet.mergeCells(footerRow + 1, 1, footerRow + 1, 5);
  const tagline = sheet.getCell(footerRow + 1, 1);
  tagline.value = COMPANY.tagline;
  tagline.font = { name: FONT, size: 9, italic: true, color: { argb: PURPLE } };
  tagline.alignment = { horizontal: "center" };

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
