/**
 * Renames trading_items.grade_or_spec from "B8"/"B8M" to "A194-8"/"A194-8M"
 * for product_category='Nut'.
 *
 * Found during the Washer size-dropdown audit (2026-09-17): 28 Nut trading
 * rows (14 sizes each, M12-M45) carried grade_or_spec "B8"/"B8M" — the trade
 * name for ASTM A194 Grade 8/8M — but no selectable Nut grade in
 * grade_profile_rules is spelled that way; the UI only offers "A194-8" and
 * "A194-8M". resolveTradingItemByAttributes' gradeOrSpecMatches does exact
 * (or "/"-combined) matching only, so these rows could never be matched by
 * any line a user could actually create — confirmed with the business
 * 2026-09-17 that "B8" should simply read "A194-8" (same grade, renamed to
 * match the dropdown rather than combined like F436/F436M).
 *
 * Usage: npm run rename:nut-b8-trading-grades
 */
import { pool } from "../src/lib/db";
import { stagePendingChange, publishPendingChangesForTable } from "../src/lib/masterdata/pendingChanges";

const RENAMES: Record<string, string> = {
  B8: "A194-8",
  B8M: "A194-8M",
};

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

  const { rows } = await pool.query<{ source_key: string; grade_or_spec: string }>(
    `SELECT source_key, grade_or_spec FROM trading_items
     WHERE guide_version_id = $1 AND active AND product_category = 'Nut' AND grade_or_spec = ANY($2)
     ORDER BY source_key`,
    [guideVersionId, Object.keys(RENAMES)],
  );

  if (rows.length === 0) {
    console.log("No Nut trading_items rows with grade_or_spec B8/B8M found — nothing to do.");
    await pool.end();
    return;
  }

  const actorUserId = await resolveActorUserId();
  console.log(`Staging ${rows.length} trading_items grade_or_spec renames...\n`);

  for (const row of rows) {
    const newGrade = RENAMES[row.grade_or_spec];
    console.log(`  ${row.source_key.padEnd(20)} ${row.grade_or_spec} -> ${newGrade}`);
    await stagePendingChange({
      tableName: "trading_items",
      operation: "update",
      sourceKey: row.source_key,
      fields: { grade_or_spec: newGrade },
      reason:
        `"${row.grade_or_spec}" (ASTM A194 Gr. 8/8M trade name) never matched any selectable Nut grade in the ` +
        `costing UI (grade_profile_rules only offers "A194-8"/"A194-8M"), so this row was unreachable by any ` +
        `line. Renamed to the grade string the UI actually offers, per business confirmation 2026-09-17.`,
      actorUserId,
      actorRole: "super_admin",
      requestId: `script-rename-nut-b8-trading-grades-${Date.now()}`,
    });
  }

  console.log("\nPublishing (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "trading_items",
    actorUserId,
    `script-rename-nut-b8-trading-grades-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
