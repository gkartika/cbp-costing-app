/**
 * Regenerates the 200 Hex Bolt + 50 Hex Nut WEIGHT case studies from the
 * CURRENT (corrected) calc engine's geometry/weight logic — real
 * resolveRawBarDiameter for the material-dependent raw bar, real
 * grade_profile_rules.display_label for the detailed grade name, and the
 * exact same formula math customPipeline.ts uses.
 *
 * Deliberately does NOT require a price_per_kg row to exist: the task is a
 * WEIGHT case study, not an orderability check, and the live price catalog
 * is currently 100% metric-only for both Bolt and Nut (zero Inch rows) — an
 * earlier version of this script filtered on price_per_kg and silently
 * dropped every Inch case as a result. Candidates come from
 * material_grade_map x material_size_guides (geometry availability) instead,
 * matching the original case-study brief ("mix metric and inch").
 *
 * Kept as a reusable script (unlike one-off diagnostics) since this is the
 * second full regeneration these case studies have needed.
 */
import { pool } from "../src/lib/db";
import { getActivePublishedGuideVersionId } from "../src/lib/guide/activeGuideVersion";
import { loadGuideContext } from "../src/lib/calc/loadGuideContext";
import { resolveProfile, resolveSizeGuide, resolveRawBarDiameter, resolveEffectiveWidthCorner } from "../src/lib/calc/resolvers";
import { evaluateFormula } from "../src/lib/calc/formulaDsl";
import type { GuideContext } from "../src/lib/calc/types";
import * as fs from "fs";

const SCRATCH =
  "C:/Users/t_hut/AppData/Local/Temp/claude/C--Users-t-hut-Documents-Claude-Costing-Project/8aaeb524-e34e-4e57-8256-a9d61908c648/scratchpad";
const TOLERANCE = 0.02; // CUSTOM_WEIGHT_TOLERANCE, matches app_config in the live guide

function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function round(v: number, dp: number) {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}
function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
/** Round-robin selection by grade so the sample doesn't skew toward whichever grade has the most sizes. */
function selectRoundRobinByGrade<T extends { grade: string }>(items: T[], count: number): T[] {
  const byGrade = new Map<string, T[]>();
  for (const it of items) {
    if (!byGrade.has(it.grade)) byGrade.set(it.grade, []);
    byGrade.get(it.grade)!.push(it);
  }
  const keys = [...byGrade.keys()];
  const pointer = new Map(keys.map((k) => [k, 0]));
  const selected: T[] = [];
  let gi = 0;
  let stall = 0;
  while (selected.length < count && stall < keys.length * 2) {
    const key = keys[gi % keys.length];
    const list = byGrade.get(key)!;
    const p = pointer.get(key)!;
    if (p < list.length) {
      selected.push(list[p]);
      pointer.set(key, p + 1);
      stall = 0;
    } else {
      stall++;
    }
    gi++;
  }
  return selected;
}

type BoltCase = {
  case_id: string;
  product_family: "Bolt";
  grade_or_spec: string;
  grade_display_label: string;
  product_profile: string;
  unit_system: string;
  size_label: string;
  nominal_diameter_mm: number;
  raw_diameter_mm: number;
  width_flat_mm: number | "";
  width_corner_mm: number;
  head_thickness_mm: number;
  finished_length_mm: number;
  density_kg_m3: number;
  raw_weight_kg: number;
  costing_weight_kg: number;
  Note: string;
};

