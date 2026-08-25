import { createHash } from "crypto";
import ExcelJS from "exceljs";
import type { PoolClient } from "pg";
import { Errors } from "@/lib/errors";
import { generateId } from "@/lib/ids";
import { withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { validateFormula } from "@/lib/calc/formulaDsl";
import { TAB_SPECS, REQUIRED_TABS, type TabSpec, type ColumnSpec } from "./importSchema";

const EXCLUDED_OPERATIONAL_TABS = ["Costing_Headers", "Costing_Lines", "Trading_Quotes", "Audit_Events"];

export type ImportGuideParams = {
  fileBuffer: Buffer;
  originalFilename: string;
  versionCode: string;
  uploadedBy: string;
  requestId: string;
};

export type ImportGuideResult = {
  guideVersionId: string;
  importBatchId: string;
  checksum: string;
};

function cellToRecord(header: string[], row: ExcelJS.Row): Record<string, ExcelJS.CellValue> {
  const record: Record<string, ExcelJS.CellValue> = {};
  header.forEach((h, i) => {
    if (!h) return;
    record[h] = row.getCell(i + 1).value;
  });
  return record;
}

async function readTab(workbook: ExcelJS.Workbook, tabName: string): Promise<Record<string, ExcelJS.CellValue>[] | null> {
  const sheet = workbook.getWorksheet(tabName);
  if (!sheet) return null;
  const headerRow = sheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? "").trim();
  });

  const rows: Record<string, ExcelJS.CellValue>[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    if (row.cellCount === 0 || row.values === undefined || (Array.isArray(row.values) && row.values.length <= 1)) continue;
    rows.push(cellToRecord(headers, row));
  }
  return rows;
}

export function coerce(raw: ExcelJS.CellValue, type: "string" | "number" | "boolean"): string | number | boolean | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (type === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isNaN(n) ? null : n;
  }
  if (type === "boolean") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toUpperCase();
    if (s === "TRUE") return true;
    if (s === "FALSE") return false;
    return null;
  }
  return String(raw).trim();
}

/**
 * Parses, validates and stages an .xlsx guide package as a new Draft
 * guide_version. Everything happens in one transaction: any structural,
 * referential, range or formula-DSL problem rolls the whole import back —
 * no candidate master rows are ever partially committed (AT-IMPORT-001).
 */
export async function importGuidePackage(params: ImportGuideParams): Promise<ImportGuideResult> {
  const checksum = createHash("sha256").update(params.fileBuffer).digest("hex");

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(params.fileBuffer as unknown as ExcelJS.Buffer);
  } catch (err) {
    throw Errors.guideSchemaInvalid(err instanceof Error ? err.message : String(err));
  }

  for (const excluded of EXCLUDED_OPERATIONAL_TABS) {
    if (workbook.getWorksheet(excluded)) {
      throw Errors.guideImportRejected(`Package must not contain operational tab: ${excluded}`);
    }
  }

  const manifestRows = await readTab(workbook, "Version_Manifest");
  if (!manifestRows || manifestRows.length !== 1) {
    throw Errors.guideSchemaInvalid("Version_Manifest tab must be present with exactly one row");
  }
  for (const tab of REQUIRED_TABS) {
    if (!workbook.getWorksheet(tab)) {
      throw Errors.guideSchemaInvalid(`Missing required tab: ${tab}`);
    }
  }

  return withTransaction(async (client) => {
    const guideVersionId = generateId("gv");
    const importBatchId = generateId("batch");

    // guide_versions and import_batches reference each other; insert
    // guide_versions first with import_batch_id left null, then backfill it
    // once the batch row (which needs guide_version_id) exists.
    await client.query(
      `INSERT INTO guide_versions (guide_version_id, version_code, status, package_checksum)
       VALUES ($1, $2, 'draft', $3)`,
      [guideVersionId, params.versionCode, checksum],
    );
    await client.query(
      `INSERT INTO import_batches (import_batch_id, guide_version_id, uploaded_by, original_filename, file_checksum)
       VALUES ($1, $2, $3, $4, $5)`,
      [importBatchId, guideVersionId, params.uploadedBy, params.originalFilename, checksum],
    );
    await client.query(
      `UPDATE guide_versions SET import_batch_id = $1 WHERE guide_version_id = $2`,
      [importBatchId, guideVersionId],
    );

    const sourceKeyToId = new Map<string, Map<string, string>>();
    for (const spec of TAB_SPECS) {
      const rows = await readTab(workbook, spec.tabName);
      if (!rows) throw Errors.guideSchemaInvalid(`Missing required tab: ${spec.tabName}`);
      const idMap = await importTab(client, guideVersionId, spec, rows, sourceKeyToId);
      sourceKeyToId.set(spec.tabName, idMap);
    }

    await importAppConfig(client, guideVersionId, await readTab(workbook, "App_Config"));
    await importSimulationCases(client, guideVersionId, await readTab(workbook, "Simulation_Cases"));

    await writeAuditEvent(
      {
        action: "GUIDE_IMPORTED",
        entityType: "guide_versions",
        entityId: guideVersionId,
        actorUserId: params.uploadedBy,
        actorRole: "super_admin",
        requestId: params.requestId,
        afterJson: { versionCode: params.versionCode, checksum, originalFilename: params.originalFilename },
      },
      client,
    );

    return { guideVersionId, importBatchId, checksum };
  });
}

