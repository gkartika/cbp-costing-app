import { pool } from "../src/lib/db";
import { getActivePublishedGuideVersionId } from "../src/lib/guide/activeGuideVersion";
import * as fs from "fs";

const SCRATCH =
  "C:/Users/t_hut/AppData/Local/Temp/claude/C--Users-t-hut-Claude-Costing-Project/fe949997-6037-4d76-90da-f77e3da09695/scratchpad";

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

async function main() {
  const guideVersionId = await getActivePublishedGuideVersionId();

  const { rows: gradeProfile } = await pool.query<{ grade_or_spec: string; default_product_profile: string }>(
    `SELECT grade_or_spec, default_product_profile FROM grade_profile_rules
     WHERE guide_version_id = $1 AND product_family = 'Nut' AND active`,
    [guideVersionId],
  );
  const { rows: gradeMap } = await pool.query<{ grade_or_spec: string; material_id: string }>(
    `SELECT grade_or_spec, material_id FROM material_grade_map
     WHERE guide_version_id = $1 AND product_family = 'Nut' AND active`,
    [guideVersionId],
  );
  const { rows: materials } = await pool.query<{ material_id: string; density_kg_m3: string }>(
    `SELECT material_id, density_kg_m3 FROM materials WHERE guide_version_id = $1 AND active`,
    [guideVersionId],
  );
  const { rows: sizeGuides } = await pool.query<{
    product_profile: string;
    unit_system: string;
    size_label: string;
    diameter_mm: string;
    width_flat: string | null;
    width_corner: string | null;
  }>(
    `SELECT product_profile, unit_system, size_label, diameter_mm, width_flat, width_corner
     FROM material_size_guides
     WHERE guide_version_id = $1 AND active
       AND (product_profile = 'Regular Hex' OR product_profile = 'Heavy Hex')
       AND diameter_mm IS NOT NULL
       AND (width_flat IS NOT NULL OR width_corner IS NOT NULL)`,
    [guideVersionId],
  );

  const densityByMaterialId = new Map(materials.map((m) => [m.material_id, Number(m.density_kg_m3)]));
  const materialByGrade = new Map(gradeMap.map((m) => [m.grade_or_spec, m.material_id]));

  const nutGrades = gradeProfile
    .map((g) => {
      const materialId = materialByGrade.get(g.grade_or_spec);
      if (!materialId) return null;
      const density = densityByMaterialId.get(materialId);
      if (!density) return null;
      return { grade: g.grade_or_spec, profile: g.default_product_profile, materialId, density };
    })
    .filter((g): g is NonNullable<typeof g> => g !== null);

  console.log("Nut grades usable:", nutGrades.length, nutGrades.map((g) => `${g.grade}(${g.profile})`).join(", "));
  console.log("Usable size guide rows:", sizeGuides.length);

  const rand = mulberry32(99887766);
  const combos: Array<{ grade: (typeof nutGrades)[number]; size: (typeof sizeGuides)[number] }> = [];
  for (const g of nutGrades) {
    for (const sz of sizeGuides.filter((r) => r.product_profile === g.profile)) {
      combos.push({ grade: g, size: sz });
    }
  }
  console.log("Total possible combos:", combos.length);

  for (let i = combos.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [combos[i], combos[j]] = [combos[j], combos[i]];
  }

  const byGrade = new Map<string, typeof combos>();
  for (const c of combos) {
    const key = c.grade.grade;
    if (!byGrade.has(key)) byGrade.set(key, []);
    byGrade.get(key)!.push(c);
  }
  const gradeKeys = [...byGrade.keys()];
  const selected: typeof combos = [];
  const pointer = new Map(gradeKeys.map((k) => [k, 0]));
  let gi = 0;
  while (selected.length < 50 && gi < 2000) {
    const key = gradeKeys[gi % gradeKeys.length];
    const list = byGrade.get(key)!;
    const p = pointer.get(key)!;
    if (p < list.length) {
      selected.push(list[p]);
      pointer.set(key, p + 1);
    }
    gi++;
  }
  console.log("Selected combos:", selected.length);

  const rows = selected.map((c, i) => {
    const r = c.size;
    const diameter = Number(r.diameter_mm);
    const widthFlat = r.width_flat !== null ? Number(r.width_flat) : null;
    const widthCorner = r.width_corner !== null ? Number(r.width_corner) : null;
    const corner = widthCorner ?? widthFlat! * 1.154;

    const thickness = c.grade.profile === "Heavy Hex" ? diameter : 0.8 * diameter;
    const forgingId = diameter < 20 ? 0 : 0.85 * diameter;

    const volume = Math.PI * ((corner / 2) ** 2 - (forgingId / 2) ** 2) * thickness;
    const rawWeight = (volume * c.grade.density) / 1e9;
    const costingWeight = rawWeight * 1.02;

    return {
      case_id: "NUT-CASE-" + String(i + 1).padStart(3, "0"),
      product_family: "Nut",
      grade_or_spec: c.grade.grade,
      product_profile: r.product_profile,
      unit_system: r.unit_system,
      size_label: r.size_label,
      diameter_mm: round(diameter, 4),
      width_flat_mm: widthFlat !== null ? round(widthFlat, 4) : "",
      width_corner_mm: widthCorner !== null ? round(widthCorner, 4) : "",
      thickness_mm: round(thickness, 4),
      forging_id_mm: round(forgingId, 4),
      density_kg_m3: c.grade.density,
      raw_weight_kg: round(rawWeight, 6),
      costing_weight_kg: round(costingWeight, 6),
    };
  });

  const byProfile: Record<string, number> = {};
  const byUnit: Record<string, number> = {};
  const byGradeCount: Record<string, number> = {};
  rows.forEach((r) => {
    byProfile[r.product_profile] = (byProfile[r.product_profile] || 0) + 1;
    byUnit[r.unit_system] = (byUnit[r.unit_system] || 0) + 1;
    byGradeCount[r.grade_or_spec] = (byGradeCount[r.grade_or_spec] || 0) + 1;
  });
  console.log("By profile:", byProfile);
  console.log("By unit:", byUnit);
  console.log("By grade:", byGradeCount);

  fs.writeFileSync(SCRATCH + "/nut_50_cases.json", JSON.stringify(rows, null, 2));
  console.log("Sample:", JSON.stringify(rows[0], null, 2));
  console.log("Total rows:", rows.length);

  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
