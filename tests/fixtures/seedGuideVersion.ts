import { pool } from "../../src/lib/db";
import { generateId } from "../../src/lib/ids";

/**
 * Seeds one Published guide_version with a representative slice of the CBP
 * data inventory, inserted directly (bypassing XLSX import) so calculation
 * engine tests can run against real master data without depending on the
 * import pipeline. Bolt (A325/M14), Stud (B7) and Anchor (A307B) values are
 * taken verbatim from the data inventory's Simulation_Cases tab and are
 * expected to match its golden outputs exactly. Nut and Washer(A36/F35)
 * dimensions were not fully captured from the source spreadsheet, so those
 * rows use self-consistent representative numbers — sufficient to prove the
 * formula/pipeline mechanics, not a byte-exact replica of CBP's real guide.
 */
export async function seedGuideVersion(versionCode: string): Promise<string> {
  // Mirror the real single-active-version invariant (publishGuideVersion.ts):
  // tests across files share one test database and don't truncate guide
  // tables between files, so without this, whichever version the
  // `WHERE status = 'published' LIMIT 1` calculate-route query happens to
  // pick could belong to a different test file's fixture entirely.
  await pool.query(`UPDATE guide_versions SET status = 'retired' WHERE status = 'published'`);

  const guideVersionId = generateId("gv");
  await pool.query(
    `INSERT INTO guide_versions (guide_version_id, version_code, status, effective_from)
     VALUES ($1, $2, 'published', now())`,
    [guideVersionId, versionCode],
  );

  await insertAppConfig(guideVersionId);
  await insertMaterials(guideVersionId);
  await insertRawBarStock(guideVersionId);
  await insertDiesCostGuides(guideVersionId);
  await insertMinimumPrices(guideVersionId);
  await insertQuotationTerms(guideVersionId);
  await insertMaterialGradeMap(guideVersionId);
  await insertGradeProfileRules(guideVersionId);
  await insertGradePriceAliases(guideVersionId);
  await insertMaterialSizeGuides(guideVersionId);
  await insertPricePerKg(guideVersionId);
  await insertCoatingPriceGuides(guideVersionId);
  await insertAdjustmentRules(guideVersionId);
  await insertTradingItemsAndTiers(guideVersionId);
  await insertCalculationFormulas(guideVersionId);
  await insertCostingRouteRules(guideVersionId);

  return guideVersionId;
}

async function insertAppConfig(gv: string) {
  const rows: [string, string, string][] = [
    ["ROUNDING_INCREMENT", "500", "number"],
    ["CUSTOM_WEIGHT_TOLERANCE", "0.02", "percent"],
    ["TRADING_DEFAULT_MARGIN", "0.25", "percent"],
  ];
  for (const [key, value, dataType] of rows) {
    await pool.query(
      `INSERT INTO app_config (config_id, guide_version_id, config_key, config_value, data_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [generateId("cfg"), gv, key, value, dataType],
    );
  }
}

async function insertMaterials(gv: string) {
  const rows: [string, string, number][] = [
    ["MAT-SCM440", "SCM440", 7850],
    ["MAT-CARBON-STEEL", "Carbon Steel", 7850],
    ["MAT-SUS310", "SUS310", 7980], // confirmed density (researched this session)
  ];
  for (const [sourceKey, name, density] of rows) {
    await pool.query(
      `INSERT INTO materials (material_id, guide_version_id, source_key, material_name, density_kg_m3)
       VALUES ($1, $2, $3, $4, $5)`,
      [generateId("mat"), gv, sourceKey, name, density],
    );
  }
}

async function insertRawBarStock(gv: string) {
  // materialSourceKey, diameterMm, sizeCode.
  // MAT-SCM440 covers both the Bolt Heavy Hex M14 case (nominal 14 -> rounds
  // up to 18, matching the existing material_size_guides raw_diameter_mm so
  // the SIM-BOLT-QTY-* golden values are unaffected by this table's addition)
  // and the Stud/Anchor M20 case (nominal 20 -> rounds up to 22, same reason).
  // MAT-SUS310 is deliberately stocked at a DIFFERENT diameter (20, not 18)
  // than MAT-SCM440 at the same Heavy Hex/M14 row -- the regression case this
  // table exists for: raw bar diameter is material-dependent, not just
  // profile+size-dependent (DEC-039).
  const rows: [string, number, string][] = [
    ["MAT-SCM440", 18, "D18"],
    ["MAT-SCM440", 22, "D22"],
    // Covers the "1" (25.4mm nominal) Inch fixture row added for AT-SIZE-001.
    ["MAT-SCM440", 28, "D28"],
    ["MAT-SUS310", 20, "D20"],
  ];
  const materials = await pool.query<{ material_id: string; source_key: string }>(
    `SELECT material_id, source_key FROM materials WHERE guide_version_id = $1`,
    [gv],
  );
  const byKey = new Map(materials.rows.map((r) => [r.source_key, r.material_id]));
  for (const [materialSourceKey, diameterMm, sizeCode] of rows) {
    const materialId = byKey.get(materialSourceKey);
    if (!materialId) throw new Error(`Fixture error: unknown material ${materialSourceKey}`);
    await pool.query(
      `INSERT INTO raw_bar_stock (stock_id, guide_version_id, source_key, material_id, diameter_mm, size_code)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [generateId("stk"), gv, `STOCK-${materialSourceKey}-${diameterMm}`, materialId, diameterMm, sizeCode],
    );
  }
}