async function importTab(
  client: Pick<PoolClient, "query">,
  guideVersionId: string,
  spec: TabSpec,
  rows: Record<string, ExcelJS.CellValue>[],
  sourceKeyToId: Map<string, Map<string, string>>,
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  const seenBusinessKeys = new Set<string>();

  for (const [rowIndex, row] of rows.entries()) {
    const keyRaw = coerce(row[spec.keyHeader], "string");
    if (!keyRaw || typeof keyRaw !== "string") {
      throw Errors.guideSchemaInvalid(`${spec.tabName} row ${rowIndex + 2}: missing ${spec.keyHeader}`);
    }
    if (idMap.has(keyRaw)) {
      throw Errors.guideDuplicateKey(`${spec.tabName}: duplicate ${spec.keyHeader} "${keyRaw}"`);
    }

    if (spec.uniqueBusinessKey) {
      const businessKey = spec.uniqueBusinessKey.map((h) => coerce(row[h], "string")).join("");
      if (seenBusinessKeys.has(businessKey)) {
        throw Errors.guideDuplicateKey(
          `${spec.tabName}: duplicate ${spec.uniqueBusinessKey.join("+")} combination at row ${rowIndex + 2}`,
        );
      }
      seenBusinessKeys.add(businessKey);
    }

    const newId = generateId(spec.idPrefix);
    const columns: string[] = [spec.idColumn, "guide_version_id", "source_key"];
    const values: unknown[] = [newId, guideVersionId, keyRaw];

    for (const col of spec.columns) {
      const value = resolveColumnValue(spec, col, row, rowIndex, sourceKeyToId);
      if (col.required && (value === null || value === undefined)) {
        throw Errors.guideSchemaInvalid(`${spec.tabName} row ${rowIndex + 2}: missing required ${col.header}`);
      }
      columns.push(col.dbColumn);
      values.push(value);
    }

    const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
    await client.query(
      `INSERT INTO ${spec.table} (${columns.join(", ")}) VALUES (${placeholders})`,
      values,
    );
    idMap.set(keyRaw, newId);
  }

  return idMap;
}

