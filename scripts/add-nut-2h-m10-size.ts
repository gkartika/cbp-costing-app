/**
 * Adds the missing M10 row to the Heavy Hex material_size_guides profile.
 *
 * Found during the Bolt/Nut master-data audit (2026-09-17): trading_items
 * has a fully-priced Nut/2H/M10 row (5 active trading_price_tiers, same
 * count as its M12+ siblings) but Heavy Hex's smallest metric size guide
 * row is M12 -- so M10 was never selectable in the Size dropdown at all,
 * same shape as the Washer size-dropdown gap fixed earlier this session.
 *
 * width_flat/width_corner are left NULL on purpose (no authoritative M10
 * Heavy Hex across-flats dimension was sourced) -- Trading (2H's only
 * priced route at this size) never reads them; Custom Production would
 * cleanly fail with HEX_WIDTH_MISSING if attempted at this size instead of
 * using a fabricated dimension.
 *
 * Usage: npm run add:nut-2h-m10-size
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
    `SELECT count(*) AS n FROM material_size_guides
     WHERE active AND guide_version_id = $1 AND product_profile = 'Heavy Hex' AND size_label = 'M10'`,
    [guideVersionId],
  );
  if (Number(existing[0].n) > 0) {
    console.log("Heavy Hex M10 already exists -- nothing to do.");
    await pool.end();
    return;
  }

  const actorUserId = await resolveActorUserId();
  console.log("Staging Heavy Hex M10 row...");

  await stagePendingChange({
    tableName: "material_size_guides",
    operation: "create",
    sourceKey: "SIZE-METRIC-HEAVY-HEX-10",
    fields: {
      unit_system: "Metric",
      standard_group: "ANSI Metric",
      product_profile: "Heavy Hex",
      size_label: "M10",
      diameter_mm: 10,
    },
    reason:
      "Nut/2H/M10 has full Trading pricing (5 tiers) but was never selectable in the Heavy Hex Size dropdown " +
      "(smallest existing row was M12). Added so it's reachable; width_flat/width_corner left null since no " +
      "sourced dimension exists (Trading, the only priced route at this size, never reads them).",
    actorUserId,
    actorRole: "super_admin",
    requestId: `script-add-nut-2h-m10-size-${Date.now()}`,
  });

  console.log("Publishing (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "material_size_guides",
    actorUserId,
    `script-add-nut-2h-m10-size-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
