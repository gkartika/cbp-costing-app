import type { GuideContext, ResolvedRuleRef } from "./types";
import { resolveCoatingRule, resolveAdjustmentRule } from "./resolvers";

export type CoatingResult = {
  coatingPricePerItem: number;
  refs: ResolvedRuleRef[];
};

/**
 * 06_RULE_ENGINE step 19, shared by Trading and Custom routes:
 * coating_price_per_item = costing_weight_per_item_kg x effective_rate, where
 * effective_rate is the published rate plus any additive per-kg surcharges
 * (e.g. stud length), and the result is then scaled by any multiplicative
 * order-weight discount factors (applied to price, never to weight).
 */
export function computeCoatingPrice(
  ctx: GuideContext,
  params: {
    coatingCode: string | null;
    /** Plain product-type label used for coating scope matching (e.g. "Bolt", "Nut", "Washer", "Stud", "Anchor") — deliberately distinct from costing_lines.product_family, which groups Stud and Anchor together. */
    productTypeLabel: string;
    diameterMm: number;
    costingWeightPerItemKg: number;
    qty: number;
    lengthMm: number | null;
  },
): CoatingResult {
  if (!params.coatingCode) return { coatingPricePerItem: 0, refs: [] };

  const refs: ResolvedRuleRef[] = [];
  const { rule: baseRule, ref: baseRef } = resolveCoatingRule(ctx, {
    processName: params.coatingCode,
    productFamily: params.productTypeLabel,
    diameterMm: params.diameterMm,
  });
  refs.push(baseRef);

  let effectiveRate = baseRule.rate;
  if (params.lengthMm !== null) {
    const lengthSurcharge = resolveAdjustmentRule(ctx, {
      costingRoute: "Custom Production",
      ruleGroup: "Length Surcharge",
      scope: `${params.coatingCode} ${params.productTypeLabel}`,
      value: params.lengthMm,
    });
    // Length-surcharge rules are additive to the per-kg rate, not to the final price.
    if (lengthSurcharge && lengthSurcharge.rule.adjustmentType === "IDR_per_kg_add") {
      effectiveRate += lengthSurcharge.rule.adjustmentValue;
      refs.push(lengthSurcharge.ref);
    }
  }

  let price = params.costingWeightPerItemKg * effectiveRate;

  const totalOrderCoatingWeightKg = params.costingWeightPerItemKg * params.qty;
  const orderWeightAdjustment = resolveAdjustmentRule(ctx, {
    costingRoute: "Custom Production",
    ruleGroup: "Coating Order Weight",
    scope: params.coatingCode,
    value: totalOrderCoatingWeightKg,
  });
  if (orderWeightAdjustment && orderWeightAdjustment.rule.adjustmentType === "percent_add") {
    price *= 1 + orderWeightAdjustment.rule.adjustmentValue;
    refs.push(orderWeightAdjustment.ref);
  }

  return { coatingPricePerItem: price, refs };
}
