import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { bulkImportCustomers, CUSTOMER_SEGMENTS, type CustomerSegment } from "@/lib/costings/customers";
import { Errors } from "@/lib/errors";

const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;
const COLUMNS = ["customerName", "customerCode", "segment", "markupPercent", "paymentTerms"] as const;

function cell(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value) return String((value as { text: unknown }).text ?? "").trim();
  return String(value).trim();
}

/**
 * Same matching-by-customerName semantics as the paste-CSV Bulk Import, just
 * sourced from an uploaded .xlsx instead of pasted text -- the counterpart to
 * export-xlsx, so "Export, edit in Excel, re-import" works for large
 * customer lists without pasting hundreds of rows into a textarea.
 */
export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  policy.assertCanEditCustomer(user);
  const requestId = getRequestId(req);

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) throw Errors.validation("File .xlsx wajib diisi.");
  if (!file.name.toLowerCase().endsWith(".xlsx")) throw Errors.guideSchemaInvalid("File harus berformat .xlsx");
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw Errors.validation(`File terlalu besar (maksimum ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MB).`);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(await file.arrayBuffer()) as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw Errors.guideSchemaInvalid(err instanceof Error ? err.message : String(err));
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw Errors.guideSchemaInvalid("File tidak berisi sheet apapun.");

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (c, colNumber) => {
    headers[colNumber - 1] = cell(c.value).toLowerCase();
  });

  const skipped: { row: number; reason: string }[] = [];
  const validRows: { rowNo: number; customerName: string; customerCode?: string; segment?: CustomerSegment; markupPercent?: number; paymentTerms?: string }[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0 || row.values === undefined || (Array.isArray(row.values) && row.values.length <= 1)) continue;

    const record: Record<string, string> = {};
    COLUMNS.forEach((col) => {
      const idx = headers.indexOf(col.toLowerCase());
      record[col] = idx >= 0 ? cell(row.getCell(idx + 1).value) : "";
    });

    const customerName = record.customerName;
    if (!customerName) {
      skipped.push({ row: r, reason: "Nama customer wajib diisi." });
      continue;
    }
    if (record.segment && !CUSTOMER_SEGMENTS.includes(record.segment as CustomerSegment)) {
      skipped.push({ row: r, reason: `Segmen tidak dikenal: "${record.segment}".` });
      continue;
    }
    let markupPercent: number | undefined;
    if (record.markupPercent) {
      const raw = Number(record.markupPercent);
      if (Number.isNaN(raw) || raw <= -100) {
        skipped.push({ row: r, reason: "Kenaikan harga tidak valid." });
        continue;
      }
      markupPercent = raw / 100;
    }

    validRows.push({
      rowNo: r,
      customerName,
      customerCode: record.customerCode || undefined,
      segment: (record.segment as CustomerSegment) || undefined,
      markupPercent,
      paymentTerms: record.paymentTerms || undefined,
    });
  }

  if (validRows.length === 0 && skipped.length === 0) {
    throw Errors.validation("Tidak ada baris data untuk diimpor.");
  }

  const results =
    validRows.length > 0
      ? await bulkImportCustomers(
          validRows.map(({ rowNo: _rowNo, ...row }) => row),
          { actorUserId: user.userId, actorRole: primaryAuditRole(user), requestId },
        )
      : [];

  return NextResponse.json({
    results: results.map((res, i) => ({ ...res, row: validRows[i].rowNo })),
    skipped,
    summary: {
      created: results.filter((r) => r.outcome === "created").length,
      updated: results.filter((r) => r.outcome === "updated").length,
      errors: results.filter((r) => r.outcome === "error").length + skipped.length,
    },
  });
});
