/**
 * Splits the single shared "Washer" material_size_guides profile into one
 * profile per grade/standard, and repoints grade_profile_rules accordingly.
 *
 * Until now A36, F35, F436 and F844 all shared one product_profile
 * ("Washer"), keyed by (product_profile, size_label) — so all four grades
 * saw the same 35-size dropdown regardless of which standard actually
 * defines geometry at that size, and A36/F35 (Custom Production) had no way
 * to carry different OD/thickness at the same nominal size even though DIN
 * 125 (A36) and JIS B1186 (F35) genuinely disagree on them.
 *
 * Nothing in the calc engine matches on the literal string "Washer" —
 * product_profile is just an opaque lookup key from grade_profile_rules
 * (confirmed by grep, 2026-09-17) — so this is a pure data change, no
 * schema/migration needed.
 *
 * New profiles, real geometry sourced 2026-09-17 (see chat for citations):
 *   - "Washer-A36"  : DIN 125 Form A, M20-M64 (unchanged from the original
 *                      fill-washer-dimensions.ts data — A36 stays on DIN 125
 *                      per business confirmation).
 *   - "Washer-F35"  : JIS B1186 F10T-set technical sheet, "Plain Washers"
 *                      table, M12-M30 — the standard doesn't formally cover
 *                      sizes beyond M30, so F35 loses the M33-M64 sizes it
 *                      never had real geometry for anyway.
 *   - "Washer-F436" : ASTM F436/F436M Type 1, basic dims = midpoint of the
 *                      published min-max range, 17 imperial sizes 0.5"-3".
 *                      The 13 metric trading sizes (M14-M72) are included
 *                      too, with washer_od/washer_thickness left NULL — no
 *                      metric-native F436M dimension source was found, and
 *                      Trading (F436's required route) never reads these
 *                      columns anyway (tradingPipeline.ts resolves size/
 *                      price straight from trading_items), so this only
 *                      matters if Custom Production is ever enabled for
 *                      F436, at which point it should fail loud rather than
 *                      use a guessed value.
 *   - "Washer-F844" : ASTM F844 / ASME B18.21.1 (USS series), 17 imperial
 *                      sizes 0.5"-3" — matches trading_items exactly, F844
 *                      has no metric Trading data.
 *
 * The old shared "Washer" profile's 35 rows are deactivated once nothing
 * maps to them any more, so Master Data doesn't show orphaned data.
 *
 * Usage: npm run split:washer-profiles
 */
import { pool } from "../src/lib/db";
import { stagePendingChange, publishPendingChangesForTable } from "../src/lib/masterdata/pendingChanges";

type Row = { size: string; diameterMm: number; od: number | null; thickness: number | null };

const IN = (inches: number) => Math.round(inches * 25.4 * 100) / 100;

const A36_DIN125: Row[] = [
  { size: "M20", diameterMm: 20, od: 37, thickness: 3 },
  { size: "M22", diameterMm: 22, od: 39, thickness: 3 },
  { size: "M24", diameterMm: 24, od: 44, thickness: 4 },
  { size: "M27", diameterMm: 27, od: 50, thickness: 4 },
  { size: "M30", diameterMm: 30, od: 56, thickness: 4 },
  { size: "M33", diameterMm: 33, od: 60, thickness: 5 },
  { size: "M36", diameterMm: 36, od: 66, thickness: 5 },
  { size: "M39", diameterMm: 39, od: 72, thickness: 6 },
  { size: "M42", diameterMm: 42, od: 78, thickness: 7 },
  { size: "M45", diameterMm: 45, od: 85, thickness: 7 },
  { size: "M48", diameterMm: 48, od: 92, thickness: 8 },
  { size: "M52", diameterMm: 52, od: 98, thickness: 8 },
  { size: "M56", diameterMm: 56, od: 105, thickness: 9 },
  { size: "M60", diameterMm: 60, od: 110, thickness: 9 },
  { size: "M64", diameterMm: 64, od: 115, thickness: 9 },
];

const F35_JIS_B1186: Row[] = [
  { size: "M12", diameterMm: 12, od: 26, thickness: 3.2 },
  { size: "M16", diameterMm: 16, od: 32, thickness: 4.5 },
  { size: "M20", diameterMm: 20, od: 40, thickness: 4.5 },
  { size: "M22", diameterMm: 22, od: 44, thickness: 6.0 },
  { size: "M24", diameterMm: 24, od: 48, thickness: 6.0 },
  { size: "M27", diameterMm: 27, od: 56, thickness: 6.0 },
  { size: "M30", diameterMm: 30, od: 60, thickness: 8.0 },
];

