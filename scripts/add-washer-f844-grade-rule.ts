/**
 * Adds the missing F844 grade_profile_rules row for Washer.
 *
 * trading_items has 17 imperial F844 washer rows (with full trading_price_tiers
 * coverage) but F844 has no grade_profile_rules entry for product_family='Washer'
 * — only A36, F35, F436 do — so F844 has never been selectable as a Washer grade
 * in costing, even though its Trading pricing is complete (2026-09-17 audit,
 * found alongside the material_size_guides Washer size-dropdown gap fixed by
 * fill-washer-trading-sizes.ts).
 *
 * Usage: npm run add:washer-f844-grade-rule
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

async function main() {
  const { rows: gvRows } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  if (gvRows.length === 0) throw new Error("No published guide version.");
  const guideVersionId = gvRows[0].guide_version_id;

  const { rows: existing } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM grade_profile_rules
     WHERE active AND guide_version_id = $1 AND product_family = 'Washer' AND grade_or_spec = 'F844'`,
    [guideVersionId],
  );
  if (Number(existing[0].n) > 0) {
    console.log("Washer/F844 grade_profile_rules row already exists — nothing to do.");
    await pool.end();
    return;
  }

  const actorUserId = await resolveActorUserId();
  console.log("Staging grade_profile_rules row for Washer / F844...\n");

  await stagePendingChange({
    tableName: "grade_profile_rules",
    operation: "create",
    sourceKey: "PROFILE-WASHER-F844",
    fields: {
      product_family: "Washer",
      grade_or_spec: "F844",
      default_product_profile: "Washer",
      mapping_status: "confirmed",
      override_allowed: false,
      priority: 300,
      notes: "Fixed CBP washer profile. F844 is a plain (non-hardened) structural washer, imperial sizes only.",
      standard_reference: "ASTM F844",
      reference_url: "https://store.astm.org/standards/f844",
    },
    reason:
      "F844 has full Trading pricing (trading_items + trading_price_tiers, 17 imperial sizes) but no " +
      "grade_profile_rules entry for product_family='Washer', so it was never selectable as a Washer grade " +
      "in costing despite pricing fine once reachable.",
    actorUserId,
    actorRole: "super_admin",
    requestId: `script-add-washer-f844-grade-rule-${Date.now()}`,
  });

  console.log("Publishing (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "grade_profile_rules",
    actorUserId,
    `script-add-washer-f844-grade-rule-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
