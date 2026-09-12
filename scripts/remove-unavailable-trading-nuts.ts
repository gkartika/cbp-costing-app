/**
 * Deactivates the 8 Heavy Hex Nut / grade 2H trading items (M48, M52, M56,
 * M64, M72, M80, M90, M100) that were imported with zero trading_price_tiers
 * rows -- selecting any of them in the Trading item picker and calculating
 * throws tradingTierNotFound() regardless of quantity. Business-confirmed
 * 2026-09-12: these sizes are not actually stocked/traded, so the item rows
 * are removed from the pricelist rather than given fabricated tiers. (M8,
 * which also had a tierless row, is NOT included here -- its other two
 * grades at M8 [4.6, 8.8] do have real tiers, so M8 stays available; the
 * tierless M8/F10 row is a separate data gap to fix later, not a delete.)
 *
 * Usage: npm run remove:unavailable-trading-nuts
 */
import { pool } from "../src/lib/db";
import { stagePendingChange, publishPendingChangesForTable } from "../src/lib/masterdata/pendingChanges";

const TARGET_SIZES = ["M48", "M52", "M56", "M64", "M72", "M80", "M90", "M100"];

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

  const { rows: targets } = await pool.query<{ trading_item_id: string; source_key: string; size_label: string }>(
    `SELECT trading_item_id, source_key, size_label FROM trading_items
     WHERE guide_version_id = $1 AND active AND product_category = 'Nut' AND size_label = ANY($2)`,
    [guideVersionId, TARGET_SIZES],
  );
  if (targets.length === 0) {
    console.log("No matching active items found — already deactivated, or sizes changed. Nothing to do.");
    await pool.end();
    return;
  }

  const { rows: withTiers } = await pool.query<{ trading_item_id: string }>(
    `SELECT DISTINCT trading_item_id FROM trading_price_tiers
     WHERE guide_version_id = $1 AND active AND trading_item_id = ANY($2)`,
    [guideVersionId, targets.map((t) => t.trading_item_id)],
  );
  if (withTiers.length > 0) {
    throw new Error(
      `Refusing to continue: ${withTiers.length} of the target items actually have active price tiers ` +
        `(${withTiers.map((r) => r.trading_item_id).join(", ")}) — that contradicts the "not available" assumption this script is built on. Check trading_price_tiers before re-running.`,
    );
  }

  const { rows: refs } = await pool.query<{ costing_line_id: string }>(
    `SELECT costing_line_id FROM costing_lines WHERE trading_item_id = ANY($1) AND deleted_at IS NULL`,
    [targets.map((t) => t.trading_item_id)],
  );
  if (refs.length > 0) {
    throw new Error(
      `Refusing to continue: ${refs.length} existing costing_lines still reference these items ` +
        `(${refs.map((r) => r.costing_line_id).join(", ")}). Deactivating would orphan a live costing line.`,
    );
  }

  const actorUserId = await resolveActorUserId();
  const reason =
    `Heavy Hex Nut 2H sizes ${targets.map((t) => t.size_label).join(", ")} were imported with zero trading_price_tiers rows ` +
    `-- unselectable without throwing tradingTierNotFound() at any quantity. Business-confirmed 2026-09-12: these sizes are ` +
    `not actually stocked/traded, so removing the items rather than fabricating tiers.`;

  console.log(`Staging deactivation of ${targets.length} unavailable trading items...`);
  for (const row of targets) {
    console.log(`  ${row.source_key} (${row.size_label})`);
    await stagePendingChange({
      tableName: "trading_items",
      operation: "deactivate",
      sourceKey: row.source_key,
      fields: null,
      reason,
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-remove-unavailable-trading-nuts-${Date.now()}`,
    });
  }

  console.log("\nPublishing (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "trading_items",
    actorUserId,
    `script-remove-unavailable-trading-nuts-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