const F436_IMPERIAL: Row[] = [
  { size: "0.5", diameterMm: IN(0.5), od: 27.0, thickness: 3.48 },
  { size: "0.625", diameterMm: IN(0.625), od: 33.35, thickness: 3.81 },
  { size: "0.75", diameterMm: IN(0.75), od: 37.29, thickness: 3.81 },
  { size: "0.875", diameterMm: IN(0.875), od: 44.45, thickness: 3.99 },
  { size: "1", diameterMm: IN(1), od: 50.8, thickness: 3.99 },
  { size: "1.125", diameterMm: IN(1.125), od: 57.15, thickness: 3.99 },
  { size: "1.25", diameterMm: IN(1.25), od: 63.5, thickness: 3.99 },
  { size: "1.375", diameterMm: IN(1.375), od: 69.85, thickness: 3.99 },
  { size: "1.5", diameterMm: IN(1.5), od: 76.2, thickness: 3.99 },
  { size: "1.625", diameterMm: IN(1.625), od: 82.55, thickness: 5.82 },
  { size: "1.75", diameterMm: IN(1.75), od: 85.73, thickness: 5.82 },
  { size: "1.875", diameterMm: IN(1.875), od: 88.9, thickness: 5.82 },
  { size: "2", diameterMm: IN(2), od: 95.25, thickness: 5.82 },
  { size: "2.25", diameterMm: IN(2.25), od: 101.6, thickness: 7.37 },
  { size: "2.5", diameterMm: IN(2.5), od: 114.3, thickness: 7.37 },
  { size: "2.75", diameterMm: IN(2.75), od: 127.0, thickness: 7.37 },
  { size: "3", diameterMm: IN(3), od: 139.7, thickness: 7.37 },
];

const F436_METRIC_NO_GEOMETRY: Row[] = [
  "M14", "M16", "M20", "M22", "M24", "M27", "M30", "M36", "M42", "M48", "M56", "M64", "M72",
].map((size) => ({ size, diameterMm: Number(size.slice(1)), od: null, thickness: null }));

const F844_IMPERIAL: Row[] = [
  { size: "0.5", diameterMm: IN(0.5), od: 34.93, thickness: 3.35 },
  { size: "0.625", diameterMm: IN(0.625), od: 44.45, thickness: 4.06 },
  { size: "0.75", diameterMm: IN(0.75), od: 50.8, thickness: 4.5 },
  { size: "0.875", diameterMm: IN(0.875), od: 57.15, thickness: 4.88 },
  { size: "1", diameterMm: IN(1), od: 63.5, thickness: 4.88 },
  { size: "1.125", diameterMm: IN(1.125), od: 69.85, thickness: 4.88 },
  { size: "1.25", diameterMm: IN(1.25), od: 76.2, thickness: 4.88 },
  { size: "1.375", diameterMm: IN(1.375), od: 82.55, thickness: 5.41 },
  { size: "1.5", diameterMm: IN(1.5), od: 88.9, thickness: 5.41 },
  { size: "1.625", diameterMm: IN(1.625), od: 95.25, thickness: 5.41 },
  { size: "1.75", diameterMm: IN(1.75), od: 101.6, thickness: 5.41 },
  { size: "1.875", diameterMm: IN(1.875), od: 107.95, thickness: 5.41 },
  { size: "2", diameterMm: IN(2), od: 114.3, thickness: 5.41 },
  { size: "2.25", diameterMm: IN(2.25), od: 120.65, thickness: 6.3 },
  { size: "2.5", diameterMm: IN(2.5), od: 127.0, thickness: 7.11 },
  { size: "2.75", diameterMm: IN(2.75), od: 133.35, thickness: 7.87 },
  { size: "3", diameterMm: IN(3), od: 139.7, thickness: 8.31 },
];

const PROFILES: {
  profile: string;
  grade: string;
  standardGroup: string;
  unitSystem: "Metric" | "Imperial" | "Mixed";
  rows: Row[];
}[] = [
  { profile: "Washer-A36", grade: "A36", standardGroup: "DIN 125", unitSystem: "Metric", rows: A36_DIN125 },
  { profile: "Washer-F35", grade: "F35", standardGroup: "JIS B1186 F35", unitSystem: "Metric", rows: F35_JIS_B1186 },
  {
    profile: "Washer-F436",
    grade: "F436",
    standardGroup: "ASTM F436 / F436M",
    unitSystem: "Mixed",
    rows: [...F436_IMPERIAL, ...F436_METRIC_NO_GEOMETRY],
  },
  { profile: "Washer-F844", grade: "F844", standardGroup: "ASTM F844", unitSystem: "Imperial", rows: F844_IMPERIAL },
];

