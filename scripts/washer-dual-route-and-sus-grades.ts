/**
 * 1. Opens up Trading as a second route for Washer A36, F436 and F844
 *    (previously each had a costing_route_rules row forcing exactly one
 *    route — A36 "Custom Production" only, F436/F844 "Trading" only).
 *    resolveTradingItemByAttributes/calculateCustomLine both treat "no rule
 *    for this (family, grade)" as "both routes allowed, merge results" (see
 *    resolvers.ts:372-375 and customPipeline.ts:163-168) — so the fix is
 *    simply deactivating those three rows, not adding new ones. F436/F844
 *    already have real geometry (Washer-F436/Washer-F844 profiles) and a
 *    Production material mapping for F436 (MAT-PLATE-65MN); F844 still has
 *    no material_grade_map row so its Production side will keep failing
 *    until one is added, same as before this change. A36 keeps its
 *    existing Production pricing and gains an (empty, for now) Trading
 *    slot business-confirmed 2026-09-17.
 *
 * 2. Renames the "Washer-A36" material_size_guides profile to the
 *    grade-neutral "Washer-DIN125", since it's now also the Production
 *    geometry source for two new grades that share DIN 125 sizing.
 *
 * 3. Adds two new Washer grades, SUS304 and SUS316 (business-confirmed
 *    2026-09-17) — DIN 125 sizing/geometry (profile "Washer-DIN125", same
 *    as A36), material mapped to the existing SUS304/SUS316 rows in
 *    `materials` (density 7930/7980 kg/m3). No costing_route_rules row for
 *    either, so both routes are open from day one, matching A36/F436/F844.
 *    price_per_kg is intentionally NOT populated here — none exists yet for
 *    Washer/SUS304 or Washer/SUS316 (confirmed live, 2026-09-17), so
 *    Production will fail per-line (PRICE_NOT_FOUND) until real numbers are
 *    provided; Trading has no data either ("harga menyusul").
 *
 * Usage: npm run washer-dual-route-and-sus-grades
 */
import { pool } from "../src/lib/db";
import { stagePendingChange, publishPendingChangesForTable } from "../src/lib/masterdata/pendingChanges";

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

async function publish(tableName: string, actorUserId: string, label: string) {
  console.log(`\nPublishing ${tableName} (${label})...`);
  const result = await publishPendingChangesForTable(tableName, actorUserId, `script-washer-dual-route-${tableName}-${Date.now()}`);
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);
  if (result.report.regressionFailures.length > 0) {
    console.error("Regression failures:", JSON.stringify(result.report.regressionFailures, null, 2));
    await pool.end();
    process.exit(1);
  }
  return result.guideVersionId;
}

async function main() {
  const actorUserId = await resolveActorUserId();

  // --- 1. Rename Washer-A36 -> Washer-DIN125 in material_size_guides ---
  const { rows: gv1 } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  const gvid1 = gv1[0].guide_version_id;
  const { rows: a36Rows } = await pool.query<{ source_key: string }>(
    `SELECT source_key FROM material_size_guides WHERE guide_version_id = $1 AND active AND product_profile = 'Washer-A36'`,
    [gvid1],
  );
  console.log(`Renaming ${a36Rows.length} Washer-A36 rows to Washer-DIN125...`);
  for (const { source_key } of a36Rows) {
    await stagePendingChange({
      tableName: "material_size_guides",
      operation: "update",
      sourceKey: source_key,
      fields: { product_profile: "Washer-DIN125" },
      reason: "Renamed to grade-neutral profile name — now shared by A36, SUS304 and SUS316 (all DIN 125 sizing).",
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-washer-dual-route-rename-${Date.now()}`,
    });
  }
  await publish("material_size_guides", actorUserId, "rename Washer-A36 -> Washer-DIN125");

  // --- 2. grade_profile_rules: repoint A36, add SUS304/SUS316 ---
  console.log("\nStaging grade_profile_rules changes...");
  await stagePendingChange({
    tableName: "grade_profile_rules",
    operation: "update",
    sourceKey: "PROFILE-WASHER-A36",
    fields: { default_product_profile: "Washer-DIN125" },
    reason: "Follows the Washer-A36 -> Washer-DIN125 profile rename.",
    actorUserId,
    actorRole: "super_admin",
    requestId: `script-washer-dual-route-gpr-${Date.now()}`,
  });
  for (const grade of ["SUS304", "SUS316"]) {
    await stagePendingChange({
      tableName: "grade_profile_rules",
      operation: "create",
      sourceKey: `PROFILE-WASHER-${grade}`,
      fields: {
        product_family: "Washer",
        grade_or_spec: grade,
        default_product_profile: "Washer-DIN125",
        mapping_status: "confirmed",
        override_allowed: false,
        priority: 200,
        notes: `New Washer grade (business-confirmed 2026-09-17) — DIN 125 sizing, same profile as A36.`,
        standard_reference: "DIN 125",
      },
      reason: `Adding Washer grade ${grade} — Custom Production via DIN 125 sizing, Trading price to follow.`,
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-washer-dual-route-gpr-${Date.now()}`,
    });
  }
  await publish("grade_profile_rules", actorUserId, "repoint A36 + add SUS304/SUS316");

  // --- 3. material_grade_map: SUS304/SUS316 -> existing material rows ---
  console.log("\nStaging material_grade_map changes...");
  for (const [grade, materialSourceKey] of [
    ["SUS304", "MAT-SUS304"],
    ["SUS316", "MAT-SUS316"],
  ] as const) {
    await stagePendingChange({
      tableName: "material_grade_map",
      operation: "create",
      sourceKey: `MATGRADE-${materialSourceKey}-WASHER-${grade}`,
      fields: {
        material_id: materialSourceKey,
        product_family: "Washer",
        grade_or_spec: grade,
      },
      reason: `Maps new Washer grade ${grade} to the existing ${materialSourceKey} material row for weight calc.`,
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-washer-dual-route-mgm-${Date.now()}`,
    });
  }
  await publish("material_grade_map", actorUserId, "map SUS304/SUS316 to materials");

  // --- 4. costing_route_rules: deactivate the single-route locks ---
  const { rows: gv2 } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  const gvid2 = gv2[0].guide_version_id;
  const { rows: routeRows } = await pool.query<{ source_key: string; grade_or_spec: string }>(
    `SELECT source_key, grade_or_spec FROM costing_route_rules
     WHERE guide_version_id = $1 AND active AND product_family = 'Washer' AND grade_or_spec IN ('A36', 'F436', 'F844')`,
    [gvid2],
  );
  console.log(`\nDeactivating ${routeRows.length} costing_route_rules rows (opening both routes)...`);
  for (const { source_key, grade_or_spec } of routeRows) {
    console.log(`  ${grade_or_spec}: route restriction removed -- both Production and Trading now attempted.`);
    await stagePendingChange({
      tableName: "costing_route_rules",
      operation: "deactivate",
      sourceKey: source_key,
      fields: null,
      reason:
        "Business decision 2026-09-17: this grade should offer both Production and Trading, not be locked to one. " +
        "No rule for a (family, grade) means both routes are attempted and merged (resolvers.ts / customPipeline.ts).",
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-washer-dual-route-crr-${Date.now()}`,
    });
  }
  await publish("costing_route_rules", actorUserId, "open both routes for A36/F436/F844");

  console.log(
    "\nDone. Reminder: no price_per_kg exists yet for Washer/SUS304 or Washer/SUS316 -- Production will fail " +
      "per-line until real Rp/kg numbers are provided. Trading has no data for SUS304/SUS316 either.",
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
