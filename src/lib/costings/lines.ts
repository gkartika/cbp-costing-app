export type CostingLineRow = {
  costing_line_id: string;
  costing_id: string;
  line_no: number;
  route: string | null;
  product_family: string | null;
  description: string | null;
  grade_input: string | null;
  thread_condition: string | null;
  profile_resolved: string | null;
  size_label: string | null;
  diameter_mm: string | null;
  length_mm: string | null;
  developed_cut_length_mm: string | null;
  width_corner_mm: string | null;
  width_flat_mm: string | null;
  raw_diameter_mm: string | null;
  raw_thickness_mm: string | null;
  qty: number | null;
  lead_time_days: number | null;
  coating_code: string | null;
  dies_option: "yes" | "no_lookup" | "manual" | null;
  dies_total_cost: string | null;
  weight_tolerance_percent: string | null;
  margin_percent: string | null;
  trading_item_id: string | null;
  trading_quote_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export function serializeCostingLine(row: CostingLineRow, hasCurrentSnapshot: boolean) {
  return {
    costingLineId: row.costing_line_id,
    costingId: row.costing_id,
    lineNo: row.line_no,
    route: row.route,
    productFamily: row.product_family,
    description: row.description,
    gradeInput: row.grade_input,
    threadCondition: row.thread_condition,
    profileResolved: row.profile_resolved,
    sizeLabel: row.size_label,
    diameterMm: num(row.diameter_mm),
    lengthMm: num(row.length_mm),
    developedCutLengthMm: num(row.developed_cut_length_mm),
    widthCornerMm: num(row.width_corner_mm),
    widthFlatMm: num(row.width_flat_mm),
    rawDiameterMm: num(row.raw_diameter_mm),
    rawThicknessMm: num(row.raw_thickness_mm),
    qty: row.qty,
    leadTimeDays: row.lead_time_days,
    coatingCode: row.coating_code,
    diesOption: row.dies_option,
    diesTotalCost: num(row.dies_total_cost),
    weightTolerancePercent: num(row.weight_tolerance_percent),
    marginPercent: num(row.margin_percent),
    tradingItemId: row.trading_item_id,
    tradingQuoteId: row.trading_quote_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    needsRecalculation: !hasCurrentSnapshot,
  };
}

/** Metric CBP catalog sizes are named "M<diameter>" (M14, M20, ...) — derived from the nominal diameter rather than stored separately. */
export function deriveSizeLabel(diameterMm: number): string {
  return `M${diameterMm}`;
}