async function resolveActorUserId(): Promise<string> {
  const { rows } = await pool.query<{ user_id: string }>(
    `SELECT u.user_id FROM users u
     JOIN user_roles ur ON ur.user_id = u.user_id AND ur.valid_to IS NULL
     JOIN roles r ON r.role_id = ur.role_id
     WHERE r.role_name = 'super_admin' AND u.active
     ORDER BY u.created_at LIMIT 1`,
  );
  if (rows.length === 0) throw new Error("No active super_admin user found to attribute this change to.");
  return rows[0].user_id;
}

async function main() {
  const { rows: gvRows } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  if (gvRows.length === 0) throw new Error("No published guide version.");
  const guideVersionId = gvRows[0].guide_version_id;
  const actorUserId = await resolveActorUserId();

  // --- 1. Create the four new per-grade profiles in material_size_guides ---
  console.log("Staging new per-grade Washer profiles...\n");
  for (const { profile, standardGroup, unitSystem, rows } of PROFILES) {
    for (const row of rows) {
      const rowUnitSystem = row.size.startsWith("M") ? "Metric" : "Imperial";
      console.log(
        `  ${profile.padEnd(14)} ${row.size.padEnd(6)} diameter ${row.diameterMm}mm` +
          (row.od !== null ? `  OD ${row.od}mm  t ${row.thickness}mm` : "  (no geometry)"),
      );
      await stagePendingChange({
        tableName: "material_size_guides",
        operation: "create",
        sourceKey: `SIZE-${profile.toUpperCase()}-${row.size}`,
        fields: {
          unit_system: unitSystem === "Mixed" ? rowUnitSystem : unitSystem,
          standard_group: standardGroup,
          product_profile: profile,
          size_label: row.size,
          diameter_mm: row.diameterMm,
          ...(row.od !== null ? { washer_od: row.od } : {}),
          ...(row.thickness !== null ? { washer_thickness: row.thickness } : {}),
        },
        reason: `Washer profile split by grade/standard (2026-09-17) — ${profile} carries ${standardGroup} geometry.`,
        actorUserId,
        actorRole: "super_admin",
        requestId: `script-split-washer-profiles-${Date.now()}`,
      });
    }
  }

  // --- 2. Deactivate the old shared "Washer" profile rows ---
  const { rows: oldRows } = await pool.query<{ source_key: string }>(
    `SELECT source_key FROM material_size_guides WHERE guide_version_id = $1 AND active AND product_profile = 'Washer'`,
    [guideVersionId],
  );
  console.log(`\nDeactivating ${oldRows.length} rows from the old shared "Washer" profile...`);
  for (const { source_key } of oldRows) {
    await stagePendingChange({
      tableName: "material_size_guides",
      operation: "deactivate",
      sourceKey: source_key,
      fields: null,
      reason: "Superseded by per-grade Washer profiles (Washer-A36/F35/F436/F844), nothing maps to the shared profile any more.",
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-split-washer-profiles-deactivate-${Date.now()}`,
    });
  }

  console.log("\nPublishing material_size_guides (clones forward, then validates + runs the golden simulation cases)...");
  const msgResult = await publishPendingChangesForTable(
    "material_size_guides",
    actorUserId,
    `script-split-washer-profiles-msg-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${msgResult.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${msgResult.report.simulationCasesRun}, failures: ${msgResult.report.regressionFailures.length}.`);
  if (msgResult.report.regressionFailures.length > 0) {
    console.error("Regression failures — stopping before touching grade_profile_rules:", msgResult.report.regressionFailures);
    await pool.end();
    process.exit(1);
  }

  // --- 3. Repoint grade_profile_rules to the new per-grade profiles ---
  console.log("\nStaging grade_profile_rules repoints...\n");
  for (const { profile, grade } of PROFILES) {
    console.log(`  Washer / ${grade} -> ${profile}`);
    await stagePendingChange({
      tableName: "grade_profile_rules",
      operation: "update",
      sourceKey: `PROFILE-WASHER-${grade}`,
      fields: { default_product_profile: profile },
      reason: `Repointed to the new ${profile} profile as part of the Washer profile split (2026-09-17).`,
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-split-washer-profiles-gpr-${Date.now()}`,
    });
  }

  console.log("\nPublishing grade_profile_rules (clones forward, then validates + runs the golden simulation cases)...");
  const gprResult = await publishPendingChangesForTable(
    "grade_profile_rules",
    actorUserId,
    `script-split-washer-profiles-gpr-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${gprResult.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${gprResult.report.simulationCasesRun}, failures: ${gprResult.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
