/**
 * Adds the missing costing_route_rules row for Washer / F844.
 *
 * Discovered immediately after add-washer-f844-grade-rule.ts (2026-09-17):
 * F436 has a Trading-only costing_route_rules entry so calculateCustomLine
 * short-circuits with WRONG_COSTING_ROUTE (harmless, caught by the route
 * merge) instead of attempting Custom Production. F844 had no such entry,
 * so Custom Production was attempted for real — and failed hard with
 * RAW_SIZE_INVALID, because material_size_guides rows added for F844's
 * imperial sizes (fill-washer-trading-sizes.ts) intentionally have no
 * washer_od/washer_thickness (F844 has no Custom Production price/geometry
 * at all — it only exists as a Trading pricelist item). Without this rule,
 * every F844 line fails outright even though Trading pricing is correct.
 *
 * Usage: npm run add:washer-f844-route-rule
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
    `SELECT count(*) AS n FROM costing_route_rules
     WHERE active AND guide_version_id = $1 AND product_family = 'Washer' AND grade_or_spec = 'F844'`,
    [guideVersionId],
  );
  if (Number(existing[0].n) > 0) {
    console.log("Washer/F844 costing_route_rules row already exists — nothing to do.");
    await pool.end();
    return;
  }

  const actorUserId = await resolveActorUserId();
  console.log("Staging costing_route_rules row for Washer / F844 (Trading)...\n");

  await stagePendingChange({
    tableName: "costing_route_rules",
    operation: "create",
    sourceKey: "ROUTE-WASHER-F844",
    fields: {
      product_family: "Washer",
      grade_or_spec: "F844",
      allowed_costing_route: "Trading",
      price_source: "Trading_Items + Trading_Price_Tiers",
      enforcement: "required",
      priority: 300,
      notes: "Use existing F844 fixed pricelist (imperial sizes only). No Custom Production geometry/price exists for F844.",
    },
    reason:
      "F844 lines were failing calculation with RAW_SIZE_INVALID because Custom Production was attempted " +
      "(no route rule to short-circuit it) against material_size_guides rows that intentionally have no " +
      "washer_od/washer_thickness. Mirrors the existing F436 Trading-only route rule.",
    actorUserId,
    actorRole: "super_admin",
    requestId: `script-add-washer-f844-route-rule-${Date.now()}`,
  });

  console.log("Publishing (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "costing_route_rules",
    actorUserId,
    `script-add-washer-f844-route-rule-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
