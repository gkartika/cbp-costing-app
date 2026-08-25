/**
 * Rebuilds Material_Master and Raw_Material_Guide for CBP's real stock reality:
 *
 *  - Round bar in METRIC comes as SCM440 / S45C / ST41 / Carbon Steel.
 *  - Round bar in INCH comes as stainless (SUS304/304L/316/316L/310), 3/8" to 3"
 *    in 1/8" steps, converted to mm so every downstream size lookup stays metric.
 *  - Plate comes as SS400 / 65Mn / SS304 / SS316 / SS310 in 8 standard thicknesses.
 *
 * Bar weight uses the guide's existing formula, verified against the current
 * rows: PI*(d/2)^2 * bar_length * density / 1e9, rounded to 2dp
 * (RAW-D13 -> 6.26, RAW-D100 -> 369.93).
 */
import { writeFileSync } from "fs";

const DENSITY = 7850; // kg/m3 — CBP's sheet uses one density for every alloy
const BAR_LENGTH_MM = 6000;

/** Existing metric round-bar stock diameters already in Raw_Material_Guide. */
const METRIC_BAR_MM = [
  13, 16, 18, 19, 20, 22, 25, 28, 30, 32, 35, 38, 40, 42, 45, 48, 50, 55, 60, 65, 70, 75, 80, 85, 90, 100,
];

/** Stainless round bar: 3/8" to 3" in 1/8" steps. */
const INCH_BAR: { label: string; inches: number }[] = (() => {
  const eighths = ["", "1/8", "1/4", "3/8", "1/2", "5/8", "3/4", "7/8"];
  const out: { label: string; inches: number }[] = [];
  for (let n = 3; n <= 24; n++) {
    const whole = Math.floor(n / 8);
    const rem = n % 8;
    const label = whole === 0 ? eighths[rem] : rem === 0 ? String(whole) : `${whole}-${eighths[rem]}`;
    out.push({ label: `${label}"`, inches: n / 8 });
  }
  return out;
})();

const PLATE_THICKNESS_MM = [2, 3, 4, 5, 6, 7, 8, 10];

const METRIC_BAR_MATERIALS = [
  { id: "MAT-SCM440", name: "SCM440" },
  { id: "MAT-S45C", name: "S45C" },
  { id: "MAT-CARBON-STEEL", name: "Carbon Steel" },
];

/**
 * ST41 ("besi AS putih") is stocked in Indonesia in a mixed mm/inch range, not
 * the plain metric ladder the other carbon/alloy bars follow. Sizes taken from
 * solusibaja.co.id/besi-as-st41-as-putih.
 *
 * Note: that supplier also publishes its own per-bar weights, which run ~0.5-2%
 * above the pure geometric figure (e.g. 1" listed as 24 kg vs 23.87 computed,
 * 3" as 216 kg vs 214.80). We keep the geometric formula here so every row in
 * this guide stays on one basis; the supplier's commercial weights are noted
 * against each size below if CBP would rather cost on those.
 */