/**
 * Two real sizes off the CBP dies/cetakan card (2026-08-25, DEC-043) —
 * enough to exercise resolveDiesCost's "next bigger Inch entry" and
 * largest-entry-fallback behavior without replicating the whole card.
 */
async function insertDiesCostGuides(gv: string) {
  const rows: [string, string, string, number, number][] = [
    ["Bolt", "Heavy Hex", "1/2", 12.7, 3_800_000],
    ["Bolt", "Heavy Hex", "1", 25.4, 5_300_000],
    ["Bolt", "Regular Hex", "1/2", 12.7, 2_500_000],
    ["Bolt", "Regular Hex", "1", 25.4, 3_500_000],
    ["Nut", "Heavy Hex", "1/2", 12.7, 4_400_000],
    ["Nut", "Heavy Hex", "1", 25.4, 6_100_000],
  ];
  for (const [productFamily, productProfile, sizeLabel, diameterMm, cost] of rows) {
    await pool.query(
      `INSERT INTO dies_cost_guides (dies_cost_id, guide_version_id, source_key, product_family, product_profile, size_label, diameter_mm, cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [generateId("dies"), gv, `DIES-${productFamily}-${productProfile}-${sizeLabel}`.replace(/\s+/g, ""), productFamily, productProfile, sizeLabel, diameterMm, cost],
    );
  }
}

/**
 * CBP's real minimum-harga card (2026-08-25, DEC-050). The Bolt/Non-Stainless
 * floor of 15,000 sits below every existing golden fixture's computed price,
 * so adding this table does not move any pre-existing expected value; the
 * AT-MINPRICE-* tests drive the floor explicitly with a tiny qty instead.
 */
async function insertMinimumPrices(gv: string) {
  const rows: [string, string, number][] = [
    ["Bolt", "Non-Stainless", 15_000],
    ["Bolt", "Stainless", 23_500],
    ["Nut", "Non-Stainless", 12_500],
    ["Nut", "Stainless", 18_000],
  ];
  for (const [productFamily, materialClass, minimumPrice] of rows) {
    await pool.query(
      `INSERT INTO minimum_prices (minimum_price_id, guide_version_id, source_key, product_family, material_class, minimum_price)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        generateId("minp"),
        gv,
        `MINP-${productFamily.toUpperCase()}-${materialClass.toUpperCase()}`,
        productFamily,
        materialClass,
        minimumPrice,
      ],
    );
  }
}

