/**
 * Fills the remaining Washer sizes in material_size_guides that already have
 * full Trading pricing (trading_items + trading_price_tiers, grade F436 /
 * F436M and, unreachably via the UI today, F844) but were never added to
 * material_size_guides — so they never appeared in the Size dropdown at all,
 * even though they price fine once selected (2026-09-17 audit).
 *
 * fill-washer-dimensions.ts (2026-09-04) filled the 15 metric DIN 125 rows
 * needed for Custom Production (A36/F35) weight calc. It left 17 imperial
 * sizes and 3 metric sizes (M14, M16, M72) unfilled because those are
 * Trading-only for this dataset (A36/F35 price_per_kg only covers M20-M64)
 * and the script's scope was Custom Production.
 *
 * All three Washer grades (A36, F35, F436) share one product_profile
 * ("Washer") in grade_profile_rules, so any size added here becomes
 * selectable for all three in the UI. washer_od/washer_thickness are left
 * NULL on these rows on purpose: Trading (F436) never reads them
 * (tradingPipeline.ts resolves size/price straight from trading_items /
 * trading_price_tiers), while Custom Production (A36/F35) requires them to
 * be positive and will cleanly fail a line with RAW_SIZE_INVALID rather than
 * silently falling back to a neighboring size's price_per_kg if someone
 * mis-selects A36/F35 at one of these sizes (they have no real geometry or
 * per-kg price at these sizes; a visible per-line error is correct here).
 *
 * diameter_mm is still required (loaded unconditionally on every costing
 * line, both routes) — imperial rows use the plain inch-to-mm conversion,
 * metric rows use the numeric part of the label.
 *
 * Usage: npm run fill:washer-trading-sizes
 */
import { pool } from "../src/lib/db";
import { stagePendingChange, publishPendingChangesForTable } from "../src/lib/masterdata/pendingChanges";

const IMPERIAL: [string, number][] = [
  ["0.5", 0.5],
  ["0.625", 0.625],
  ["0.75", 0.75],
  ["0.875", 0.875],
  ["1", 1],
  ["1.125", 1.125],
  ["1.25", 1.25],
  ["1.375", 1.375],
  ["1.5", 1.5],
  ["1.625", 1.625],
  ["1.75", 1.75],
  ["1.875", 1.875],
  ["2", 2],
  ["2.25", 2.25],
  ["2.5", 2.5],
  ["2.75", 2.75],
  ["3", 3],
];

const METRIC: [string, number][] = [
  ["M14", 14],
  ["M16", 16],
  ["M72", 72],
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

  const { rows: existing } = await pool.query<{ size_label: string }>(
    `SELECT size_label FROM material_size_guides WHERE active AND guide_version_id = $1 AND product_profile = 'Washer'`,
    [guideVersionId],
  );
  const existingLabels = new Set(existing.map((r) => r.size_label));

  const toAdd: { size: string; diameterMm: number; unitSystem: string; standardGroup: string }[] = [];
  for (const [size, inches] of IMPERIAL) {
    if (!existingLabels.has(size)) {
      toAdd.push({ size, diameterMm: Math.round(inches * 25.4 * 100) / 100, unitSystem: "Imperial", standardGroup: "ASTM F436" });
    }
  }
  for (const [size, mm] of METRIC) {
    if (!existingLabels.has(size)) {
      toAdd.push({ size, diameterMm: mm, unitSystem: "Metric", standardGroup: "ASTM F436M" });
    }
  }

  if (toAdd.length === 0) {
    console.log("All target Washer sizes already present in material_size_guides — nothing to do.");
    await pool.end();
    return;
  }

  const actorUserId = await resolveActorUserId();
  console.log(`Staging ${toAdd.length} Washer profile rows (Trading-only sizes, no geometry)...\n`);

  for (const { size, diameterMm, unitSystem, standardGroup } of toAdd) {
    console.log(`  ${size.padEnd(6)} diameter ${diameterMm}mm  (${unitSystem})`);
    await stagePendingChange({
      tableName: "material_size_guides",
      operation: "create",
      sourceKey: `SIZE-${unitSystem.toUpperCase()}-WASHER-${size}`,
      fields: {
        unit_system: unitSystem,
        standard_group: standardGroup,
        product_profile: "Washer",
        size_label: size,
        diameter_mm: diameterMm,
      },
      reason:
        `Washer size dropdown was missing sizes that already have full Trading pricing ` +
        `(trading_items/trading_price_tiers, grade F436/F436M) — added so they're selectable in costing. ` +
        `washer_od/washer_thickness intentionally left null: Trading route never reads them, and Custom ` +
        `Production (A36/F35) has no real price/geometry at these sizes so it should fail loudly if selected.`,
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-fill-washer-trading-sizes-${Date.now()}`,
    });
  }

  console.log("\nPublishing (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "material_size_guides",
    actorUserId,
    `script-fill-washer-trading-sizes-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
