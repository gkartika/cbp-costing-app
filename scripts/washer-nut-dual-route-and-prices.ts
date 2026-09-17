/**
 * 1. Opens dual route (Production + Trading) for every remaining Washer
 *    grade that was still locked to one route: F35 (Custom Production
 *    only). A36/F436/F844 were already opened; Nut has never had a
 *    costing_route_rules row at all, so it's already dual-route by default
 *    (no rule = both routes attempted and merged). Bolt/A325 is left as-is
 *    -- out of scope, not requested.
 *
 * 2. Adds the F844 material_grade_map row it was missing (mapped to
 *    MAT-CARBON-STEEL -- F844 is ASTM's "plain, unhardened" general-use
 *    washer, the plainest carbon-steel option available; density is 7850
 *    kg/m3 same as every other carbon-steel material already used for
 *    Washer, so this choice doesn't change any weight math).
 *
 * 3. Loads flat Rp/kg Production prices, business-confirmed 2026-09-17:
 *      SUS304 = 150,000/kg  (15 sizes, Washer-DIN125 profile, M20-M64)
 *      SUS316 = 180,000/kg  (15 sizes, Washer-DIN125 profile, M20-M64)
 *      F436   =  80,000/kg  (30 sizes, Washer-F436 profile -- 17 imperial + 13 metric)
 *      F844   =  80,000/kg  (17 sizes, Washer-F844 profile -- imperial only)
 *    One row per size at a flat rate (no size-tiering was given, unlike
 *    A36/F35's existing tiered rows) -- exact match always succeeds so the
 *    next-larger-size fallback in resolvePricePerKg never triggers.
 *
 * Usage: npm run washer-nut-dual-route-and-prices
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
  const result = await publishPendingChangesForTable(
    tableName,
    actorUserId,
    `script-washer-nut-dual-route-prices-${tableName}-${Date.now()}`,
  );
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

  // --- 1. Open dual route for Washer/F35 ---
  const { rows: gv1 } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  const { rows: f35Route } = await pool.query<{ source_key: string }>(
    `SELECT source_key FROM costing_route_rules
     WHERE guide_version_id = $1 AND active AND product_family = 'Washer' AND grade_or_spec = 'F35'`,
    [gv1[0].guide_version_id],
  );
  console.log("Opening dual route for Washer/F35...");
  for (const { source_key } of f35Route) {
    await stagePendingChange({
      tableName: "costing_route_rules",
      operation: "deactivate",
      sourceKey: source_key,
      fields: null,
      reason: "Business decision 2026-09-17: Washer F35 should offer both Production and Trading, matching A36/F436/F844.",
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-washer-nut-dual-route-prices-crr-${Date.now()}`,
    });
  }
  await publish("costing_route_rules", actorUserId, "open dual route for Washer/F35");

  // --- 2. Add missing material_grade_map row for Washer/F844 ---
  console.log("\nStaging material_grade_map for Washer/F844...");
  await stagePendingChange({
    tableName: "material_grade_map",
    operation: "create",
    sourceKey: "MATGRADE-MAT-CARBON-STEEL-WASHER-F844",
    fields: { material_id: "MAT-CARBON-STEEL", product_family: "Washer", grade_or_spec: "F844" },
    reason: "F844 (ASTM plain/unhardened general-use washer) had no material_grade_map row, blocking its new Production route.",
    actorUserId,
    actorRole: "super_admin",
    requestId: `script-washer-nut-dual-route-prices-mgm-${Date.now()}`,
  });
  await publish("material_grade_map", actorUserId, "map F844 to MAT-CARBON-STEEL");

  // --- 3. Load flat price_per_kg rows ---
  const { rows: gv2 } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  const gvid = gv2[0].guide_version_id;

  const jobs: { grade: string; profile: string; price: number; material: string }[] = [
    { grade: "SUS304", profile: "Washer-DIN125", price: 150000, material: "Stainless Steel 304" },
    { grade: "SUS316", profile: "Washer-DIN125", price: 180000, material: "Stainless Steel 316" },
    { grade: "F436", profile: "Washer-F436", price: 80000, material: "Hardened Steel" },
    { grade: "F844", profile: "Washer-F844", price: 80000, material: "Carbon Steel" },
  ];

  console.log("\nStaging price_per_kg rows...\n");
  for (const { grade, profile, price, material } of jobs) {
    const { rows: sizes } = await pool.query<{ size_label: string; diameter_mm: string }>(
      `SELECT size_label, diameter_mm FROM material_size_guides WHERE guide_version_id = $1 AND active AND product_profile = $2 ORDER BY size_label`,
      [gvid, profile],
    );
    console.log(`  Washer / ${grade}: ${sizes.length} sizes @ Rp ${price.toLocaleString("id-ID")}/kg`);
    for (const { size_label, diameter_mm } of sizes) {
      await stagePendingChange({
        tableName: "price_per_kg",
        operation: "create",
        sourceKey: `PKG-WASHER-${size_label}-${grade}`,
        fields: {
          product_family: "Washer",
          grade_or_spec: grade,
          material,
          unit_system: size_label.startsWith("M") ? "Metric" : "Imperial",
          size_label,
          diameter_mm: Number(diameter_mm),
          selling_price_per_kg: price,
          currency: "IDR",
        },
        reason: `Flat Rp ${price.toLocaleString("id-ID")}/kg Production price for Washer/${grade}, business-confirmed 2026-09-17.`,
        actorUserId,
        actorRole: "super_admin",
        requestId: `script-washer-nut-dual-route-prices-ppk-${Date.now()}`,
      });
    }
  }
  await publish("price_per_kg", actorUserId, "load SUS304/SUS316/F436/F844 flat prices");

  console.log("\nDone.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
