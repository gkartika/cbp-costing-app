export type MaterialRow = { materialId: string; sourceKey: string; densityKgM3: number };

export type RawBarStockRow = {
  stockId: string;
  materialId: string;
  diameterMm: number;
  sizeCode: string | null;
};

export type DiesCostGuideRow = {
  diesCostId: string;
  productFamily: string;
  productProfile: string;
  sizeLabel: string;
  diameterMm: number;
  cost: number;
};

export type MaterialGradeMapRow = {
  mapId: string;
  materialId: string;
  productFamily: string;
  gradeOrSpec: string;
};

export type GradeProfileRuleRow = {
  ruleId: string;
  productFamily: string;
  gradeOrSpec: string;
  defaultProductProfile: string;
  /** Fuller standard designation for display only (e.g. "A194-2H" for grade_or_spec "2H"). Never a matching key. */
  displayLabel: string | null;
};

export type GradePriceAliasRow = {
  aliasId: string;
  productFamily: string;
  inputGrade: string;
  canonicalPriceGrade: string;
};

export type MaterialSizeGuideRow = {
  sizeGuideId: string;
  productProfile: string;
  sizeLabel: string;
  diameterMm: number | null;
  rawDiameterMm: number | null;
  widthFlat: number | null;
  widthCorner: number | null;
  headThickness: number | null;
  washerOd: number | null;
  washerThickness: number | null;
};

export type PricePerKgRow = {
  priceId: string;
  productFamily: string;
  gradeOrSpec: string;
  sizeLabel: string | null;
  sellingPricePerKg: number;
  threadCondition: string | null;
  productType: string | null;
};

export type CoatingPriceGuideRow = {
  coatingRuleId: string;
  processName: string;
  /** Human-facing name for display only (e.g. "Zinc" for process_name "Dies"). Never a matching key. */
  displayLabel: string | null;
  itemScope: string | null;
  minDiameterMm: number | null;
  basis: string;
  rate: number;
};

/** Selling-price floor per item, keyed by family + Stainless/Non-Stainless (CBP "minimum harga"). */
export type MinimumPriceRow = {
  minimumPriceId: string;
  productFamily: string;
  materialClass: "Stainless" | "Non-Stainless";
  minimumPrice: number;
};

export type AdjustmentRuleRow = {
  adjustmentRuleId: string;
  costingRoute: string;
  ruleGroup: string;
  scope: string;
  conditionField: string;
  thresholdMin: number | null;
  thresholdMax: number | null;
  adjustmentType: string;
  adjustmentValue: number;
  appliesToComponent: string;
  minInclusive: boolean;
  maxInclusive: boolean;
};

export type TradingItemRow = {
  tradingItemId: string;
  sourceKey: string;
  productCategory: string;
  sizeLabel: string;
};

export type TradingPriceTierRow = {
  tierId: string;
  tradingItemId: string;
  qtyMin: number;
  qtyMax: number | null;
  unitPrice: number;
};

export type CalculationFormulaRow = {
  formulaId: string;
  productFamily: string;
  formulaScope: string;
  formulaExpression: string;
  requiredInputs: string[];
};

export type CostingRouteRuleRow = {
  routeRuleId: string;
  productFamily: string;
  gradeOrSpec: string;
  allowedCostingRoute: string;
};

export type GuideContext = {
  guideVersionId: string;
  config: Map<string, string>;
  materials: MaterialRow[];
  rawBarStock: RawBarStockRow[];
  diesCostGuides: DiesCostGuideRow[];
  materialGradeMap: MaterialGradeMapRow[];
  gradeProfileRules: GradeProfileRuleRow[];
  gradePriceAliases: GradePriceAliasRow[];
  materialSizeGuides: MaterialSizeGuideRow[];
  pricePerKg: PricePerKgRow[];
  coatingPriceGuides: CoatingPriceGuideRow[];
  minimumPrices: MinimumPriceRow[];
  adjustmentRules: AdjustmentRuleRow[];
  tradingItems: TradingItemRow[];
  tradingPriceTiers: TradingPriceTierRow[];
  calculationFormulas: CalculationFormulaRow[];
  costingRouteRules: CostingRouteRuleRow[];
};

/** One resolved rule/row contributing to a calculation, kept for audit evidence (AUD-004). */
export type ResolvedRuleRef = { table: string; id: string; note?: string };
