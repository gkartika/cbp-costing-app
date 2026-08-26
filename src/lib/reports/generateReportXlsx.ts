import ExcelJS from "exceljs";
import type { ReportFilters, ReportResult } from "./buildReport";

const JAKARTA_DATE = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const MONEY = "#,##0";

function headerRow(sheet: ExcelJS.Worksheet, rowNumber: number) {
  const row = sheet.getRow(rowNumber);
  row.font = { bold: true };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF2" } };
}

/**
 * Two sheets from one filtered result: a Summary (one row per quotation, for
 * win-rate and value tracking) and Line Detail (one row per item, for seeing
 * what is actually being quoted). Both come from the same query scope, so the
 * sheets can never describe different sets of costings.
 */
export async function generateReportXlsx(result: ReportResult, filters: ReportFilters): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CBP Costing App";
  wb.created = new Date();

  // --- Summary ---
  const summary = wb.addWorksheet("Summary");
  summary.mergeCells("A1:H1");
  summary.getCell("A1").value = "CBP — Laporan Quotation";
  summary.getCell("A1").font = { bold: true, size: 14 };

  const filterBits = [
    filters.customer?.trim() ? `Customer: ${filters.customer.trim()}` : "Customer: semua",
    filters.salesperson?.trim() ? `Salesperson: ${filters.salesperson.trim()}` : "Salesperson: semua",
    filters.dateFrom || filters.dateTo
      ? `Periode: ${filters.dateFrom || "awal"} s/d ${filters.dateTo || "sekarang"}`
      : "Periode: semua",
    filters.statuses?.length ? `Status: ${filters.statuses.join(", ")}` : "Status: semua",
    filters.poFilter === "po" ? "Hanya PO" : filters.poFilter === "no_po" ? "Hanya belum PO" : "PO: semua",
  ];
  summary.mergeCells("A2:H2");
  summary.getCell("A2").value = filterBits.join("  ·  ");
  summary.getCell("A2").font = { italic: true, size: 10 };

  summary.getRow(4).values = [
    "Tanggal",
    "Customer",
    "Quotation No",
    "Status",
    "Salesperson",
    "Total Quotation",
    "PO",
    "No. PO",
  ];
  headerRow(summary, 4);

  result.summary.forEach((s, i) => {
    summary.getRow(5 + i).values = [
      JAKARTA_DATE.format(new Date(s.createdAt)),
      s.customerName,
      s.quotationNo ?? "—",
      s.status,
      s.salesperson,
      s.totalNominal ?? 0,
      s.isPo ? "Ya" : "Tidak",
      s.poNumber ?? "",
    ];
  });

  const totalsRow = 5 + result.summary.length + 1;
  summary.getRow(totalsRow).values = [
    "TOTAL",
    `${result.totals.costingCount} quotation`,
    "",
    "",
    "",
    result.totals.grandTotal,
    `${result.totals.poCount} PO`,
    "",
  ];
  summary.getRow(totalsRow).font = { bold: true };
  summary.getRow(totalsRow + 1).values = ["Nilai PO", "", "", "", "", result.totals.poTotal, "", ""];
  summary.getRow(totalsRow + 1).font = { bold: true };

  summary.columns = [
    { width: 12 },
    { width: 30 },
    { width: 20 },
    { width: 12 },
    { width: 20 },
    { width: 18, style: { numFmt: MONEY } },
    { width: 8 },
    { width: 22 },
  ];

  // --- Line Detail ---
  const detail = wb.addWorksheet("Line Detail");
  detail.getRow(1).values = [
    "Quotation No",
    "Customer",
    "#",
    "Deskripsi",
    "Product Family",
    "Grade",
    "Size",
    "Qty",
    "Harga Satuan",
    "Total",
  ];
  headerRow(detail, 1);

  result.lines.forEach((l, i) => {
    detail.getRow(2 + i).values = [
      l.quotationNo ?? "—",
      l.customerName,
      l.lineNo,
      l.description ?? "",
      l.productFamily ?? "",
      l.gradeInput ?? "",
      l.sizeLabel ?? "",
      l.qty ?? 0,
      l.unitSellingPrice ?? 0,
      l.orderTotal ?? 0,
    ];
  });

  detail.columns = [
    { width: 20 },
    { width: 28 },
    { width: 5 },
    { width: 34 },
    { width: 16 },
    { width: 12 },
    { width: 10 },
    { width: 10 },
    { width: 16, style: { numFmt: MONEY } },
    { width: 18, style: { numFmt: MONEY } },
  ];

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
