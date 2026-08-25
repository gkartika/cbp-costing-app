import ExcelJS from "exceljs";
import { Errors } from "@/lib/errors";
import { coerce } from "@/lib/guide/importGuide";
import { TAB_SPECS } from "@/lib/guide/importSchema";
import { listActiveRows } from "./browse";
import { stagePendingChange } from "./pendingChanges";

export type BulkImportResult = {
  staged: number;
  skipped: { row: number; reason: string }[];
};

/**
 * Bulk-stages pending changes for ONE master table from a single-sheet
 * .xlsx — "import a new pricelist" without touching the other 13 tables.
 * Each row becomes a create (unknown source_key) or update (existing
 * source_key) pending change, exactly as if it had been entered by hand;
 * nothing is published until the admin reviews and clicks Publish.
 */
export async function parseAndStageBulkImport(params: {
  tableName: string;
  fileBuffer: Buffer;
  actorUserId: string;
  actorRole: string;
  requestId: string;
}): Promise<BulkImportResult> {
  const spec = TAB_SPECS.find((s) => s.table === params.tableName);
  if (!spec) throw Errors.validation(`Tabel master data tidak dikenal: ${params.tableName}`);

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(params.fileBuffer as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw Errors.guideSchemaInvalid(err instanceof Error ? err.message : String(err));
  }
  const sheet = workbook.getWorksheet(spec.tabName) ?? workbook.worksheets[0];
  if (!sheet) throw Errors.guideSchemaInvalid("File tidak berisi sheet apapun.");

  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? "").trim();
  });

  const { rows: activeRows } = await listActiveRows(params.tableName);
  const activeSourceKeys = new Set(activeRows.map((r) => r.source_key as string));

  let staged = 0;
  const skipped: { row: number; reason: string }[] = [];

  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0 || row.values === undefined || (Array.isArray(row.values) && row.values.length <= 1)) continue;

    const record: Record<string, ExcelJS.CellValue> = {};
    headers.forEach((h, i) => {
      if (h) record[h] = row.getCell(i + 1).value;
    });

    const sourceKey = coerce(record[spec.keyHeader], "string");
    if (!sourceKey || typeof sourceKey !== "string") {
      skipped.push({ row: r, reason: `Missing ${spec.keyHeader}` });
      continue;
    }

    const fields: Record<string, unknown> = {};
    let rowError: string | null = null;
    for (const col of spec.columns) {
      // Reference columns hold the referenced table's source_key (a plain
      // string in the sheet), resolved to a real row id only at publish
      // time — same convention the pending-change patch format already uses.
      const value = col.type === "reference" ? coerce(record[col.header], "string") : coerce(record[col.header], col.type);
      if (col.required && (value === null || value === undefined)) {
        rowError = `Missing required column "${col.header}"`;
        break;
      }
      if (value !== null) fields[col.dbColumn] = value;
    }
    if (rowError) {
      skipped.push({ row: r, reason: rowError });
      continue;
    }

    await stagePendingChange({
      tableName: params.tableName,
      operation: activeSourceKeys.has(sourceKey) ? "update" : "create",
      sourceKey,
      fields,
      reason: `Bulk import (row ${r})`,
      actorUserId: params.actorUserId,
      actorRole: params.actorRole,
      requestId: params.requestId,
    });
    staged++;
  }

  return { staged, skipped };
}
