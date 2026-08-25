import { Errors } from "@/lib/errors";
import type { GuideContext, ResolvedRuleRef } from "./types";
import { resolveTradingItem, resolveTradingItemById, resolveTradingTier } from "./resolvers";
import { getConfigNumber } from "./appConfig";
import { computeCoatingPrice } from "./coating";
import { ceilingToIncrement } from "./rounding";

export type TradingLineResult = {
  basePricePerItem: number;
  coatingPricePerItem: number;
  unitPriceBeforeRounding: number;
  unitSellingPrice: number;
  orderTotal: number;
  resolvedRuleRefs: ResolvedRuleRef[];
};

/** 06_RULE_ENGINE step 16: fixed pricelist tier route (e.g. Washer F436). */
export function calculateTradingPricelistLine(
  ctx: GuideContext,
  input: {
    productCategory: string;
    sizeLabel: string;
    qty: number;
    coatingCode: string | null;
    productTypeLabel: string;
    diameterMm: number;
    /** The specific item the user selected (costing_lines.trading_item_id). When present, this is
     * resolved directly instead of re-deriving from category + size, which is ambiguous whenever
     * more than one item shares a size. Optional only for callers (older stored Simulation_Cases,
     * single-item-per-size categories) that predate this field. */
    tradingItemId?: string | null;
  },
): TradingLineResult {
  const refs: ResolvedRuleRef[] = [];
  const item = input.tradingItemId
    ? resolveTradingItemById(ctx, input.tradingItemId, input.productCategory)
    : resolveTradingItem(ctx, input.productCategory, input.sizeLabel);
  if (!item) throw Errors.tradingTierNotFound();
  refs.push(item.ref);

  const { tier, ref: tierRef } = resolveTradingTier(ctx, item.tradingItemId, input.qty);
  refs.push(tierRef);

  return finishTradingLine(ctx, {
    basePricePerItem: tier.unitPrice,
    qty: input.qty,
    coatingCode: input.coatingCode,
    productTypeLabel: input.productTypeLabel,
    diameterMm: input.diameterMm,
    refs,
  });
}

/** 06_RULE_ENGINE steps 17-18: user-selected trading quote, tax-normalized, marked up by margin. */
export function calculateTradingQuoteLine(
  ctx: GuideContext,
  input: {
    quotedPrice: number;
    taxBasis: "INCLUDE_PPN" | "EXCLUDE_PPN";
    ppnRate: number | null;
    landedCostConfirmed: boolean;
    marginPercent: number | null;
    qty: number;
    coatingCode: string | null;
    productTypeLabel: string;
    diameterMm: number;
  },
): TradingLineResult {
  const refs: ResolvedRuleRef[] = [];
  if (!input.landedCostConfirmed) throw Errors.landedCostConfirmationRequired();

  let exTaxPrice = input.quotedPrice;
  if (input.taxBasis === "INCLUDE_PPN") {
    if (input.ppnRate === null || input.ppnRate < 0) throw Errors.ppnRateRequired();
    exTaxPrice = input.quotedPrice / (1 + input.ppnRate);
  }

  const marginPercent = input.marginPercent ?? getConfigNumber(ctx, "TRADING_DEFAULT_MARGIN");
  if (marginPercent < 0 || marginPercent >= 1) throw Errors.marginInvalid();

  const basePricePerItem = exTaxPrice / (1 - marginPercent);

  return finishTradingLine(ctx, {
    basePricePerItem,
    qty: input.qty,
    coatingCode: input.coatingCode,
    productTypeLabel: input.productTypeLabel,
    diameterMm: input.diameterMm,
    refs,
  });
}

function finishTradingLine(
  ctx: GuideContext,
  params: {
    basePricePerItem: number;
    qty: number;
    coatingCode: string | null;
    productTypeLabel: string;
    diameterMm: number;
    refs: ResolvedRuleRef[];
  },
): TradingLineResult {
  // Trading route has no weight/costing_weight concept of its own; coating
  // (when applicable) is keyed off the item's nominal weight per kg the same
  // way Custom is, but Trading items in this guide never carry coating in
  // the fixtures, so costingWeightPerItemKg of 0 with no coatingCode is a no-op.
  const coating = computeCoatingPrice(ctx, {
    coatingCode: params.coatingCode,
    productTypeLabel: params.productTypeLabel,
    diameterMm: params.diameterMm,
    costingWeightPerItemKg: 0,
    qty: params.qty,
    lengthMm: null,
  });

  const unitPriceBeforeRounding = params.basePricePerItem + coating.coatingPricePerItem;
  const roundingIncrement = getConfigNumber(ctx, "ROUNDING_INCREMENT");
  const unitSellingPrice = ceilingToIncrement(unitPriceBeforeRounding, roundingIncrement);
  const orderTotal = unitSellingPrice * params.qty;

  return {
    basePricePerItem: params.basePricePerItem,
    coatingPricePerItem: coating.coatingPricePerItem,
    unitPriceBeforeRounding,
    unitSellingPrice,
    orderTotal,
    resolvedRuleRefs: [...params.refs, ...coating.refs],
  };
}
