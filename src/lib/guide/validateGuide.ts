import { pool, withTransaction } from "@/lib/db";
import { Errors, AppError } from "@/lib/errors";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { validateFormula } from "@/lib/calc/formulaDsl";
import { loadGuideContext } from "@/lib/calc/loadGuideContext";
import { calculateCustomLine, type CustomLineInput } from "@/lib/calc/customPipeline";
import { calculateTradingPricelistLine, calculateTradingQuoteLine } from "@/lib/calc/tradingPipeline";
import { TAB_SPECS } from "@/lib/guide/importSchema";

export type ValidationReport = {
  formulaErrors: string[];
  rangeErrors: string[];
  duplicateKeyErrors: string[];
  rawBarErrors: string[];
  regressionFailures: string[];
  simulationCasesRun: number;
};

// Price_Per_Kg's TAB_SPECS uniqueBusinessKey (family, grade, size) predates
// thread_condition/product_type, which now legitimately let the same
// (family, grade, size) carry two active rows (e.g. Bolt HT vs FT) — so it
// needs the wider key here even though the import-time check still uses the
// narrower one declared on the spec.
const BUSINESS_KEY_OVERRIDES: Record<string, string[]> = {
  price_per_kg: ["product_family", "grade_or_spec", "size_label", "thread_condition", "product_type"],
};

/**
 * Re-checks every master table's declared business key for duplicate ACTIVE
 * rows within this one guide version. importGuide.ts already rejects
 * duplicates arriving through a fresh package import, but two incidents this
 * session (a duplicate Material_Grade_Map row, a duplicate Material_Size_Guides
 * row) both slipped in through the clone-forward-and-patch path instead,
 * which never ran that check. This runs against the actual persisted rows of
 * the Draft version being validated, so it catches a collision regardless of
 * which write path introduced it — without touching any other (retired)
 * guide version's already-immutable history.
 */
async function checkBusinessKeyUniqueness(guideVersionId: string): Promise<string[]> {
  const errors: string[] = [];
  for (const spec of TAB_SPECS) {
    const keyCols = BUSINESS_KEY_OVERRIDES[spec.table] ?? spec.uniqueBusinessKey;
    if (!keyCols || keyCols.length === 0) continue;

    const groupBy = keyCols.map((c) => `COALESCE(${c}::text, '')`).join(", ");
    const { rows } = await pool.query<{ dupe_count: number; key_values: string[] }>(
      `SELECT COUNT(*)::int AS dupe_count, ARRAY[${groupBy}] AS key_values
       FROM ${spec.table}
       WHERE guide_version_id = $1 AND active
       GROUP BY ${groupBy}
       HAVING COUNT(*) > 1`,
      [guideVersionId],
    );
    for (const row of rows) {
      errors.push(
        `${spec.tabName}: ${row.dupe_count} active rows share ${keyCols.join("+")} = (${row.key_values.join(", ")})`,
      );
    }
  }
  return errors;
}

type SimulationCaseRow = {
  simulation_id: string;
  source_key: string;
  route: string;
  input_json: unknown;
  expected_json: {
    resultStatus?: "PASS" | "EXPECTED_REJECT";
    expectedErrorCode?: string;
    tolerance?: number;
    [field: string]: unknown;
  };
};

function rangesOverlap(
  a: { min: number; max: number; minIncl: boolean; maxIncl: boolean },
  b: { min: number; max: number; minIncl: boolean; maxIncl: boolean },
): boolean {
  const aMaxTouchesBMin = a.max > b.min || (a.max === b.min && a.maxIncl && b.minIncl);
  const bMaxTouchesAMin = b.max > a.min || (b.max === a.min && b.maxIncl && a.minIncl);
  return aMaxTouchesBMin && bMaxTouchesAMin;
}