async function generateBoltCases(ctx: GuideContext, count: number): Promise<BoltCase[]> {
  const gradeProfile = ctx.gradeProfileRules.filter((r) => r.productFamily === "Bolt");
  const labelByGrade = new Map(gradeProfile.map((r) => [r.gradeOrSpec, r.displayLabel ?? r.gradeOrSpec]));
  const materialByGrade = new Map(
    ctx.materialGradeMap.filter((m) => m.productFamily === "Bolt").map((m) => [m.gradeOrSpec, m.materialId]),
  );
  const densityByMaterialId = new Map(ctx.materials.map((m) => [m.materialId, m.densityKgM3]));
  const formula = ctx.calculationFormulas.find((f) => f.productFamily === "Bolt" && f.formulaScope === "raw_cut_weight_per_item");
  if (!formula) throw new Error("No Bolt raw_cut_weight_per_item formula");

  const rand = mulberry32(20260825);
  const candidates: { grade: string; profile: string; sizeLabel: string; rawDiameterMm: number }[] = [];
  for (const g of gradeProfile) {
    const materialId = materialByGrade.get(g.gradeOrSpec);
    if (!materialId) continue;
    for (const sz of ctx.materialSizeGuides) {
      if (sz.productProfile !== g.defaultProductProfile) continue;
      if (sz.diameterMm === null || sz.headThickness === null) continue;
      if (sz.widthFlat === null && sz.widthCorner === null) continue;
      // Pre-filter to combos that actually have a stockable raw bar -- a real sourcing gap
      // (DEC-039) is not a real case, not just a to-be-skipped one.
      try {
        const { rawDiameterMm } = resolveRawBarDiameter(ctx, materialId, sz.diameterMm, sz.rawDiameterMm);
        candidates.push({ grade: g.gradeOrSpec, profile: sz.productProfile, sizeLabel: sz.sizeLabel, rawDiameterMm });
      } catch {
        continue;
      }
    }
  }
  const selected = selectRoundRobinByGrade(shuffle(candidates, rand), count);

  const cases: BoltCase[] = [];
  let n = 0;
  for (const c of selected) {
    const materialId = materialByGrade.get(c.grade)!;
    const density = densityByMaterialId.get(materialId)!;
    const { profile } = resolveProfile(ctx, "Bolt", c.grade);
    const { row: sizeGuide } = resolveSizeGuide(ctx, profile, c.sizeLabel);
    if (sizeGuide.diameterMm === null || sizeGuide.headThickness === null) continue;
    const rawDiameterMm = c.rawDiameterMm;
    const widthCorner = resolveEffectiveWidthCorner(sizeGuide);

    const lengthMm = Math.max(20, Math.round((sizeGuide.diameterMm * (2 + rand() * 8)) / 5) * 5);

    const env = evaluateFormula(formula.formulaExpression, {
      raw_diameter: rawDiameterMm,
      width_corner: sizeGuide.widthCorner ?? (null as unknown as number),
      width_flat: sizeGuide.widthFlat ?? (null as unknown as number),
      head_thickness: sizeGuide.headThickness,
      finished_length: lengthMm,
      density,
    });
    const rawWeight = env.raw_weight as number;
    if (typeof rawWeight !== "number" || !Number.isFinite(rawWeight) || rawWeight <= 0) continue;

    n++;
    cases.push({
      case_id: "BOLT-CASE-" + String(n).padStart(3, "0"),
      product_family: "Bolt",
      grade_or_spec: c.grade,
      grade_display_label: labelByGrade.get(c.grade) ?? c.grade,
      product_profile: profile,
      unit_system: c.sizeLabel.startsWith("M") ? "Metric" : "Inch",
      size_label: c.sizeLabel,
      nominal_diameter_mm: round(sizeGuide.diameterMm, 4),
      raw_diameter_mm: round(rawDiameterMm, 4),
      width_flat_mm: sizeGuide.widthFlat !== null ? round(sizeGuide.widthFlat, 4) : "",
      width_corner_mm: round(widthCorner, 4),
      head_thickness_mm: round(sizeGuide.headThickness, 4),
      finished_length_mm: round(lengthMm, 4),
      density_kg_m3: density,
      raw_weight_kg: round(rawWeight, 6),
      costing_weight_kg: round(rawWeight * (1 + TOLERANCE), 6),
      Note: "",
    });
  }
  return cases;
}

type NutCase = {
  case_id: string;
  product_family: "Nut";
  grade_or_spec: string;
  grade_display_label: string;
  product_profile: string;
  unit_system: string;
  size_label: string;
  diameter_mm: number;
  width_flat_mm: number | "";
  width_corner_mm: number | "";
  thickness_mm: number;
  forging_id_mm: number;
  density_kg_m3: number;
  raw_weight_kg: number;
  costing_weight_kg: number;
};

