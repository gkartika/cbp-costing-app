/**
 * Fills the low-end price_per_kg gaps found while auditing the Nut A563 bug
 * report (2026-09-04): several grades across Bolt, Nut and Stud/Anchor have
 * no rate-card row below some diameter — Nut 4.6/A563 start at M27, Bolt
 * 6.8/A307B start at M20, and so on (full list in docs/GO-LIVE.md's "what to
 * watch" section).
 *
 * resolvePricePerKg already handles a missing size at runtime: it falls back
 * to the same grade's smallest priced size at or above the one requested.
 * This script does not invent a different number — it stages a real
 * price_per_kg row at each missing size, priced at exactly what that
 * fallback already returns today (the group's globally smallest-diameter
 * row, metric or inch, whichever is actually smaller). The only thing that
 * changes is that the quote stops carrying a "used a bigger size instead"
 * note, because there is no longer a substitution to explain.
 *
 * A "group" is one (product_family, grade_or_spec, thread_condition,
 * product_type) combination — the same dimensions resolvePricePerKg narrows
 * on, so Bolt's HT and FT rows and Stud/Anchor's Stud-vs-Anchor rows are
 * filled independently rather than conflated.
 *
 * Goes through the app's own master-data pipeline (stagePendingChange ->
 * publishPendingChangesForTable), not a direct UPDATE: the new guide version
 * is cloned forward, then validated (formulas, ranges, duplicate business
 * keys, raw bar coverage, all 54 golden simulation cases) before publishing,
 * exactly like an edit made through Master Data in the app. If validation
 * fails, nothing is published and the staged rows stay pending.
 *
 * Usage:
 *   npm run fill:price-gaps -- --dry-run   # show the plan, stage nothing
 *   npm run fill:price-gaps                # stage every row, then publish
 */
import { pool } from "../src/lib/db";
import { stagePendingChange, publishPendingChangesForTable } from "../src/lib/masterdata/pendingChanges";

const FAMILIES = ["Bolt", "Nut", "Stud / Anchor"];

type Row = {
  productFamily: string;
  gradeOrSpec: string;
  productType: string | null;
  threadCondition: string | null;
  material: string | null;
  sizeLabel: string;
  diameterMm: number;
  sellingPricePerKg: number;
  currency: string;
};