/** CBP's standard quotation boilerplate (DEC-016). */
async function insertQuotationTerms(gv: string) {
  const terms = [
    "Harga tidak termasuk (exclude) PPN",
    "Termasuk franco / Pengiriman Jabodetabek",
    "Harga valid hanya dengan quantity sesuai dengan penawaran",
    "Validity harga 30 hari",
  ];
  for (const [i, text] of terms.entries()) {
    await pool.query(
      `INSERT INTO quotation_terms (term_id, guide_version_id, source_key, sort_order, term_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [generateId("term"), gv, `QT-0${i + 1}`, i + 1, text],
    );
  }
}

async function insertMaterialGradeMap(gv: string) {
  const rows: [string, string, string][] = [
    ["Bolt", "A325", "MAT-SCM440"],
    ["Bolt", "SUS310", "MAT-SUS310"],
    ["Nut", "2H", "MAT-SCM440"],
    ["Nut", "A563", "MAT-SCM440"],
    ["Washer", "A36", "MAT-CARBON-STEEL"],
    ["Washer", "F35", "MAT-CARBON-STEEL"],
    ["Stud / Anchor", "B7", "MAT-SCM440"],
    ["Stud / Anchor", "A307B", "MAT-SCM440"],
  ];
  const materials = await pool.query<{ material_id: string; source_key: string }>(
    `SELECT material_id, source_key FROM materials WHERE guide_version_id = $1`,
    [gv],
  );
  const byKey = new Map(materials.rows.map((r) => [r.source_key, r.material_id]));
  for (const [productFamily, grade, materialSourceKey] of rows) {
    const materialId = byKey.get(materialSourceKey);
    if (!materialId) throw new Error(`Fixture error: unknown material ${materialSourceKey}`);
    await pool.query(
      `INSERT INTO material_grade_map (map_id, guide_version_id, source_key, material_id, product_family, grade_or_spec)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [generateId("mgm"), gv, `MGM-${productFamily}-${grade}`, materialId, productFamily, grade],
    );
  }
}

async function insertGradeProfileRules(gv: string) {
  // productFamily, grade, profile, displayLabel (null = no detailed label, show the short code as-is).
  const rows: [string, string, string, string | null][] = [
    ["Bolt", "A325", "Heavy Hex", null],
    ["Bolt", "A193-B8", "Heavy Hex", null],
    ["Bolt", "SS304L", "Heavy Hex", null],
    ["Bolt", "SUS310", "Heavy Hex", null],
    // Confirmed detailed label (DEC-041) — regression guard proving the API/UI show the fuller
    // designation while the calc engine keeps matching on the short "2H" grade_or_spec.
    ["Nut", "2H", "Heavy Hex", "A194-2H"],
    // A563 is a Heavy Hex nut grade whose name isn't literally "2H" — regression guard for the
    // thickness formula, which must key off resolved profile, not a grade-string match.
    ["Nut", "A563", "Heavy Hex", null],
    ["Washer", "A36", "Washer", null],
    ["Washer", "F35", "Washer", null],
    ["Washer", "F436", "Washer", null],
    ["Stud / Anchor", "B7", "Stud Bolt FT", null],
    ["Stud / Anchor", "A307B", "Anchor Bolt", null],
  ];
  for (const [productFamily, grade, profile, displayLabel] of rows) {
    await pool.query(
      `INSERT INTO grade_profile_rules
         (rule_id, guide_version_id, source_key, product_family, grade_or_spec, default_product_profile, display_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [generateId("gpr"), gv, `PROFILE-${productFamily}-${grade}`, productFamily, grade, profile, displayLabel],
    );
  }
}

async function insertGradePriceAliases(gv: string) {
  const rows: [string, string, string][] = [
    ["Bolt", "A193-B8", "A2-70"],
    ["Bolt", "SS304L", "A2-70"],
  ];
  for (const [productFamily, inputGrade, canonical] of rows) {
    await pool.query(
      `INSERT INTO grade_price_aliases
         (alias_id, guide_version_id, source_key, product_family, input_grade, canonical_price_grade)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [generateId("alias"), gv, `ALIAS-${productFamily}-${inputGrade}`, productFamily, inputGrade, canonical],
    );
  }
}