async function checkFormulas(guideVersionId: string): Promise<string[]> {
  const errors: string[] = [];
  const { rows } = await pool.query<{ formula_id: string; formula_expression: string; required_inputs: string }>(
    `SELECT formula_id, formula_expression, required_inputs FROM calculation_formulas WHERE guide_version_id = $1 AND active`,
    [guideVersionId],
  );
  for (const row of rows) {
    const inputs = row.required_inputs.split(",").map((s) => s.trim());
    const check = validateFormula(row.formula_expression, inputs);
    if (!check.valid) errors.push(`${row.formula_id}: ${check.error}`);
  }
  return errors;
}

async function checkRanges(guideVersionId: string): Promise<string[]> {
  const errors: string[] = [];

  const { rows: adjustmentRows } = await pool.query<{
    adjustment_rule_id: string;
    costing_route: string;
    rule_group: string;
    scope: string;
    threshold_min: string | null;
    threshold_max: string | null;
    min_inclusive: boolean;
    max_inclusive: boolean;
  }>(
    `SELECT adjustment_rule_id, costing_route, rule_group, scope, threshold_min, threshold_max, min_inclusive, max_inclusive
     FROM adjustment_rules WHERE guide_version_id = $1 AND active`,
    [guideVersionId],
  );
  const groups = new Map<string, typeof adjustmentRows>();
  for (const row of adjustmentRows) {
    const key = `${row.costing_route}|${row.rule_group}|${row.scope}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, rows] of groups) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = {
          min: rows[i].threshold_min !== null ? Number(rows[i].threshold_min) : -Infinity,
          max: rows[i].threshold_max !== null ? Number(rows[i].threshold_max) : Infinity,
          minIncl: rows[i].min_inclusive,
          maxIncl: rows[i].max_inclusive,
        };
        const b = {
          min: rows[j].threshold_min !== null ? Number(rows[j].threshold_min) : -Infinity,
          max: rows[j].threshold_max !== null ? Number(rows[j].threshold_max) : Infinity,
          minIncl: rows[j].min_inclusive,
          maxIncl: rows[j].max_inclusive,
        };
        if (rangesOverlap(a, b)) {
          errors.push(`adjustment_rules overlap in ${key}: ${rows[i].adjustment_rule_id} vs ${rows[j].adjustment_rule_id}`);
        }
      }
    }
  }

  const { rows: tierRows } = await pool.query<{ tier_id: string; trading_item_id: string; qty_min: number; qty_max: number | null }>(
    `SELECT tier_id, trading_item_id, qty_min, qty_max FROM trading_price_tiers WHERE guide_version_id = $1 AND active`,
    [guideVersionId],
  );
  const tierGroups = new Map<string, typeof tierRows>();
  for (const row of tierRows) {
    tierGroups.set(row.trading_item_id, [...(tierGroups.get(row.trading_item_id) ?? []), row]);
  }
  for (const [itemId, rows] of tierGroups) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = { min: rows[i].qty_min, max: rows[i].qty_max ?? Infinity, minIncl: true, maxIncl: true };
        const b = { min: rows[j].qty_min, max: rows[j].qty_max ?? Infinity, minIncl: true, maxIncl: true };
        if (rangesOverlap(a, b)) {
          errors.push(`trading_price_tiers overlap for item ${itemId}: ${rows[i].tier_id} vs ${rows[j].tier_id}`);
        }
      }
    }
  }

  return errors;
}

/**
 * Confirms every priced Bolt/Stud/Anchor (grade, size) whose material has
 * ANY raw_bar_stock rows can actually source a bar big enough for that
 * size's nominal diameter — a sourcing gap here would otherwise only
 * surface when a real user tries to calculate that exact line (DEC-039).
 * A material with zero raw_bar_stock rows is untracked and skipped — it
 * falls back to material_size_guides.raw_diameter_mm, same as the calc
 * engine (resolveRawBarDiameter) does.
 */
async function checkRawBarAvailability(guideVersionId: string): Promise<string[]> {
  const errors: string[] = [];
  const { rows } = await pool.query<{
    product_family: string;
    grade_or_spec: string;
    size_label: string;
    diameter_mm: string;
    material_name: string;
  }>(
    `SELECT DISTINCT mgm.product_family, mgm.grade_or_spec, ppk.size_label, msg.diameter_mm, m.material_name
       FROM material_grade_map mgm
       JOIN materials m
         ON m.guide_version_id = mgm.guide_version_id AND m.material_id = mgm.material_id
       JOIN grade_profile_rules gpr
         ON gpr.guide_version_id = mgm.guide_version_id
        AND gpr.product_family = mgm.product_family AND gpr.grade_or_spec = mgm.grade_or_spec AND gpr.active
       JOIN price_per_kg ppk
         ON ppk.guide_version_id = mgm.guide_version_id
        AND ppk.product_family = mgm.product_family AND ppk.grade_or_spec = mgm.grade_or_spec AND ppk.active
       JOIN material_size_guides msg
         ON msg.guide_version_id = mgm.guide_version_id
        AND msg.product_profile = gpr.default_product_profile AND msg.size_label = ppk.size_label AND msg.active
      WHERE mgm.guide_version_id = $1 AND mgm.active
        AND mgm.product_family IN ('Bolt', 'Stud / Anchor')
        AND msg.diameter_mm IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM raw_bar_stock rbs
          WHERE rbs.guide_version_id = mgm.guide_version_id AND rbs.material_id = mgm.material_id AND rbs.active
        )
        AND NOT EXISTS (
          SELECT 1 FROM raw_bar_stock rbs2
          WHERE rbs2.guide_version_id = mgm.guide_version_id AND rbs2.material_id = mgm.material_id
            AND rbs2.active AND rbs2.diameter_mm >= msg.diameter_mm
        )`,
    [guideVersionId],
  );
  for (const row of rows) {
    errors.push(
      `Raw_Bar_Stock: ${row.product_family}/${row.grade_or_spec} ${row.size_label} (nominal ${row.diameter_mm}mm) — no ${row.material_name} bar stocked at or above nominal`,
    );
  }
  return errors;
}

async function runSimulationCases(guideVersionId: string): Promise<{ failures: string[]; count: number }> {
  const { rows } = await pool.query<SimulationCaseRow>(
    `SELECT simulation_id, source_key, route, input_json, expected_json
     FROM simulation_cases WHERE guide_version_id = $1 AND active`,
    [guideVersionId],
  );
  if (rows.length === 0) return { failures: [], count: 0 };

  const ctx = await loadGuideContext(guideVersionId);
  const failures: string[] = [];

  for (const row of rows) {
    const expected = row.expected_json;
    let actual: Record<string, unknown> | null = null;
    let thrownCode: string | null = null;

    try {
      if (row.route === "Custom Production") {
        actual = calculateCustomLine(ctx, row.input_json as CustomLineInput) as unknown as Record<string, unknown>;
      } else if (row.route === "Trading Pricelist") {
        actual = calculateTradingPricelistLine(
          ctx,
          row.input_json as Parameters<typeof calculateTradingPricelistLine>[1],
        ) as unknown as Record<string, unknown>;
      } else if (row.route === "Trading Quote") {
        actual = calculateTradingQuoteLine(
          ctx,
          row.input_json as Parameters<typeof calculateTradingQuoteLine>[1],
        ) as unknown as Record<string, unknown>;
      } else {
        failures.push(`${row.source_key}: unknown route "${row.route}"`);
        continue;
      }
    } catch (err) {
      thrownCode = err instanceof AppError ? err.code : "UNKNOWN_ERROR";
    }

    if (expected.resultStatus === "EXPECTED_REJECT") {
      if (thrownCode === null) {
        failures.push(`${row.source_key}: expected rejection (${expected.expectedErrorCode}) but calculation succeeded`);
      } else if (expected.expectedErrorCode && thrownCode !== expected.expectedErrorCode) {
        failures.push(`${row.source_key}: expected error ${expected.expectedErrorCode}, got ${thrownCode}`);
      }
      continue;
    }

    if (thrownCode !== null) {
      failures.push(`${row.source_key}: expected PASS but calculation threw ${thrownCode}`);
      continue;
    }

    const tolerance = expected.tolerance ?? 0.01;
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (field === "resultStatus" || field === "expectedErrorCode" || field === "tolerance") continue;
      const actualValue = actual?.[field];
      if (typeof expectedValue === "number" && typeof actualValue === "number") {
        if (Math.abs(actualValue - expectedValue) > tolerance) {
          failures.push(`${row.source_key}: ${field} expected ${expectedValue}, got ${actualValue}`);
        }
      } else if (actualValue !== expectedValue) {
        failures.push(`${row.source_key}: ${field} expected ${String(expectedValue)}, got ${String(actualValue)}`);
      }
    }
  }

  return { failures, count: rows.length };
}

/**
 * Draft -> Validated (VER-003). Runs the checks import-time schema parsing
 * doesn't cover: formula DSL soundness, non-overlapping ranges, and the
 * golden Simulation_Cases regression (VAL-029/AT-IMPORT-008). Publishing is
 * blocked until this has run and produced zero failures.
 */
export async function validateGuideVersion(
  guideVersionId: string,
  actorUserId: string,
  requestId: string,
): Promise<ValidationReport> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM guide_versions WHERE guide_version_id = $1`,
    [guideVersionId],
  );
  if (rows.length === 0) throw Errors.notFound("Guide version");
  if (rows[0].status !== "draft") {
    throw Errors.validation("Hanya versi Draft yang dapat divalidasi.");
  }

  const formulaErrors = await checkFormulas(guideVersionId);
  const rangeErrors = await checkRanges(guideVersionId);
  const duplicateKeyErrors = await checkBusinessKeyUniqueness(guideVersionId);
  const rawBarErrors = await checkRawBarAvailability(guideVersionId);
  const { failures: regressionFailures, count: simulationCasesRun } = await runSimulationCases(guideVersionId);

  const report: ValidationReport = { formulaErrors, rangeErrors, duplicateKeyErrors, rawBarErrors, regressionFailures, simulationCasesRun };
  const allErrors = [...formulaErrors, ...rangeErrors, ...duplicateKeyErrors, ...rawBarErrors, ...regressionFailures];

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE import_batches SET status = $1, validation_report = $2 WHERE guide_version_id = $3`,
      [allErrors.length === 0 ? "validated" : "rejected", JSON.stringify(report), guideVersionId],
    );
    if (allErrors.length === 0) {
      await client.query(`UPDATE guide_versions SET status = 'validated' WHERE guide_version_id = $1`, [guideVersionId]);
    }
    await writeAuditEvent(
      {
        action: allErrors.length === 0 ? "GUIDE_VALIDATED" : "GUIDE_VALIDATION_FAILED",
        entityType: "guide_versions",
        entityId: guideVersionId,
        actorUserId,
        actorRole: "super_admin",
        requestId,
        afterJson: report,
      },
      client,
    );
  });

  if (allErrors.length > 0) {
    const error =
      formulaErrors.length > 0
        ? Errors.guideFormulaInvalid(formulaErrors.join("; "))
        : rangeErrors.length > 0
          ? Errors.guideRangeInvalid(rangeErrors.join("; "))
          : duplicateKeyErrors.length > 0
            ? Errors.guideDuplicateKey(duplicateKeyErrors.join("; "))
            : rawBarErrors.length > 0
              ? Errors.guideRawBarGap(rawBarErrors.join("; "))
              : Errors.guideRegressionFailed(regressionFailures.join("; "));
    // Attached for API routes that want to show the admin the itemized
    // report rather than just the generic sanitized error message.
    throw Object.assign(error, { report });
  }

  return report;
}
