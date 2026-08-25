import ExcelJS from "exceljs";
import type { QuotationDocument } from "@/lib/costings/quotationDocument";

/**
 * DEC-015/DEC-016: screenshot-ready XLSX, excluding PPN. DEC-016 (CBP's real
 * logo/address/terms/signature) is still open, so every brand-specific block
 * is a clearly labeled placeholder — swapping in real assets later means
 * replacing these cell values/images, not touching the layout or the
 * calculation-to-document pipeline.
 */
export async function generateQuotationXlsx(doc: QuotationDocument): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CBP Costing App";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Quotation", {
    pageSetup: { paperSize: 9, orientation: "portrait", fitToPage: true },
  });

  sheet.columns = [
    { width: 6 }, // No
    { width: 40 }, // Description
    { width: 10 }, // Qty
    { width: 18 }, // Unit price
    { width: 18 }, // Total
  ];

  // --- Letterhead placeholder block (DEC-016 open) ---
  sheet.mergeCells("A1:B3");
  sheet.getCell("A1").value = "[CBP LOGO]";
  sheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };
  sheet.getCell("A1").font = { italic: true, color: { argb: "FF999999" } };
  sheet.getCell("A1").border = { top: { style: "thin" }, left: { style: "thin" }, bottom: { style: "thin" }, right: { style: "thin" } };

  sheet.mergeCells("C1:E1");
  sheet.getCell("C1").value = "[Company name — CBP to provide]";
  sheet.mergeCells("C2:E2");
  sheet.getCell("C2").value = "[Company address — CBP to provide]";
  sheet.mergeCells("C3:E3");
  sheet.getCell("C3").value = "[Phone / email — CBP to provide]";
  for (const cellRef of ["C1", "C2", "C3"]) {
    sheet.getCell(cellRef).font = { italic: true, color: { argb: "FF999999" }, size: cellRef === "C1" ? 14 : 10 };
  }

  sheet.addRow([]);

  // --- Quotation header ---
  const headerRow = sheet.addRow(["QUOTATION", "", "", "No.", doc.quotationNo ?? "(Draft)"]);
  headerRow.getCell(1).font = { bold: true, size: 16 };

  sheet.addRow(["", "", "", "Customer", doc.customerName]);
  sheet.addRow(["", "", "", "Validity", `${doc.validityDays} days`]);
  if (doc.finalizedAt) {
    sheet.addRow(["", "", "", "Finalized", doc.finalizedAt.toISOString().slice(0, 10)]);
  }
  if (doc.revisionNo > 0) {
    sheet.addRow(["", "", "", "Revision", doc.revisionNo]);
  }
  sheet.addRow([]);

  // --- Line items ---
  const tableHeaderRow = sheet.addRow(["No", "Description", "Qty", "Unit Price", "Total"]);
  tableHeaderRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.border = { bottom: { style: "thin" } };
  });

  for (const line of doc.lines) {
    const row = sheet.addRow([line.lineNo, line.description ?? "", line.qty, line.unitSellingPrice, line.orderTotal]);
    row.getCell(4).numFmt = "#,##0";
    row.getCell(5).numFmt = "#,##0";
  }

  sheet.addRow([]);
  const totalRow = sheet.addRow(["", "", "", `Total (excl. ${doc.taxOutputMode === "EXCLUDE_PPN" ? "PPN" : "tax"})`, doc.totalExPpn]);
  totalRow.getCell(4).font = { bold: true };
  totalRow.getCell(5).font = { bold: true };
  totalRow.getCell(5).numFmt = "#,##0";

  sheet.addRow([]);
  sheet.addRow([]);

  // --- Terms placeholder ---
  const termsRow = sheet.addRow(["[Terms & conditions — CBP to provide]"]);
  termsRow.getCell(1).font = { italic: true, color: { argb: "FF999999" }, size: 10 };
  sheet.mergeCells(`A${termsRow.number}:E${termsRow.number}`);

  sheet.addRow([]);
  sheet.addRow([]);

  // --- Signature placeholder ---
  const sigLabelRow = sheet.addRow(["", "", "", "[Authorized signature — CBP to provide]"]);
  sigLabelRow.getCell(4).font = { italic: true, color: { argb: "FF999999" }, size: 10 };

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