async function insertMaterialSizeGuides(gv: string) {
  // profile, sizeLabel, diameterMm, rawDiameterMm, widthFlat, widthCorner, headThickness, washerOd, washerThickness
  const rows: [string, string, number, number | null, number | null, number | null, number | null, number | null, number | null][] = [
    // Confirmed from data inventory (SIZE-METRIC-HEAVY-HEX-14 / SIM-BOLT-QTY-30).
    ["Heavy Hex", "M14", 14, 18, 24, 27.71, 11.2, null, null],
    // Real Inch size (1", 25.4mm) — exercises the size_label fix (AT-SIZE-001):
    // a line saved with the real Inch label, not a synthesized "M25.4".
    ["Heavy Hex", "1", 25.4, 28, 41.275, 47.6504, 17.0656, null, null],
    // Confirmed from SIM-STUD-M20X1000 / SIM-ANCHOR-M20X500 (raw_diameter_mm=22).
    ["Stud Bolt FT", "M20", 20, 22, null, null, null, null, null],
    ["Anchor Bolt", "M20", 20, 22, null, null, null, null, null],
    // Representative (not confirmed from source) — enough to exercise the Nut/Washer formulas.
    ["Heavy Hex", "M20", 20, 22, 32, null, null, null, null], // width_corner absent -> exercises 1.154 fallback
    ["Washer", "M20", 20, null, null, null, null, 44, 4],
  ];
  for (const [profile, size, diameterMm, rawDiameterMm, widthFlat, widthCorner, headThickness, washerOd, washerThickness] of rows) {
    await pool.query(
      `INSERT INTO material_size_guides
         (size_guide_id, guide_version_id, source_key, product_profile, size_label,
          diameter_mm, raw_diameter_mm, width_flat, width_corner, head_thickness, washer_od, washer_thickness)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        generateId("sg"),
        gv,
        `SIZE-${profile}-${size}`,
        profile,
        size,
        diameterMm,
        rawDiameterMm,
        widthFlat,
        widthCorner,
        headThickness,
        washerOd,
        washerThickness,
      ],
    );
  }
}

async function insertPricePerKg(gv: string) {
  // productFamily, grade, sizeLabel, sellingPricePerKg
  const rows: [string, string, string, number][] = [
    ["Bolt", "A325", "M14", 70000], // confirmed
    ["Bolt", "A325", "1", 72000], // Inch size fixture for AT-SIZE-001
    ["Bolt", "SUS310", "M14", 300000], // representative (real card: 265,000-335,000/kg across sizes)
    ["Bolt", "A2-70", "M14", 216000], // confirmed (SIM-ALIAS-* use M20 216000; reused here for simplicity)
    ["Bolt", "A2-70", "M20", 216000], // confirmed
    ["Nut", "2H", "M20", 64000], // confirmed (SIM-NUT-QTY-400)
    ["Nut", "A563", "M20", 65000], // representative — regression fixture for Heavy Hex nut grade not named "2H"
    ["Washer", "A36", "M20", 44000], // confirmed (SIM-WASHER-M20)
    ["Washer", "F35", "M20", 60000], // confirmed (SIM-WASHER-F35-M20)
    ["Stud / Anchor", "B7", "M20", 60000], // confirmed (SIM-STUD-M20X1000)
    ["Stud / Anchor", "A307B", "M20", 45000], // confirmed (SIM-ANCHOR-M20X500)
  ];
  for (const [productFamily, grade, size, price] of rows) {
    await pool.query(
      `INSERT INTO price_per_kg
         (price_id, guide_version_id, source_key, product_family, grade_or_spec, size_label, selling_price_per_kg)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [generateId("ppk"), gv, `PRICE-${productFamily}-${grade}-${size}`, productFamily, grade, size, price],
    );
  }
}

