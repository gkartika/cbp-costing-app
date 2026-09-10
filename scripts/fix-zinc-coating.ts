/**
 * Fixes the "Zinc" coating option, which has never pointed at real Zinc
 * coating pricing. All 68 rows behind it (process_name='Dies',
 * process_group='Tooling', basis='IDR_per_set', rates 2.5M-15.6M) are byte-
 * for-byte duplicates of dies_cost_guides' tooling costs, mislabeled with
 * display_label='Zinc'. Selecting "Zinc" multiplied an item's weight in kg by
 * a rate meant to be a flat per-set tooling charge in the millions, and
 * `resolveCoatingRule` can't even pick the size-correct row among them since
 * none carry a diameter tier (min_diameter_mm is null on all 68) - it just
 * grabbed whichever row for that item_scope came first.
 *
 * A migration comment (1700000021000_minimum_prices_and_coating_labels.sql)
 * rationalized this as an intentional "Dies -> Zinc" display split citing a
 * "DEC-041" that does not exist anywhere in docs/. docs/LEGACY-DATA-STUDY.md
 * (line 205) confirms Zinc was a real, separate coating process in 141
 * historical quotation lines - its actual rate card was simply never
 * imported.
 *
 * Fix, confirmed by the business 2026-09-10: Zinc is IDR 5,000/kg, no
 * diameter tiers, applies to every item type alike (same shape as PTFE's
 * "All Item" row, minus PTFE's tiering).
 *
 * Usage: npm run fix:zinc-coating
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

  const { rows: existingZinc } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM coating_price_guides WHERE active AND guide_version_id = $1 AND process_name = 'Zinc'`,
    [guideVersionId],
  );
  if (Number(existingZinc[0].n) > 0) {
    console.log("A real 'Zinc' process_name row already exists — nothing to do. Check coating_price_guides before re-running.");
    await pool.end();
    return;
  }

  const { rows: diesRows } = await pool.query<{ source_key: string; rate: string; item_scope: string }>(
    `SELECT source_key, rate, item_scope FROM coating_price_guides
     WHERE active AND guide_version_id = $1 AND process_name = 'Dies' AND display_label = 'Zinc'`,
    [guideVersionId],
  );
  if (diesRows.length === 0) {
    console.log("No mislabeled 'Dies'/'Zinc' rows found — nothing to deactivate.");
  }

  const actorUserId = await resolveActorUserId();
  const reason =
    `"Zinc" coating resolved to 68 dies-tooling-cost rows mislabeled display_label='Zinc' ` +
    `(process_name='Dies', process_group='Tooling', basis='IDR_per_set', duplicates of dies_cost_guides) - ` +
    `selecting Zinc multiplied item weight by a multi-million per-set tooling rate as if it were IDR/kg. ` +
    `Deactivating those and adding the real Zinc coating rate: IDR 5,000/kg, flat, no diameter tiers, all item types (confirmed by the business 2026-09-10).`;

  console.log(`Staging deactivation of ${diesRows.length} mislabeled 'Dies'/'Zinc' rows...`);
  for (const row of diesRows) {
    await stagePendingChange({
      tableName: "coating_price_guides",
      operation: "deactivate",
      sourceKey: row.source_key,
      fields: null,
      reason,
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-fix-zinc-coating-${Date.now()}`,
    });
  }

  console.log("Staging the real Zinc coating rate (IDR 5,000/kg, flat, all items)...");
  await stagePendingChange({
    tableName: "coating_price_guides",
    operation: "create",
    sourceKey: "PROC-ZINC-ALL",
    fields: {
      process_group: "Coating",
      process_name: "Zinc",
      display_label: null,
      item_scope: "All Item",
      size_label: null,
      min_diameter_mm: null,
      basis: "IDR_per_kg",
      rate: 5000,
      currency: "IDR",
    },
    reason,
    actorUserId,
    actorRole: "super_admin",
    requestId: `script-fix-zinc-coating-${Date.now()}`,
  });

  console.log("\nPublishing (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "coating_price_guides",
    actorUserId,
    `script-fix-zinc-coating-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
