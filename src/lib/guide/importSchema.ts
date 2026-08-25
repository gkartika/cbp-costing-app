/**
 * Declarative description of every named tab a guide package must/may
 * contain (PKG-001..014). One generic import engine (importGuide.ts) walks
 * this table instead of one hand-written parser per sheet — the sheets are
 * structurally identical (a header row of typed columns, an optional
 * foreign-key column resolved by another tab's business key, an optional
 * `active` flag) even though the business meaning of each differs.
 */

export type ColumnType = "string" | "number" | "boolean";

export type ColumnSpec =
  | { header: string; dbColumn: string; type: ColumnType; required: boolean }
  | { header: string; dbColumn: string; type: "reference"; required: boolean; refTab: string };

export type TabSpec = {
  tabName: string;
  table: string;
  idColumn: string;
  idPrefix: string;
  /** Column that uniquely identifies this row within the tab (becomes source_key). */
  keyHeader: string;
  columns: ColumnSpec[];
  /** Additional business-key columns (besides keyHeader) that together must be unique per tab, e.g. (product_family, grade_or_spec). */
  uniqueBusinessKey?: string[];
};

const activeCol: ColumnSpec = { header: "active", dbColumn: "active", type: "boolean", required: false };

export const TAB_SPECS: TabSpec[] = [
  {
    tabName: "Materials",
    table: "materials",
    idColumn: "material_id",
    idPrefix: "mat",
    keyHeader: "material_id",
    columns: [
      { header: "material_name", dbColumn: "material_name", type: "string", required: true },
      { header: "density_kg_m3", dbColumn: "density_kg_m3", type: "number", required: true },
      activeCol,
    ],
  },
  {
    tabName: "Raw_Bar_Stock",
    table: "raw_bar_stock",
    idColumn: "stock_id",
    idPrefix: "stk",
    keyHeader: "raw_bar_stock_id",
    columns: [
      { header: "material_id", dbColumn: "material_id", type: "reference", required: true, refTab: "Materials" },
      { header: "diameter_mm", dbColumn: "diameter_mm", type: "number", required: true },
      { header: "size_code", dbColumn: "size_code", type: "string", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["material_id", "diameter_mm"],
  },
  {
    tabName: "Dies_Cost_Guides",
    table: "dies_cost_guides",
    idColumn: "dies_cost_id",
    idPrefix: "dies",
    keyHeader: "dies_cost_guide_id",
    columns: [
      { header: "product_family", dbColumn: "product_family", type: "string", required: true },
      { header: "product_profile", dbColumn: "product_profile", type: "string", required: true },
      { header: "size_label", dbColumn: "size_label", type: "string", required: true },
      { header: "diameter_mm", dbColumn: "diameter_mm", type: "number", required: true },
      { header: "cost", dbColumn: "cost", type: "number", required: true },
      { header: "currency", dbColumn: "currency", type: "string", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["product_family", "product_profile", "size_label"],
  },
  {
    tabName: "Material_Grade_Map",
    table: "material_grade_map",
    idColumn: "map_id",
    idPrefix: "mgm",
    keyHeader: "material_grade_map_id",
    columns: [
      { header: "material_id", dbColumn: "material_id", type: "reference", required: true, refTab: "Materials" },
      { header: "product_family", dbColumn: "product_family", type: "string", required: true },
      { header: "grade_or_spec", dbColumn: "grade_or_spec", type: "string", required: true },
      { header: "notes", dbColumn: "notes", type: "string", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["product_family", "grade_or_spec"],
  },
  {
    tabName: "Grade_Profile_Rules",
    table: "grade_profile_rules",
    idColumn: "rule_id",
    idPrefix: "gpr",
    keyHeader: "profile_rule_id",
    columns: [
      { header: "product_family", dbColumn: "product_family", type: "string", required: true },
      { header: "grade_or_spec", dbColumn: "grade_or_spec", type: "string", required: true },
      { header: "default_product_profile", dbColumn: "default_product_profile", type: "string", required: true },
      { header: "display_label", dbColumn: "display_label", type: "string", required: false },
      { header: "mapping_status", dbColumn: "mapping_status", type: "string", required: false },
      { header: "override_allowed", dbColumn: "override_allowed", type: "boolean", required: false },
      { header: "priority", dbColumn: "priority", type: "number", required: false },
      { header: "notes", dbColumn: "notes", type: "string", required: false },
      { header: "standard_reference", dbColumn: "standard_reference", type: "string", required: false },
      { header: "reference_url", dbColumn: "reference_url", type: "string", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["product_family", "grade_or_spec"],
  },
  {
    tabName: "Grade_Price_Alias",
    table: "grade_price_aliases",
    idColumn: "alias_id",
    idPrefix: "alias",
    keyHeader: "alias_id",
    columns: [
      { header: "product_family", dbColumn: "product_family", type: "string", required: true },
      { header: "input_grade", dbColumn: "input_grade", type: "string", required: true },
      { header: "canonical_price_grade", dbColumn: "canonical_price_grade", type: "string", required: true },
      { header: "decision_source", dbColumn: "decision_source", type: "string", required: false },
      { header: "notes", dbColumn: "notes", type: "string", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["product_family", "input_grade"],
  },
  {
    tabName: "Material_Size_Guides",
    table: "material_size_guides",
    idColumn: "size_guide_id",
    idPrefix: "sg",
    keyHeader: "size_ref_id",
    columns: [
      { header: "unit_system", dbColumn: "unit_system", type: "string", required: false },
      { header: "standard_group", dbColumn: "standard_group", type: "string", required: false },
      { header: "product_profile", dbColumn: "product_profile", type: "string", required: true },
      { header: "size_label", dbColumn: "size_label", type: "string", required: true },
      { header: "diameter_mm", dbColumn: "diameter_mm", type: "number", required: false },
      { header: "raw_diameter_mm", dbColumn: "raw_diameter_mm", type: "number", required: false },
      { header: "width_flat", dbColumn: "width_flat", type: "number", required: false },
      { header: "width_corner", dbColumn: "width_corner", type: "number", required: false },
      { header: "head_thickness", dbColumn: "head_thickness", type: "number", required: false },
      { header: "washer_od", dbColumn: "washer_od", type: "number", required: false },
      { header: "washer_thickness", dbColumn: "washer_thickness", type: "number", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["product_profile", "size_label"],
  },
  {
    tabName: "Price_Per_Kg",
    table: "price_per_kg",
    idColumn: "price_id",
    idPrefix: "ppk",
    keyHeader: "price_id",
    columns: [
      { header: "product_family", dbColumn: "product_family", type: "string", required: true },
      { header: "product_type", dbColumn: "product_type", type: "string", required: false },
      { header: "thread_condition", dbColumn: "thread_condition", type: "string", required: false },
      { header: "grade_or_spec", dbColumn: "grade_or_spec", type: "string", required: true },
      { header: "material", dbColumn: "material", type: "string", required: false },
      { header: "unit_system", dbColumn: "unit_system", type: "string", required: false },
      { header: "size_label", dbColumn: "size_label", type: "string", required: false },
      { header: "diameter_mm", dbColumn: "diameter_mm", type: "number", required: false },
      { header: "selling_price_per_kg", dbColumn: "selling_price_per_kg", type: "number", required: true },
      { header: "currency", dbColumn: "currency", type: "string", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["product_family", "grade_or_spec", "size_label"],
  },
  {
    tabName: "Coating_Guides",
    table: "coating_price_guides",
    idColumn: "coating_rule_id",
    idPrefix: "coat",
    keyHeader: "process_cost_id",
    columns: [
      { header: "process_group", dbColumn: "process_group", type: "string", required: true },
      { header: "process_name", dbColumn: "process_name", type: "string", required: true },
      { header: "item_scope", dbColumn: "item_scope", type: "string", required: false },
      { header: "size_label", dbColumn: "size_label", type: "string", required: false },
      { header: "min_diameter_mm", dbColumn: "min_diameter_mm", type: "number", required: false },
      { header: "basis", dbColumn: "basis", type: "string", required: true },
      { header: "rate", dbColumn: "rate", type: "number", required: true },
      { header: "currency", dbColumn: "currency", type: "string", required: false },
      activeCol,
    ],
  },
  {
    tabName: "Adjustment_Rules",
    table: "adjustment_rules",
    idColumn: "adjustment_rule_id",
    idPrefix: "adj",
    keyHeader: "rule_id",
    columns: [
      { header: "costing_route", dbColumn: "costing_route", type: "string", required: true },
      { header: "rule_group", dbColumn: "rule_group", type: "string", required: true },
      { header: "scope", dbColumn: "scope", type: "string", required: true },
      { header: "condition_field", dbColumn: "condition_field", type: "string", required: true },
      { header: "threshold_min", dbColumn: "threshold_min", type: "number", required: false },
      { header: "threshold_max", dbColumn: "threshold_max", type: "number", required: false },
      { header: "adjustment_type", dbColumn: "adjustment_type", type: "string", required: true },
      { header: "adjustment_value", dbColumn: "adjustment_value", type: "number", required: true },
      { header: "applies_to_component", dbColumn: "applies_to_component", type: "string", required: true },
      { header: "min_inclusive", dbColumn: "min_inclusive", type: "boolean", required: false },
      { header: "max_inclusive", dbColumn: "max_inclusive", type: "boolean", required: false },
      activeCol,
    ],
  },
  {
    tabName: "Trading_Items",
    table: "trading_items",
    idColumn: "trading_item_id",
    idPrefix: "tri",
    keyHeader: "item_id",
    columns: [
      { header: "product_category", dbColumn: "product_category", type: "string", required: true },
      { header: "product_name", dbColumn: "product_name", type: "string", required: true },
      { header: "grade_or_spec", dbColumn: "grade_or_spec", type: "string", required: false },
      { header: "material", dbColumn: "material", type: "string", required: false },
      { header: "unit_system", dbColumn: "unit_system", type: "string", required: false },
      { header: "size_label", dbColumn: "size_label", type: "string", required: true },
      { header: "pitch", dbColumn: "pitch", type: "number", required: false },
      { header: "width_flat", dbColumn: "width_flat", type: "number", required: false },
      { header: "thickness", dbColumn: "thickness", type: "number", required: false },
      { header: "weight_kg", dbColumn: "weight_kg", type: "number", required: false },
      { header: "purchase_price", dbColumn: "purchase_price", type: "number", required: false },
      { header: "purchase_price_ex_tax", dbColumn: "purchase_price_ex_tax", type: "number", required: false },
      { header: "market_min", dbColumn: "market_min", type: "number", required: false },
      { header: "market_max", dbColumn: "market_max", type: "number", required: false },
      { header: "price_per_kg", dbColumn: "price_per_kg", type: "number", required: false },
      { header: "currency", dbColumn: "currency", type: "string", required: false },
      activeCol,
    ],
  },
  {
    tabName: "Trading_Price_Tiers",
    table: "trading_price_tiers",
    idColumn: "tier_id",
    idPrefix: "tier",
    keyHeader: "tier_id",
    columns: [
      { header: "item_id", dbColumn: "trading_item_id", type: "reference", required: true, refTab: "Trading_Items" },
      { header: "tier_label", dbColumn: "tier_label", type: "string", required: false },
      { header: "qty_min", dbColumn: "qty_min", type: "number", required: true },
      { header: "qty_max", dbColumn: "qty_max", type: "number", required: false },
      { header: "unit_price", dbColumn: "unit_price", type: "number", required: true },
      { header: "currency", dbColumn: "currency", type: "string", required: false },
      { header: "pricing_unit", dbColumn: "pricing_unit", type: "string", required: false },
      activeCol,
    ],
  },
  {
    tabName: "Calculation_Formulas",
    table: "calculation_formulas",
    idColumn: "formula_id",
    idPrefix: "formula",
    keyHeader: "formula_id",
    columns: [
      { header: "product_family", dbColumn: "product_family", type: "string", required: true },
      { header: "formula_scope", dbColumn: "formula_scope", type: "string", required: true },
      { header: "formula_expression", dbColumn: "formula_expression", type: "string", required: true },
      { header: "required_inputs", dbColumn: "required_inputs", type: "string", required: true },
      { header: "tolerance_pct", dbColumn: "tolerance_pct", type: "number", required: false },
      { header: "verification_status", dbColumn: "verification_status", type: "string", required: false },
      { header: "standard_reference", dbColumn: "standard_reference", type: "string", required: false },
      { header: "notes", dbColumn: "notes", type: "string", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["product_family", "formula_scope"],
  },
  {
    tabName: "Costing_Route_Rules",
    table: "costing_route_rules",
    idColumn: "route_rule_id",
    idPrefix: "route",
    keyHeader: "route_rule_id",
    columns: [
      { header: "product_family", dbColumn: "product_family", type: "string", required: true },
      { header: "grade_or_spec", dbColumn: "grade_or_spec", type: "string", required: true },
      { header: "allowed_costing_route", dbColumn: "allowed_costing_route", type: "string", required: true },
      { header: "price_source", dbColumn: "price_source", type: "string", required: false },
      { header: "enforcement", dbColumn: "enforcement", type: "string", required: false },
      { header: "priority", dbColumn: "priority", type: "number", required: false },
      { header: "notes", dbColumn: "notes", type: "string", required: false },
      activeCol,
    ],
    uniqueBusinessKey: ["product_family", "grade_or_spec"],
  },
];

export const REQUIRED_TABS = ["Version_Manifest", ...TAB_SPECS.map((t) => t.tabName)];