async function insertCoatingPriceGuides(gv: string) {
  // processName, itemScope, minDiameterMm, rate
  const rows: [string, string, number, number][] = [
    ["HDG", "Bolt / Nut / Washer", 8, 10000], // simplified single-breakpoint rate for the generic coating mechanism test
    ["HDG", "Stud", 10, 17000], // confirmed base rate (back-derived from SIM-STUD-LENGTH-500)
  ];
  for (const [processName, itemScope, minDiameterMm, rate] of rows) {
    await pool.query(
      `INSERT INTO coating_price_guides
         (coating_rule_id, guide_version_id, source_key, process_group, process_name, item_scope, min_diameter_mm, basis, rate)
       VALUES ($1, $2, $3, 'Coating', $4, $5, $6, 'IDR_per_kg', $7)`,
      [generateId("coat"), gv, `PROC-${processName}-${itemScope}`, processName, itemScope, minDiameterMm, rate],
    );
  }
}

async function insertAdjustmentRules(gv: string) {
  // costingRoute, ruleGroup, scope, conditionField, min, max, type, value, component, minIncl, maxIncl
  const rows: [
    string,
    string,
    string,
    string,
    number | null,
    number | null,
    string,
    number,
    string,
    boolean,
    boolean,
  ][] = [
    // Bolt quantity — confirmed grade-tiered rate card (2026-08-24). Unlike Lead
    // Time, this is only carbon-vs-stainless (no low/high strength split, no
    // separate SUS310 rate).
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 1, 10, "percent_add", 0.5, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 11, 25, "percent_add", 0.45, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 26, 30, "percent_add", 0.4, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 31, 40, "percent_add", 0.35, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 41, 50, "percent_add", 0.3, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 51, 70, "percent_add", 0.25, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 71, 100, "percent_add", 0.2, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 101, 150, "percent_add", 0.15, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 151, 200, "percent_add", 0.1, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 201, 250, "percent_add", 0.05, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 251, 500, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 501, 750, "percent_add", -0.025, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 751, 1000, "percent_add", -0.05, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 1001, 1250, "percent_add", -0.075, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 1251, 1750, "percent_add", -0.1, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 1751, 2000, "percent_add", -0.125, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 2001, 2500, "percent_add", -0.15, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 2501, 4000, "percent_add", -0.2, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 4001, 6000, "percent_add", -0.25, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 6001, 9000, "percent_add", -0.3, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Carbon", "qty", 9001, null, "percent_add", -0.35, "base_price_per_item", true, false],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 1, 10, "percent_add", 0.6, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 11, 25, "percent_add", 0.5, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 26, 30, "percent_add", 0.4, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 31, 40, "percent_add", 0.35, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 41, 50, "percent_add", 0.3, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 51, 70, "percent_add", 0.2, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 71, 100, "percent_add", 0.1, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 101, 150, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 151, 200, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 201, 250, "percent_add", -0.05, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 251, 500, "percent_add", -0.075, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 501, 750, "percent_add", -0.1, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 751, 1000, "percent_add", -0.125, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 1001, 1250, "percent_add", -0.125, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 1251, 1750, "percent_add", -0.15, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 1751, 2000, "percent_add", -0.175, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 2001, 2500, "percent_add", -0.2, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 2501, 4000, "percent_add", -0.2, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 4001, 6000, "percent_add", -0.25, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 6001, 9000, "percent_add", -0.3, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Bolt|Stainless", "qty", 9001, null, "percent_add", -0.35, "base_price_per_item", true, false],
    // Bolt lead time — confirmed grade-tiered rate card (2026-08-24). Standard
    // lead time is 4 weeks (28 days) = 0% for every tier; only these 5 exact
    // day counts are offered (28/21/14/10/7), so any other value is a genuine
    // gap and correctly throws ADJUSTMENT_NO_MATCH.
    ["Custom Production", "Lead Time", "Bolt|CarbonLow", "lead_time_days", 28, 28, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonLow", "lead_time_days", 21, 21, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonLow", "lead_time_days", 14, 14, "percent_add", 0.15, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonLow", "lead_time_days", 10, 10, "percent_add", 0.3, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonLow", "lead_time_days", 7, 7, "percent_add", 0.6, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonHigh", "lead_time_days", 28, 28, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonHigh", "lead_time_days", 21, 21, "percent_add", 0.15, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonHigh", "lead_time_days", 14, 14, "percent_add", 0.3, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonHigh", "lead_time_days", 10, 10, "percent_add", 0.6, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|CarbonHigh", "lead_time_days", 7, 7, "percent_add", 1.0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessLow", "lead_time_days", 28, 28, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessLow", "lead_time_days", 21, 21, "percent_add", 0.2, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessLow", "lead_time_days", 14, 14, "percent_add", 0.4, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessLow", "lead_time_days", 10, 10, "percent_add", 0.6, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessLow", "lead_time_days", 7, 7, "percent_add", 0.8, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessHigh", "lead_time_days", 28, 28, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessHigh", "lead_time_days", 21, 21, "percent_add", 0.3, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessHigh", "lead_time_days", 14, 14, "percent_add", 0.5, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessHigh", "lead_time_days", 10, 10, "percent_add", 0.7, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Bolt|StainlessHigh", "lead_time_days", 7, 7, "percent_add", 1.0, "base_price_per_item", true, true],
    // Nut quantity — confirmed (2026-08-24). Unified across all grades, no
    // carbon/stainless split (unlike Bolt), and no small-order premium at all
    // — Nut only ever discounts, starting from 0% at low quantities.
    ["Custom Production", "Quantity", "Nut", "qty", 1, 400, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Nut", "qty", 401, 700, "percent_add", -0.05, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Nut", "qty", 701, 1250, "percent_add", -0.1, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Nut", "qty", 1251, 2500, "percent_add", -0.15, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Nut", "qty", 2501, 4000, "percent_add", -0.2, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Nut", "qty", 4001, 6000, "percent_add", -0.25, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Nut", "qty", 6001, 10000, "percent_add", -0.3, "base_price_per_item", true, true],
    ["Custom Production", "Quantity", "Nut", "qty", 10001, null, "percent_add", -0.35, "base_price_per_item", true, false],
    // Nut lead time — confirmed grade-tiered rate card (2026-08-24). Nut's tier
    // boundary differs from Bolt's (8.8/2H is low tier for Nut, high for Bolt),
    // and stainless has no SUS310 premium for Nut, unlike Bolt.
    ["Custom Production", "Lead Time", "Nut|CarbonLow", "lead_time_days", 28, 28, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonLow", "lead_time_days", 21, 21, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonLow", "lead_time_days", 14, 14, "percent_add", 0.2, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonLow", "lead_time_days", 10, 10, "percent_add", 0.4, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonLow", "lead_time_days", 7, 7, "percent_add", 0.6, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonHigh", "lead_time_days", 28, 28, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonHigh", "lead_time_days", 21, 21, "percent_add", 0.2, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonHigh", "lead_time_days", 14, 14, "percent_add", 0.35, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonHigh", "lead_time_days", 10, 10, "percent_add", 0.5, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|CarbonHigh", "lead_time_days", 7, 7, "percent_add", 1.0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|Stainless", "lead_time_days", 28, 28, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|Stainless", "lead_time_days", 21, 21, "percent_add", 0.2, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|Stainless", "lead_time_days", 14, 14, "percent_add", 0.35, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|Stainless", "lead_time_days", 10, 10, "percent_add", 0.5, "base_price_per_item", true, true],
    ["Custom Production", "Lead Time", "Nut|Stainless", "lead_time_days", 7, 7, "percent_add", 0.7, "base_price_per_item", true, true],
    // Bolt length ratio — confirmed.
    ["Custom Production", "Length Ratio", "Bolt", "length_diameter_ratio", 0, 6, "percent_add", 0, "base_price_per_item", true, true],
    ["Custom Production", "Length Ratio", "Bolt", "length_diameter_ratio", 6, 12, "percent_add", 0.1, "base_price_per_item", false, true],
    ["Custom Production", "Length Ratio", "Bolt", "length_diameter_ratio", 12, null, "percent_add", 0.2, "base_price_per_item", false, false],
    // Coating order-weight breaks — confirmed.
    ["Custom Production", "Coating Order Weight", "HDG", "total_order_coating_weight_kg", 0, 500, "percent_add", 0, "coating_price_per_item", true, true],
    ["Custom Production", "Coating Order Weight", "HDG", "total_order_coating_weight_kg", 500, 1000, "percent_add", -0.05, "coating_price_per_item", false, true],
    ["Custom Production", "Coating Order Weight", "HDG", "total_order_coating_weight_kg", 1000, 2000, "percent_add", -0.075, "coating_price_per_item", false, true],
    ["Custom Production", "Coating Order Weight", "HDG", "total_order_coating_weight_kg", 2000, null, "percent_add", -0.1, "coating_price_per_item", false, false],
    // Stud coating length surcharge — confirmed.
    ["Custom Production", "Length Surcharge", "HDG Stud", "length_mm", 0, 499, "IDR_per_kg_add", 0, "coating_price_per_item", true, true],
    ["Custom Production", "Length Surcharge", "HDG Stud", "length_mm", 500, 1000, "IDR_per_kg_add", 5000, "coating_price_per_item", true, true],
    ["Custom Production", "Length Surcharge", "HDG Stud", "length_mm", 1000, 2000, "IDR_per_kg_add", 8000, "coating_price_per_item", false, true],
  ];
  for (const [route, group, scope, field, min, max, type, value, component, minIncl, maxIncl] of rows) {
    await pool.query(
      `INSERT INTO adjustment_rules
         (adjustment_rule_id, guide_version_id, source_key, costing_route, rule_group, scope, condition_field,
          threshold_min, threshold_max, adjustment_type, adjustment_value, applies_to_component, min_inclusive, max_inclusive)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        generateId("adj"),
        gv,
        `RULE-${group}-${scope}-${min}-${max}`,
        route,
        group,
        scope,
        field,
        min,
        max,
        type,
        value,
        component,
        minIncl,
        maxIncl,
      ],
    );
  }
}

async function insertTradingItemsAndTiers(gv: string) {
  // Confirmed Trading Nut item + tiers (F10T M12), and Washer F436 items used for AT-TRADING-002/003.
  const items: [string, string, string][] = [
    ["TR-NUT-F10T-M12", "Nut", "M12"],
    // Same category + size as TR-NUT-F10T-M12 on purpose — regression fixture for the
    // resolve-by-selected-id fix (previously resolved by category+size alone, which is
    // ambiguous whenever two items share a size, as most Nut items do across grades).
    ["TR-NUT-A194-M12", "Nut", "M12"],
    ["TR-WASHER-F436-M20", "Washer", "M20"],
    ["TR-WASHER-F436-M72", "Washer", "M72"],
  ];
  const itemIds = new Map<string, string>();
  for (const [sourceKey, category, size] of items) {
    const id = generateId("tri");
    itemIds.set(sourceKey, id);
    await pool.query(
      `INSERT INTO trading_items (trading_item_id, guide_version_id, source_key, product_category, product_name, size_label)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, gv, sourceKey, category, `${category} ${size}`, size],
    );
  }

  const tiers: [string, number, number | null, number][] = [
    // TR-NUT-F10T-M12 — confirmed.
    ["TR-NUT-F10T-M12", 1, 25, 3400],
    ["TR-NUT-F10T-M12", 26, 100, 3060],
    ["TR-NUT-F10T-M12", 101, 500, 2720],
    ["TR-NUT-F10T-M12", 501, 2000, 2380],
    ["TR-NUT-F10T-M12", 2001, null, 2040],
    // TR-NUT-A194-M12 — distinct price on purpose; see comment above.
    ["TR-NUT-A194-M12", 1, null, 9999],
    // TR-WASHER-F436-M20 — confirmed: only a 1-100 tier exists; 101+ must inherit (AT-TRADING-002).
    ["TR-WASHER-F436-M20", 1, 100, 5695],
    // TR-WASHER-F436-M72 — confirmed: coverage stops at 5000; 5001+ must inherit (AT-TRADING-003).
    ["TR-WASHER-F436-M72", 1, 5000, 70400],
  ];
  for (const [itemKey, qtyMin, qtyMax, price] of tiers) {
    const itemId = itemIds.get(itemKey);
    if (!itemId) throw new Error(`Fixture error: unknown trading item ${itemKey}`);
    await pool.query(
      `INSERT INTO trading_price_tiers (tier_id, guide_version_id, source_key, trading_item_id, qty_min, qty_max, unit_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [generateId("tier"), gv, `TIER-${itemKey}-${qtyMin}`, itemId, qtyMin, qtyMax, price],
    );
  }
}

async function insertCalculationFormulas(gv: string) {
  const rows: [string, string, string, string][] = [
    [
      "Bolt",
      "raw_cut_weight_per_item",
      "corner=COALESCE(width_corner,width_flat*1.154);head_volume=PI()*(corner/2)^2*head_thickness;head_equiv_length=head_volume/(PI()*(raw_diameter/2)^2);raw_weight=PI()*(raw_diameter/2)^2*(head_equiv_length+finished_length)*density*1e-9",
      "raw_diameter,width_flat,width_corner,head_thickness,finished_length,density",
    ],
    [
      "Nut",
      "raw_cut_weight_per_item",
      "corner=COALESCE(width_corner,width_flat*1.154);thickness=IF(profile='Heavy Hex',diameter,0.8*diameter);forging_ID=IF(diameter<20,0,0.85*diameter);volume=PI()*((corner/2)^2-(forging_ID/2)^2)*thickness;raw_weight=volume*density*1e-9",
      "profile,diameter,width_flat,width_corner,density",
    ],
    [
      "Washer",
      "raw_cut_weight_per_item",
      "raw_volume=washer_od^2*washer_thickness;raw_weight=raw_volume*density*1e-9",
      "washer_od,washer_thickness,density",
    ],
    [
      "Stud / Anchor",
      "raw_cut_weight_finished_length",
      "raw_weight=PI()*(raw_diameter/2)^2*finished_length*density*1e-9",
      "raw_diameter,finished_length,density",
    ],
    [
      "Stud / Anchor",
      "raw_cut_weight_developed_length",
      "raw_weight=PI()*(raw_diameter/2)^2*developed_cut_length*density*1e-9",
      "raw_diameter,developed_cut_length,density",
    ],
  ];
  for (const [productFamily, scope, expression, requiredInputs] of rows) {
    await pool.query(
      `INSERT INTO calculation_formulas
         (formula_id, guide_version_id, source_key, product_family, formula_scope, formula_expression, required_inputs)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [generateId("formula"), gv, `FORMULA-${productFamily}-${scope}`, productFamily, scope, expression, requiredInputs],
    );
  }
}

async function insertCostingRouteRules(gv: string) {
  const rows: [string, string, string][] = [
    ["Bolt", "A325", "Custom Production"],
    ["Bolt", "A193-B8", "Custom Production"],
    ["Bolt", "SS304L", "Custom Production"],
    ["Bolt", "SUS310", "Custom Production"],
    ["Nut", "2H", "Custom Production"],
    ["Washer", "A36", "Custom Production"],
    ["Washer", "F35", "Custom Production"],
    ["Washer", "F436", "Trading"],
    ["Stud / Anchor", "B7", "Custom Production"],
    ["Stud / Anchor", "A307B", "Custom Production"],
    ["Nut", "F10T", "Trading"],
  ];
  for (const [productFamily, grade, route] of rows) {
    await pool.query(
      `INSERT INTO costing_route_rules
         (route_rule_id, guide_version_id, source_key, product_family, grade_or_spec, allowed_costing_route)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [generateId("route"), gv, `ROUTE-${productFamily}-${grade}`, productFamily, grade, route],
    );
  }
}
