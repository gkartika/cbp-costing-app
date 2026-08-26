/**
 * Exports a published guide version back into the 14-tab XLSX package format.
 *
 * This is the promotion path from one environment to another: export from the
 * environment where the rate cards were built, import into production through
 * importGuidePackage, and the package goes through the same schema checks,
 * range checks, raw-bar checks and golden simulation cases as any other
 * upload. Copying rows between databases directly would move the same data
 * while skipping every one of those gates — and a guide version that has not
 * passed validation is exactly what the versioning design exists to prevent.
 *
 * Reference columns are written back as the referenced row's source_key, not
 * its internal id, because ids are regenerated per guide version; source_key
 * is the stable business key the importer resolves against.
 *
 * Only active rows are exported. Editing master data deactivates the old row
 * and inserts a replacement, so a long-lived guide version accumulates
 * tombstones that share a business key with the row that superseded them —
 * and the importer's uniqueness check counts every row in a sheet, active or
 * not, so shipping both would make the package unimportable. The tombstone
 * also carries nothing the target environment needs: it records that *this*
 * environment once changed its mind, and the reason lives in audit_events
 * here, not in the package.
 *
 * Usage:
 *   npm run export:guide -- [outputPath] [--version=<guide_version_id>]
 */
import { writeFileSync } from "fs";
import ExcelJS from "exceljs";
import { pool } from "../src/lib/db";
import { TAB_SPECS } from "../src/lib/guide/importSchema";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function resolveVersion(): Promise<{ id: string; code: string }> {
  const explicit = arg("version");
  const { rows } = explicit
    ? await pool.query<{ guide_version_id: string; version_code: string }>(
        `SELECT guide_version_id, version_code FROM guide_versions WHERE guide_version_id = $1`,
        [explicit],
      )
    : await pool.query<{ guide_version_id: string; version_code: string }>(
        `SELECT guide_version_id, version_code FROM guide_versions WHERE status = 'published' LIMIT 1`,
      );
  if (rows.length === 0) throw new Error(explicit ? `Guide version ${explicit} not found` : "No published guide version");
  return { id: rows[0].guide_version_id, code: rows[0].version_code };
}

async function main() {
  const outPath = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "guide-package-export.xlsx";
  const version = await resolveVersion();
  console.log(`Exporting ${version.code} (${version.id})`);

  const wb = new ExcelJS.Workbook();
  wb.creator = "CBP Costing App";
  wb.created = new Date();

  // The importer requires this tab and reads exactly one row from it.
  const manifest = wb.addWorksheet("Version_Manifest");
  manifest.addRow(["version_code", "schema_version"]);
  manifest.addRow([`${version.code}-export-${new Date().toISOString().slice(0, 10)}`, "1"]);

  // source_key lookups per referenced table, so a reference column can be
  // written as the business key rather than the regenerated row id.
  const sourceKeyById = new Map<string, Map<string, string>>();
  const tabNameToTable = new Map(TAB_SPECS.map((s) => [s.tabName, s.table]));

  for (const spec of TAB_SPECS) {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} WHERE guide_version_id = $1 AND active ORDER BY source_key`,
      [version.id],
    );
    const byId = new Map<string, string>();
    for (const r of rows) byId.set(r[spec.idColumn] as string, r.source_key as string);
    sourceKeyById.set(spec.table, byId);
  }

  let totalRows = 0;
  for (const spec of TAB_SPECS) {
    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} WHERE guide_version_id = $1 AND active ORDER BY source_key`,
      [version.id],
    );

    const sheet = wb.addWorksheet(spec.tabName);
    sheet.addRow([spec.keyHeader, ...spec.columns.map((c) => c.header)]);

    for (const row of rows) {
      const values: unknown[] = [row.source_key];
      for (const col of spec.columns) {
        const raw = row[col.dbColumn];
        if (col.type === "reference") {
          const refTable = tabNameToTable.get(col.refTab);
          const refKey = raw === null || raw === undefined ? null : (sourceKeyById.get(refTable ?? "")?.get(String(raw)) ?? null);
          values.push(refKey);
        } else if (col.type === "number") {
          values.push(raw === null || raw === undefined ? null : Number(raw));
        } else {
          values.push(raw ?? null);
        }
      }
      sheet.addRow(values);
    }
    totalRows += rows.length;
    console.log(`  ${spec.tabName.padEnd(24)} ${rows.length}`);
  }

  // App_Config and Simulation_Cases are not in TAB_SPECS (config is key/value,
  // simulation cases carry JSONB blobs), but the importer expects both.
  const config = wb.addWorksheet("App_Config");
  config.addRow(["config_key", "value", "data_type", "unit", "editable_by", "status"]);
  const { rows: configRows } = await pool.query<Record<string, unknown>>(
    `SELECT config_key, config_value, data_type, unit, editable_by, status FROM app_config WHERE guide_version_id = $1 ORDER BY config_key`,
    [version.id],
  );
  for (const r of configRows) {
    config.addRow([r.config_key, r.config_value, r.data_type, r.unit ?? null, r.editable_by ?? null, r.status]);
  }
  console.log(`  App_Config               ${configRows.length}`);

  const sims = wb.addWorksheet("Simulation_Cases");
  sims.addRow(["simulation_id", "route", "product_family", "input_json", "expected_json", "notes", "active"]);
  const { rows: simRows } = await pool.query<Record<string, unknown>>(
    `SELECT source_key, route, product_family, input_json, expected_json, notes, active
     FROM simulation_cases WHERE guide_version_id = $1 ORDER BY source_key`,
    [version.id],
  );
  for (const r of simRows) {
    sims.addRow([
      r.source_key,
      r.route,
      r.product_family ?? null,
      JSON.stringify(r.input_json),
      JSON.stringify(r.expected_json),
      r.notes ?? null,
      r.active,
    ]);
  }
  console.log(`  Simulation_Cases         ${simRows.length}`);

  const buffer = await wb.xlsx.writeBuffer();
  writeFileSync(outPath, Buffer.from(buffer));
  console.log(`\nWrote ${outPath} — ${totalRows + configRows.length + simRows.length} rows across ${wb.worksheets.length} tabs.`);
  console.log("Import it on the target environment via Guide Admin, which re-runs full validation.");

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
