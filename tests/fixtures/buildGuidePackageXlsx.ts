import ExcelJS from "exceljs";

export type BuildOptions = {
  versionCode: string;
  /** Mutate specific tabs before writing, to construct intentionally-invalid packages for negative tests. */
  mutate?: (sheets: Record<string, (string | number | boolean | null)[][]>) => void;
};

function addSheet(wb: ExcelJS.Workbook, name: string, rows: (string | number | boolean | null)[][]) {
  const sheet = wb.addWorksheet(name);
  for (const row of rows) sheet.addRow(row);
}

/**
 * Builds a minimal-but-complete, schema-valid guide package in memory: one
 * Bolt A325/M14 that reproduces the confirmed SIM-BOLT-QTY-30 golden values
 * exactly, plus the config/reference rows it depends on. Small enough to
 * read at a glance, complete enough to exercise every required tab.
 */
export async function buildGuidePackageXlsx(opts: BuildOptions): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const sheets: Record<string, (string | number | boolean | null)[][]> = {
    Version_Manifest: [
      ["version_code", "schema_version"],
      [opts.versionCode, "1"],
    ],
    App_Config: [
      ["config_key", "value", "data_type", "unit", "editable_by", "status"],
      ["ROUNDING_INCREMENT", "500", "number", "IDR", "super_admin", "active"],
      ["CUSTOM_WEIGHT_TOLERANCE", "0.02", "percent", null, "super_admin", "active"],
      ["TRADING_DEFAULT_MARGIN", "0.25", "percent", null, "user", "active"],
    ],
    Materials: [
      ["material_id", "material_name", "density_kg_m3", "active"],
      ["MAT-SCM440", "SCM440", 7850, true],
    ],
    Raw_Bar_Stock: [
      ["raw_bar_stock_id", "material_id", "diameter_mm", "size_code", "active"],
      // Exactly matches the M14 size guide's existing raw_diameter_mm (18) so
      // the SIM-BOLT-QTY-30 golden values below are unaffected by this tab.
      ["STOCK-SCM440-18", "MAT-SCM440", 18, "D18", true],
    ],
    Dies_Cost_Guides: [
      ["dies_cost_guide_id", "product_family", "product_profile", "size_label", "diameter_mm", "cost", "currency", "active"],
      ["DIES-BOLT-HEAVYHEX-1", "Bolt", "Heavy Hex", "1", 25.4, 5300000, "IDR", true],
    ],
    Quotation_Terms: [
      ["quotation_term_id", "sort_order", "term_text", "active"],
      ["QT-01", 1, "Harga tidak termasuk (exclude) PPN", true],
    ],
    Minimum_Prices: [
      ["minimum_price_id", "product_family", "material_class", "minimum_price", "currency", "active"],
      // Well below the fixture's computed Bolt price, so the floor never
      // silently rewrites the SIM-BOLT-QTY-30 golden values below.
      ["MINP-BOLT-NONSS", "Bolt", "Non-Stainless", 1000, "IDR", true],
    ],
    Material_Grade_Map: [
      ["material_grade_map_id", "material_id", "product_family", "grade_or_spec", "notes", "active"],
      ["MGM-BOLT-A325", "MAT-SCM440", "Bolt", "A325", "", true],
    ],
    Grade_Profile_Rules: [
      [
        "profile_rule_id",
        "product_family",
        "grade_or_spec",
        "default_product_profile",
        "mapping_status",
        "override_allowed",
        "priority",
        "notes",
        "standard_reference",
        "reference_url",
        "active",
      ],
      ["PROFILE-BOLT-A325", "Bolt", "A325", "Heavy Hex", "confirmed", false, 300, "", "", "", true],
    ],
    Grade_Price_Alias: [
      ["alias_id", "product_family", "input_grade", "canonical_price_grade", "decision_source", "notes", "active"],
    ],
    Material_Size_Guides: [
      [
        "size_ref_id",
        "unit_system",
        "standard_group",
        "product_profile",
        "size_label",
        "diameter_mm",
        "raw_diameter_mm",
        "width_flat",
        "width_corner",
        "head_thickness",
        "washer_od",
        "washer_thickness",
        "active",
      ],
      ["SIZE-HEAVY-HEX-M14", "Metric", "ANSI Metric", "Heavy Hex", "M14", 14, 18, 24, 27.71, 11.2, null, null, true],
    ],
    Price_Per_Kg: [
      [
        "price_id",
        "product_family",
        "product_type",
        "thread_condition",
        "grade_or_spec",
        "material",
        "unit_system",
        "size_label",
        "diameter_mm",
        "selling_price_per_kg",
        "currency",
        "active",
      ],
      ["PRICE-BOLT-A325-M14", "Bolt", "Hex Bolt", "HT", "A325", "SCM440", "Metric", "M14", 14, 70000, "IDR", true],
    ],
    Coating_Guides: [
      ["process_cost_id", "process_group", "process_name", "item_scope", "size_label", "min_diameter_mm", "basis", "rate", "currency", "active"],
    ],
    Adjustment_Rules: [
      [
        "rule_id",
        "costing_route",
        "rule_group",
        "scope",
        "condition_field",
        "threshold_min",
        "threshold_max",
        "adjustment_type",
        "adjustment_value",
        "applies_to_component",
        "min_inclusive",
        "max_inclusive",
        "active",
      ],
      ["RULE-BOLT-QTY-26-30", "Custom Production", "Quantity", "Bolt|Carbon", "qty", 26, 30, "percent_add", 0.4, "base_price_per_item", true, true, true],
      ["RULE-BOLT-LEAD-14", "Custom Production", "Lead Time", "Bolt|CarbonHigh", "lead_time_days", 14, 14, "percent_add", 0.3, "base_price_per_item", true, true, true],
      ["RULE-BOLT-LENGTH-0-6D", "Custom Production", "Length Ratio", "Bolt", "length_diameter_ratio", 0, 6, "percent_add", 0, "base_price_per_item", true, true, true],
    ],
    Trading_Items: [
      ["item_id", "product_category", "product_name", "grade_or_spec", "material", "unit_system", "size_label", "pitch", "width_flat", "thickness", "weight_kg", "purchase_price", "purchase_price_ex_tax", "market_min", "market_max", "price_per_kg", "currency", "active"],
    ],
    Trading_Price_Tiers: [
      ["tier_id", "item_id", "tier_label", "qty_min", "qty_max", "unit_price", "currency", "pricing_unit", "active"],
    ],
    Calculation_Formulas: [
      ["formula_id", "product_family", "formula_scope", "formula_expression", "required_inputs", "tolerance_pct", "verification_status", "standard_reference", "notes", "active"],
      [
        "FORMULA-BOLT-RAW-CUT-V1",
        "Bolt",
        "raw_cut_weight_per_item",
        "corner=COALESCE(width_corner,width_flat*1.154);head_volume=PI()*(corner/2)^2*head_thickness;head_equiv_length=head_volume/(PI()*(raw_diameter/2)^2);raw_weight=PI()*(raw_diameter/2)^2*(head_equiv_length+finished_length)*density*1e-9",
        "raw_diameter,width_flat,width_corner,head_thickness,finished_length,density",
        0.02,
        "confirmed",
        "ISO 4014",
        "",
        true,
      ],
    ],
    Costing_Route_Rules: [
      ["route_rule_id", "product_family", "grade_or_spec", "allowed_costing_route", "price_source", "enforcement", "priority", "notes", "active"],
      ["ROUTE-BOLT-A325", "Bolt", "A325", "Custom Production", "Price_Per_Kg", "required", 300, "", true],
    ],
    Simulation_Cases: [
      ["simulation_id", "route", "product_family", "input_json", "expected_json", "notes", "active"],
      [
        "SIM-BOLT-QTY-30",
        "Custom Production",
        "Bolt",
        JSON.stringify({
          productFamily: "Bolt",
          gradeOrSpec: "A325",
          sizeLabel: "M14",
          diameterMm: 14,
          qty: 30,
          leadTimeDays: 14,
          lengthMm: 80,
          developedCutLengthMm: null,
          coatingCode: null,
          diesAvailable: null,
          diesTotalCost: null,
        }),
        JSON.stringify({
          resultStatus: "PASS",
          rawWeightPerItemKg: 0.2128278645,
          unitSellingPrice: 28000,
          orderTotal: 840000,
          tolerance: 0.001,
        }),
        "Boundary test from data inventory",
        true,
      ],
    ],
  };

  opts.mutate?.(sheets);

  for (const [name, rows] of Object.entries(sheets)) {
    addSheet(wb, name, rows);
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