function resolveColumnValue(
  spec: TabSpec,
  col: ColumnSpec,
  row: Record<string, ExcelJS.CellValue>,
  rowIndex: number,
  sourceKeyToId: Map<string, Map<string, string>>,
): unknown {
  if (col.type === "reference") {
    const raw = coerce(row[col.header], "string");
    if (raw === null) {
      if (col.required) throw Errors.guideSchemaInvalid(`${spec.tabName} row ${rowIndex + 2}: missing ${col.header}`);
      return null;
    }
    const refMap = sourceKeyToId.get(col.refTab);
    const resolved = refMap?.get(String(raw));
    if (!resolved) {
      throw Errors.guideReferenceMissing(`${spec.tabName} row ${rowIndex + 2}: ${col.header} "${raw}" not found in ${col.refTab}`);
    }
    return resolved;
  }
  return coerce(row[col.header], col.type);
}

async function importAppConfig(
  client: Pick<PoolClient, "query">,
  guideVersionId: string,
  rows: Record<string, ExcelJS.CellValue>[] | null,
): Promise<void> {
  if (!rows) throw Errors.guideSchemaInvalid("Missing required tab: App_Config");
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const key = coerce(row["config_key"], "string");
    const value = coerce(row["value"], "string");
    const dataType = coerce(row["data_type"], "string");
    if (!key || value === null || !dataType) {
      throw Errors.guideSchemaInvalid(`App_Config row ${i + 2}: config_key, value and data_type are required`);
    }
    if (seen.has(String(key))) throw Errors.guideDuplicateKey(`App_Config: duplicate config_key "${key}"`);
    seen.add(String(key));

    await client.query(
      `INSERT INTO app_config (config_id, guide_version_id, config_key, config_value, data_type, unit, editable_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'active'))`,
      [
        generateId("cfg"),
        guideVersionId,
        key,
        value,
        dataType,
        coerce(row["unit"], "string"),
        coerce(row["editable_by"], "string"),
        coerce(row["status"], "string"),
      ],
    );
  }
}

async function importSimulationCases(
  client: Pick<PoolClient, "query">,
  guideVersionId: string,
  rows: Record<string, ExcelJS.CellValue>[] | null,
): Promise<void> {
  if (!rows) throw Errors.guideSchemaInvalid("Missing required tab: Simulation_Cases");
  const seen = new Set<string>();
  for (const [i, row] of rows.entries()) {
    const id = coerce(row["simulation_id"], "string");
    const route = coerce(row["route"], "string");
    const inputJsonRaw = coerce(row["input_json"], "string");
    const expectedJsonRaw = coerce(row["expected_json"], "string");
    if (!id || !route || !inputJsonRaw || !expectedJsonRaw) {
      throw Errors.guideSchemaInvalid(
        `Simulation_Cases row ${i + 2}: simulation_id, route, input_json and expected_json are required`,
      );
    }
    if (seen.has(String(id))) throw Errors.guideDuplicateKey(`Simulation_Cases: duplicate simulation_id "${id}"`);
    seen.add(String(id));

    let inputJson: unknown;
    let expectedJson: unknown;
    try {
      inputJson = JSON.parse(String(inputJsonRaw));
      expectedJson = JSON.parse(String(expectedJsonRaw));
    } catch (err) {
      throw Errors.guideSchemaInvalid(
        `Simulation_Cases row ${i + 2}: input_json/expected_json must be valid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    await client.query(
      `INSERT INTO simulation_cases (simulation_id, guide_version_id, source_key, route, product_family, input_json, expected_json, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        generateId("sim"),
        guideVersionId,
        id,
        route,
        coerce(row["product_family"], "string"),
        JSON.stringify(inputJson),
        JSON.stringify(expectedJson),
        coerce(row["notes"], "string"),
      ],
    );
  }
}

/** Re-parses formula/range data already staged for a Draft version and validates it (VAL-025/VAL-028). Kept separate from import so "validate" is its own explicit action per 07_MASTER_VERSIONING. */
export function validateFormulaRow(expression: string, requiredInputsCsv: string): void {
  const inputs = requiredInputsCsv.split(",").map((s) => s.trim());
  const check = validateFormula(expression, inputs);
  if (!check.valid) throw Errors.guideFormulaInvalid(check.error);
}