const ST41_SIZES: { unit: "Metric" | "Inch"; label: string; mm: number; supplierKg: number }[] = [
  { unit: "Metric", label: "D5", mm: 5, supplierKg: 0.95 },
  { unit: "Metric", label: "D6", mm: 6, supplierKg: 1.35 },
  { unit: "Inch", label: '1/4"', mm: 6.35, supplierKg: 1.5 },
  { unit: "Metric", label: "D7", mm: 7, supplierKg: 1.85 },
  { unit: "Metric", label: "D8", mm: 8, supplierKg: 2.4 },
  { unit: "Metric", label: "D9", mm: 9, supplierKg: 3 },
  { unit: "Inch", label: '3/8"', mm: 9.53, supplierKg: 3.4 },
  { unit: "Metric", label: "D10", mm: 10, supplierKg: 3.7 },
  { unit: "Metric", label: "D11", mm: 11, supplierKg: 4.5 },
  { unit: "Metric", label: "D12", mm: 12, supplierKg: 5.35 },
  { unit: "Inch", label: '1/2"', mm: 12.7, supplierKg: 6 },
  { unit: "Metric", label: "D13", mm: 13, supplierKg: 6.3 },
  { unit: "Metric", label: "D14", mm: 14, supplierKg: 7.3 },
  { unit: "Metric", label: "D15", mm: 15, supplierKg: 8.35 },
  { unit: "Inch", label: '5/8"', mm: 15.88, supplierKg: 9.5 },
  { unit: "Metric", label: "D16", mm: 16, supplierKg: 10.8 },
  { unit: "Metric", label: "D17", mm: 17, supplierKg: 12 },
  { unit: "Inch", label: '3/4"', mm: 19.05, supplierKg: 13.5 },
  { unit: "Metric", label: "D20", mm: 20, supplierKg: 15 },
  { unit: "Metric", label: "D22", mm: 22, supplierKg: 18 },
  { unit: "Inch", label: '7/8"', mm: 22.23, supplierKg: 18.375 },
  { unit: "Metric", label: "D25", mm: 25, supplierKg: 23.5 },
  { unit: "Inch", label: '1"', mm: 25.4, supplierKg: 24 },
  { unit: "Inch", label: '1-1/8"', mm: 28.58, supplierKg: 30.375 },
  { unit: "Metric", label: "D30", mm: 30, supplierKg: 33.5 },
  { unit: "Inch", label: '1-1/4"', mm: 31.75, supplierKg: 37.5 },
  { unit: "Metric", label: "D35", mm: 35, supplierKg: 45.6 },
  { unit: "Metric", label: "D38", mm: 38, supplierKg: 54 },
  { unit: "Inch", label: '1-1/2"', mm: 38.1, supplierKg: 54 },
  { unit: "Metric", label: "D40", mm: 40, supplierKg: 59.5 },
  { unit: "Inch", label: '1-3/4"', mm: 44.45, supplierKg: 73.5 },
  { unit: "Inch", label: '2"', mm: 50.8, supplierKg: 96 },
  { unit: "Inch", label: '2-1/4"', mm: 57.15, supplierKg: 121.5 },
  { unit: "Inch", label: '2-1/2"', mm: 63.5, supplierKg: 150 },
  { unit: "Inch", label: '3"', mm: 76.2, supplierKg: 216 },
];

const INCH_BAR_MATERIALS = [
  { id: "MAT-SUS304", name: "SUS304" },
  { id: "MAT-SUS304L", name: "SUS304L" },
  { id: "MAT-SUS316", name: "SUS316" },
  { id: "MAT-SUS316L", name: "SUS316L" },
  { id: "MAT-SUS310", name: "SUS310" },
];

