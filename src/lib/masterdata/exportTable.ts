import ExcelJS from "exceljs";
import { Errors } from "@/lib/errors";
import { TAB_SPECS } from "@/lib/guide/importSchema";
import { listActiveRows } from "./browse";

/**
 * Exports one master table's active rows to a single-sheet .xlsx, in exactly
 * the shape parseAndStageBulkImport (the Bulk import button) reads back --
 * `spec.keyHeader` then one column per `spec.columns`, sheet named
 * `spec.tabName`. That symmetry is the point: Export, edit in Excel, Bulk
 * import round-trips with no extra translation step, so changing many prices
 * at once doesn't mean editing rows one at a time in the browser.
 *
 * Reference columns are written as the referenced row's source_key rather
 * than its internal id (which regenerates every guide version) -- the same
 * convention scripts/export-guide.ts and the pending-change patch format
 * already use, and what the importer expects back.
 */
export async function exportTableXlsx(tableName: string): Promise<Buffer> {
  const spec = TAB_SPECS.find((s) => s.table === tableName);
  if (!spec) throw Errors.validation(`Tabel master data tidak dikenal: ${tableName}`);

  const { rows } = await listActiveRows(tableName);

  const refSourceKeyByTable = new Map<string, Map<string, string>>();
  for (const col of spec.columns) {
    if (col.type !== "reference") continue;
    const refSpec = TAB_SPECS.find((s) => s.tabName === col.refTab);
    if (!refSpec || refSourceKeyByTable.has(refSpec.table)) continue;
    const { rows: refRows } = await listActiveRows(refSpec.table);
    refSourceKeyByTable.set(
      refSpec.table,
      new Map(refRows.map((r) => [r[refSpec.idColumn] as string, r.source_key as string])),
    );
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "CBP Costing App";
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(spec.tabName);
  sheet.addRow([spec.keyHeader, ...spec.columns.map((c) => c.header)]);
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((c) => {
    c.width = 20;
  });

  for (const row of rows) {
    const values: unknown[] = [row.source_key];
    for (const col of spec.columns) {
      const raw = row[col.dbColumn];
      if (col.type === "reference") {
        const refSpec = TAB_SPECS.find((s) => s.tabName === col.refTab)!;
        values.push(raw === null || raw === undefined ? null : (refSourceKeyByTable.get(refSpec.table)?.get(String(raw)) ?? null));
      } else if (col.type === "number") {
        values.push(raw === null || raw === undefined ? null : Number(raw));
      } else {
        values.push(raw ?? null);
      }
    }
    sheet.addRow(values);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
