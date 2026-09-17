/**
 * Updates the Washer raw_cut_weight_per_item formula: adds a 3mm cutting
 * margin to washer_od before squaring, and drops the costing_weight=... line
 * (dead code — customPipeline.ts only ever reads env.raw_weight; the actual
 * weight used for pricing is computed independently from the configurable
 * CUSTOM_WEIGHT_TOLERANCE, not this formula's hardcoded *1.02).
 *
 * Old: raw_volume=washer_od^2*washer_thickness; raw_weight=raw_volume*density*1e-9; costing_weight=raw_weight*1.02
 * New: raw_volume=(washer_od+3)^2*washer_thickness; raw_weight=raw_volume*density*1e-9
 *
 * Business-confirmed 2026-09-17. washer_od/washer_thickness are stored in mm
 * for every Washer profile (Washer-A36/F35/F436/F844) regardless of source
 * standard's native units — imperial standards (F436, F844) were converted
 * inches->mm at data-entry time (split-washer-profiles.ts), so no unit
 * conversion is needed inside the formula itself.
 *
 * Usage: npm run update:washer-raw-cut-formula
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
  const actorUserId = await resolveActorUserId();

  await stagePendingChange({
    tableName: "calculation_formulas",
    operation: "update",
    sourceKey: "FORMULA-WASHER-RAW-CUT-V1",
    fields: {
      formula_expression: "raw_volume=(washer_od+3)^2*washer_thickness; raw_weight=raw_volume*density*1e-9",
    },
    reason:
      "Added 3mm cutting margin to washer_od before squaring (business-confirmed 2026-09-17). Dropped the " +
      "costing_weight=... statement -- customPipeline.ts never reads it; the weight used for pricing comes " +
      "from CUSTOM_WEIGHT_TOLERANCE applied to raw_weight in code, not this formula.",
    actorUserId,
    actorRole: "super_admin",
    requestId: `script-update-washer-raw-cut-formula-${Date.now()}`,
  });

  console.log("Publishing calculation_formulas (clones forward, then validates + runs the golden simulation cases)...");
  const result = await publishPendingChangesForTable(
    "calculation_formulas",
    actorUserId,
    `script-update-washer-raw-cut-formula-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);
  if (result.report.regressionFailures.length > 0) {
    console.error("Regression failures:", JSON.stringify(result.report.regressionFailures, null, 2));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