const PLATE_MATERIALS = [
  { id: "MAT-PLATE-SS400", name: "SS400" },
  { id: "MAT-PLATE-65MN", name: "65Mn" },
  { id: "MAT-PLATE-SS304", name: "SS304" },
  { id: "MAT-PLATE-SS316", name: "SS316" },
  { id: "MAT-PLATE-SS310", name: "SS310" },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
/**
 * The existing 26 rows all round UP to 2dp, not to nearest — verified against
 * every one of them (round-half only reproduces 8/26). Same ceiling convention
 * CBP uses for prices.
 */
const ceil2 = (n: number) => Math.ceil(n * 100) / 100;
const barWeightKg = (diameterMm: number) =>
  ceil2((Math.PI * (diameterMm / 2) ** 2 * BAR_LENGTH_MM * DENSITY) / 1e9);
/** Plate is priced per area, so weight is given per m2 rather than per stock bar. */
const plateWeightPerM2 = (thicknessMm: number) => ceil2((thicknessMm / 1000) * DENSITY);

function slug(s: string) {
  return s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toUpperCase();
}

// ---------- Material_Master ----------
const MATERIAL_MASTER_HEADERS = ["material_id", "material_name", "form", "density_kg_m3", "active", "notes"];
const materialMaster: (string | number | boolean)[][] = [
  ...METRIC_BAR_MATERIALS.map((m) => [
    m.id,
    m.name,
    "Round Bar",
    DENSITY,
    true,
    "Metric round bar stock",
  ]),
  ["MAT-ST41", "ST41", "Round Bar", DENSITY, true, "Round bar (besi AS putih); stocked in mixed mm and inch sizes"],
  ...INCH_BAR_MATERIALS.map((m) => [
    m.id,
    m.name,
    "Round Bar",
    DENSITY,
    true,
    "Stainless round bar; stocked in inch sizes, converted to mm",
  ]),
  ...PLATE_MATERIALS.map((m) => [
    m.id,
    m.name,
    "Plate",
    DENSITY,
    true,
    m.name === "SS400"
      ? "Plate stock; JIS equivalent of ASTM A36 structural steel"
      : "Plate stock",
  ]),
];

// ---------- Raw_Material_Guide ----------
const RAW_GUIDE_HEADERS = [
  "raw_size_id",
  "material_id",
  "material_name",
  "form",
  "unit_system",
  "size_label",
  "diameter_mm",
  "thickness_mm",
  "bar_length_mm",
  "bar_weight_kg",
  "weight_kg_per_m2",
  "active",
];

const rawGuide: (string | number | boolean)[][] = [];

for (const m of METRIC_BAR_MATERIALS) {
  for (const d of METRIC_BAR_MM) {
    rawGuide.push([
      `RAW-${slug(m.name)}-RB-D${d}`,
      m.id,
      m.name,
      "Round Bar",
      "Metric",
      `D${d}`,
      d,
      "",
      BAR_LENGTH_MM,
      barWeightKg(d),
      "",
      true,
    ]);
  }
}

for (const s of ST41_SIZES) {
  rawGuide.push([
    `RAW-ST41-RB-${slug(s.label)}`,
    "MAT-ST41",
    "ST41",
    "Round Bar",
    s.unit,
    s.label,
    s.mm,
    "",
    BAR_LENGTH_MM,
    barWeightKg(s.mm),
    "",
    true,
  ]);
}

for (const m of INCH_BAR_MATERIALS) {
  for (const s of INCH_BAR) {
    const mm = round2(s.inches * 25.4);
    rawGuide.push([
      `RAW-${slug(m.name)}-RB-${slug(s.label)}`,
      m.id,
      m.name,
      "Round Bar",
      "Inch",
      s.label,
      mm,
      "",
      BAR_LENGTH_MM,
      barWeightKg(mm),
      "",
      true,
    ]);
  }
}

for (const m of PLATE_MATERIALS) {
  for (const t of PLATE_THICKNESS_MM) {
    rawGuide.push([
      `RAW-${slug(m.name)}-PL-T${t}`,
      m.id,
      m.name,
      "Plate",
      "Metric",
      `T${t}`,
      "",
      t,
      "",
      "",
      plateWeightPerM2(t),
      true,
    ]);
  }
}

const tsv = (rows: (string | number | boolean)[][]) =>
  rows.map((r) => r.map((v) => String(v)).join("\t")).join("\n");

const out = process.argv[2] ?? ".";
writeFileSync(`${out}/material_master.tsv`, tsv(materialMaster), "utf8");
writeFileSync(`${out}/material_master_headers.tsv`, MATERIAL_MASTER_HEADERS.join("\t"), "utf8");
writeFileSync(`${out}/raw_material_guide.tsv`, tsv(rawGuide), "utf8");
writeFileSync(`${out}/raw_material_guide_headers.tsv`, RAW_GUIDE_HEADERS.join("\t"), "utf8");

console.log(`Material_Master rows: ${materialMaster.length}`);
console.log(`Raw_Material_Guide rows: ${rawGuide.length}`);
console.log(`  metric round bar: ${METRIC_BAR_MATERIALS.length} x ${METRIC_BAR_MM.length} = ${METRIC_BAR_MATERIALS.length * METRIC_BAR_MM.length}`);
console.log(`  inch round bar:   ${INCH_BAR_MATERIALS.length} x ${INCH_BAR.length} = ${INCH_BAR_MATERIALS.length * INCH_BAR.length}`);
console.log(`  plate:            ${PLATE_MATERIALS.length} x ${PLATE_THICKNESS_MM.length} = ${PLATE_MATERIALS.length * PLATE_THICKNESS_MM.length}`);
console.log("\ninch sizes:", INCH_BAR.map((s) => `${s.label}=${round2(s.inches * 25.4)}mm`).join(", "));
console.log("\nweight formula check (must match existing rows):");
for (const d of [13, 100]) console.log(`  D${d} -> ${barWeightKg(d)} kg`);
