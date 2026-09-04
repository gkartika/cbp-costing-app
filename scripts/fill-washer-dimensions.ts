/**
 * Fills the Washer profile's material_size_guides — found empty in every
 * guide version that has ever existed in this database (2026-09-04 audit).
 * Custom Production Washer (grades A36, F35) had price_per_kg rows for
 * M20-M64 but no geometry to compute a weight from, so every line failed
 * with RAW_SIZE_INVALID regardless of price.
 *
 * Source: DIN 125 Form A plain washer dimensions (outer diameter, thickness),
 * confirmed by the business 2026-09-04.
 *
 * A36 and F35 share one product_profile ("Washer") in grade_profile_rules —
 * that mapping predates this fix and material_size_guides' business key is
 * (product_profile, size_label), so the two grades cannot carry different
 * dimensions without also splitting the profile itself, a larger schema
 * decision than "fill the missing geometry." DIN 125 is used for the shared
 * profile rather than JIS B1186's high-tension washer dimensions (which
 * would suit F35 specifically): DIN 125 has full, real M20-M64 coverage,
 * while JIS B1186's F35/high-tension series only formally covers M20-M33 —
 * beyond that there is no distinct structural-washer standard to point to,
 * only extrapolation. F436 is untouched: it prices via Trading with real
 * weight_kg already on each trading_items row, so it never resolves through
 * material_size_guides at all.
 *
 * Usage: npm run fill:washer-dimensions
 */
import { pool } from "../src/lib/db";
import { stagePendingChange, publishPendingChangesForTable } from "../src/lib/masterdata/pendingChanges";

// size label, diameter_mm (nominal), washer_od, washer_thickness — DIN 125 Form A
const DIN_125: [string, number, number, number][] = [
  ["M20", 20, 37, 3],
  ["M22", 22, 39, 3],
  ["M24", 24, 44, 4],
  ["M27", 27, 50, 4],
  ["M30", 30, 56, 4],
  ["M33", 33, 60, 5],
  ["M36", 36, 66, 5],
  ["M39", 39, 72, 6],
  ["M42", 42, 78, 7],
  ["M45", 45, 85, 7],
  ["M48", 48, 92, 8],
  ["M52", 52, 98, 8],
  ["M56", 56, 105, 9],
  ["M60", 60, 110, 9],
  ["M64", 64, 115, 9],
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

  const { rows: existing } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM material_size_guides WHERE active AND guide_version_id = $1 AND product_profile = 'Washer'`,
    [guideVersionId],
  );
  if (Number(existing[0].n) > 0) {
    console.log("Washer profile already has rows — nothing to do. Check material_size_guides before re-running.");
    await pool.end();
    return;
  }

  const actorUserId = await resolveActorUserId();
  console.log(`Staging ${DIN_125.length} Washer profile rows (DIN 125 Form A)...\n`);

  for (const [size, diameterMm, od, thickness] of DIN_125) {
    console.log(`  ${size.padEnd(6)} diameter ${diameterMm}mm  OD ${od}mm  thickness ${thickness}mm`);
    await stagePendingChange({
      tableName: "material_size_guides",
      operation: "create",
      sourceKey: `SIZE-METRIC-WASHER-${size}`,
      fields: {
        unit_system: "Metric",
        standard_group: "DIN 125",
        product_profile: "Washer",
        size_label: size,
        diameter_mm: diameterMm,
        washer_od: od,
        washer_thickness: thickness,
      },
      reason:
        `Washer profile had zero geometry rows in every guide version — Custom Production A36/F35 failed outright ` +
        `regardless of price. Filled from DIN 125 Form A (confirmed by the business 2026-09-04).`,
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-fill-washer-dimensions-${Date.now()}`,
    });
  }

  console.log("\nPublishing (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "material_size_guides",
    actorUserId,
    `script-fill-washer-dimensions-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