async function generateNutCases(ctx: GuideContext, count: number): Promise<NutCase[]> {
  const gradeProfile = ctx.gradeProfileRules.filter((r) => r.productFamily === "Nut");
  const labelByGrade = new Map(gradeProfile.map((r) => [r.gradeOrSpec, r.displayLabel ?? r.gradeOrSpec]));
  const materialByGrade = new Map(
    ctx.materialGradeMap.filter((m) => m.productFamily === "Nut").map((m) => [m.gradeOrSpec, m.materialId]),
  );
  const densityByMaterialId = new Map(ctx.materials.map((m) => [m.materialId, m.densityKgM3]));
  const formula = ctx.calculationFormulas.find((f) => f.productFamily === "Nut" && f.formulaScope === "raw_cut_weight_per_item");
  if (!formula) throw new Error("No Nut raw_cut_weight_per_item formula");

  const rand = mulberry32(20260825);
  const candidates: { grade: string; profile: string; sizeLabel: string }[] = [];
  for (const g of gradeProfile) {
    if (!materialByGrade.has(g.gradeOrSpec)) continue;
    for (const sz of ctx.materialSizeGuides) {
      if (sz.productProfile !== g.defaultProductProfile) continue;
      if (sz.diameterMm === null) continue;
      if (sz.widthFlat === null && sz.widthCorner === null) continue;
      candidates.push({ grade: g.gradeOrSpec, profile: sz.productProfile, sizeLabel: sz.sizeLabel });
    }
  }
  const selected = selectRoundRobinByGrade(shuffle(candidates, rand), count);

  const cases: NutCase[] = [];
  let n = 0;
  for (const c of selected) {
    const materialId = materialByGrade.get(c.grade)!;
    const density = densityByMaterialId.get(materialId)!;
    const { profile } = resolveProfile(ctx, "Nut", c.grade);
    const { row: sizeGuide } = resolveSizeGuide(ctx, profile, c.sizeLabel);
    if (sizeGuide.diameterMm === null) continue;

    const env = evaluateFormula(formula.formulaExpression, {
      profile,
      diameter: sizeGuide.diameterMm,
      width_corner: sizeGuide.widthCorner ?? (null as unknown as number),
      width_flat: sizeGuide.widthFlat ?? (null as unknown as number),
      density,
    });
    const rawWeight = env.raw_weight as number;
    if (typeof rawWeight !== "number" || !Number.isFinite(rawWeight) || rawWeight <= 0) continue;

    const diameter = sizeGuide.diameterMm;
    const thickness = profile === "Heavy Hex" ? diameter : 0.8 * diameter;
    const forgingId = diameter < 20 ? 0 : 0.85 * diameter;

    n++;
    cases.push({
      case_id: "NUT-CASE-" + String(n).padStart(3, "0"),
      product_family: "Nut",
      grade_or_spec: c.grade,
      grade_display_label: labelByGrade.get(c.grade) ?? c.grade,
      product_profile: profile,
      unit_system: c.sizeLabel.startsWith("M") ? "Metric" : "Inch",
      size_label: c.sizeLabel,
      diameter_mm: round(diameter, 4),
      width_flat_mm: sizeGuide.widthFlat !== null ? round(sizeGuide.widthFlat, 4) : "",
      width_corner_mm: sizeGuide.widthCorner !== null ? round(sizeGuide.widthCorner, 4) : "",
      thickness_mm: round(thickness, 4),
      forging_id_mm: round(forgingId, 4),
      density_kg_m3: density,
      raw_weight_kg: round(rawWeight, 6),
      costing_weight_kg: round(rawWeight * (1 + TOLERANCE), 6),
    });
  }
  return cases;
}

async function main() {
  const guideVersionId = await getActivePublishedGuideVersionId();
  if (!guideVersionId) throw new Error("No published guide version");
  console.log("Published guide_version_id:", guideVersionId);
  const ctx = await loadGuideContext(guideVersionId);

  const boltCases = await generateBoltCases(ctx, 200);
  console.log(`Generated ${boltCases.length} Bolt cases.`);
  const byGrade: Record<string, number> = {};
  const byUnit: Record<string, number> = {};
  boltCases.forEach((c) => {
    byGrade[c.grade_or_spec] = (byGrade[c.grade_or_spec] || 0) + 1;
    byUnit[c.unit_system] = (byUnit[c.unit_system] || 0) + 1;
  });
  console.log("Bolt by grade:", byGrade);
  console.log("Bolt by unit:", byUnit);

  const nutCases = await generateNutCases(ctx, 50);
  console.log(`Generated ${nutCases.length} Nut cases.`);
  const byGradeNut: Record<string, number> = {};
  const byUnitNut: Record<string, number> = {};
  nutCases.forEach((c) => {
    byGradeNut[c.grade_or_spec] = (byGradeNut[c.grade_or_spec] || 0) + 1;
    byUnitNut[c.unit_system] = (byUnitNut[c.unit_system] || 0) + 1;
  });
  console.log("Nut by grade:", byGradeNut);
  console.log("Nut by unit:", byUnitNut);

  fs.mkdirSync(SCRATCH, { recursive: true });
  fs.writeFileSync(SCRATCH + "/bolt_200_cases.json", JSON.stringify(boltCases, null, 2));
  fs.writeFileSync(SCRATCH + "/nut_50_cases.json", JSON.stringify(nutCases, null, 2));
  console.log("Written to", SCRATCH);

  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