function metricDiameter(sizeLabel: string): number | null {
  const m = sizeLabel.match(/^M(\d+(?:\.\d+)?)$/);
  return m ? Number(m[1]) : null;
}

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
  const dryRun = process.argv.includes("--dry-run");

  const { rows: gvRows } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  if (gvRows.length === 0) throw new Error("No published guide version.");
  const guideVersionId = gvRows[0].guide_version_id;

  const { rows: raw } = await pool.query<{
    product_family: string;
    grade_or_spec: string;
    product_type: string | null;
    thread_condition: string | null;
    material: string | null;
    size_label: string;
    diameter_mm: string;
    selling_price_per_kg: string;
    currency: string;
  }>(
    `SELECT product_family, grade_or_spec, product_type, thread_condition, material,
            size_label, diameter_mm, selling_price_per_kg, currency
     FROM price_per_kg
     WHERE active AND guide_version_id = $1 AND product_family = ANY($2::text[]) AND diameter_mm IS NOT NULL`,
    [guideVersionId, FAMILIES],
  );
  const rows: Row[] = raw.map((r) => ({
    productFamily: r.product_family,
    gradeOrSpec: r.grade_or_spec,
    productType: r.product_type,
    threadCondition: r.thread_condition,
    material: r.material,
    sizeLabel: r.size_label,
    diameterMm: Number(r.diameter_mm),
    sellingPricePerKg: Number(r.selling_price_per_kg),
    currency: r.currency,
  }));

  // "Full coverage" for a family = the union of every metric diameter any
  // grade in that family actually prices — the same definition the audit
  // that found these gaps used.
  const fullMetricByFamily = new Map<string, number[]>();
  for (const fam of FAMILIES) {
    const dias = new Set<number>();
    for (const r of rows) {
      if (r.productFamily === fam && metricDiameter(r.sizeLabel) !== null) dias.add(r.diameterMm);
    }
    fullMetricByFamily.set(fam, [...dias].sort((a, b) => a - b));
  }

  const groupKey = (r: Row) =>
    `${r.productFamily}${r.gradeOrSpec}${r.threadCondition ?? ""}${r.productType ?? ""}`;
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = groupKey(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }

  const fills: { group: Row[]; missingDiameters: number[] }[] = [];
  for (const group of groups.values()) {
    const fullMetric = fullMetricByFamily.get(group[0].productFamily)!;
    // Gap detection must look at METRIC rows only. Bolt and Nut both carry a
    // full Inch range down to 1/4" (6.35mm) alongside their Metric rows, so
    // the group's overall smallest diameter is nearly always an Inch row —
    // using that to decide "is M20 missing" would hide every Metric gap
    // behind Inch coverage that was never meant to stand in for it.
    const metricRows = group.filter((r) => metricDiameter(r.sizeLabel) !== null);
    if (metricRows.length === 0) continue; // no metric rows in this group at all — nothing to compare against
    const metricMinDiameter = Math.min(...metricRows.map((r) => r.diameterMm));
    const missing = fullMetric.filter((d) => d < metricMinDiameter);
    if (missing.length > 0) fills.push({ group, missingDiameters: missing });
  }

  if (fills.length === 0) {
    console.log("No low-end gaps found — nothing to fill.");
    await pool.end();
    return;
  }

  const totalRows = fills.reduce((s, f) => s + f.missingDiameters.length, 0);
  console.log(`${fills.length} groups have a low-end gap, ${totalRows} rows to add.\n`);

  const actorUserId = dryRun ? "" : await resolveActorUserId();
  let staged = 0;

  for (const { group, missingDiameters } of fills) {
    // Whichever existing row in this exact group has the smallest diameter
    // overall (metric or inch) is the row resolvePricePerKg's fallback
    // already returns for every one of these missing sizes today.
    const floor = group.reduce((min, r) => (r.diameterMm < min.diameterMm ? r : min));
    const label = `${floor.productFamily}/${floor.gradeOrSpec}${floor.threadCondition ? `/${floor.threadCondition}` : ""}${floor.productType ? `/${floor.productType}` : ""}`;

    for (const d of missingDiameters.sort((a, b) => a - b)) {
      const sizeLabel = `M${d}`;
      const sourceKey = [
        "PKG-GAPFILL",
        floor.productFamily.replace(/[^A-Za-z0-9]+/g, "-"),
        sizeLabel,
        floor.threadCondition ?? "",
        (floor.productType ?? "").replace(/[^A-Za-z0-9]+/g, "-"),
        "GRADE",
        floor.gradeOrSpec.replace(/[^A-Za-z0-9]+/g, "-"),
      ]
        .filter(Boolean)
        .join("-");

      console.log(
        `  ${label.padEnd(42)} ${sizeLabel.padEnd(6)} <- Rp${floor.sellingPricePerKg}/kg (from ${floor.sizeLabel}, ${floor.diameterMm}mm)`,
      );

      if (!dryRun) {
        await stagePendingChange({
          tableName: "price_per_kg",
          operation: "create",
          sourceKey,
          fields: {
            product_family: floor.productFamily,
            grade_or_spec: floor.gradeOrSpec,
            product_type: floor.productType,
            thread_condition: floor.threadCondition,
            material: floor.material,
            unit_system: "Metric",
            size_label: sizeLabel,
            diameter_mm: d,
            selling_price_per_kg: floor.sellingPricePerKg,
            currency: floor.currency,
          },
          reason:
            `Gap fill 2026-09-04: this grade had no price below ${floor.sizeLabel} (${floor.diameterMm}mm). ` +
            `Filled at the same rate resolvePricePerKg's next-bigger-size fallback already returns for ${sizeLabel} — ` +
            `no new number, just an explicit row instead of an implicit substitution.`,
          actorUserId,
          actorRole: "super_admin",
          requestId: `script-fill-price-gaps-${Date.now()}`,
        });
        staged++;
      }
    }
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing staged. Re-run without the flag to stage and publish.");
    await pool.end();
    return;
  }

  console.log(`\nStaged ${staged} rows. Publishing (clones forward, then validates + runs the golden simulation cases)...`);
  const result = await publishPendingChangesForTable(
    "price_per_kg",
    actorUserId,
    `script-fill-price-gaps-publish-${Date.now()}`,
  );
  console.log(`Published as guide version ${result.guideVersionId}.`);
  console.log(`Golden simulation cases run: ${result.report.simulationCasesRun}, failures: ${result.report.regressionFailures.length}.`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
