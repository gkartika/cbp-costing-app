import { Errors } from "@/lib/errors";
import type {
  GuideContext,
  ResolvedRuleRef,
  MaterialSizeGuideRow,
  AdjustmentRuleRow,
  TradingPriceTierRow,
} from "./types";

/** Exactly one active default profile per (product_family, grade) — 06_RULE_ENGINE step 3. */
export function resolveProfile(
  ctx: GuideContext,
  productFamily: string,
  gradeOrSpec: string,
): { profile: string; ref: ResolvedRuleRef } {
  const matches = ctx.gradeProfileRules.filter(
    (r) => r.productFamily === productFamily && r.gradeOrSpec === gradeOrSpec,
  );
  if (matches.length === 0) throw Errors.profileNotFound();
  if (matches.length > 1) throw Errors.profileAmbiguous();
  const rule = matches[0];
  return { profile: rule.defaultProductProfile, ref: { table: "grade_profile_rules", id: rule.ruleId } };
}

/** Grade -> canonical price grade, one hop (circularity is rejected at import time, not here). */
export function resolveCanonicalPriceGrade(
  ctx: GuideContext,
  productFamily: string,
  gradeOrSpec: string,
): { canonicalGrade: string; ref: ResolvedRuleRef | null } {
  const alias = ctx.gradePriceAliases.find(
    (a) => a.productFamily === productFamily && a.inputGrade === gradeOrSpec,
  );
  if (!alias) return { canonicalGrade: gradeOrSpec, ref: null };
  return { canonicalGrade: alias.canonicalPriceGrade, ref: { table: "grade_price_aliases", id: alias.aliasId } };
}

/** 06_RULE_ENGINE step 4: recommended raw material dimensions for one profile+size. */
export function resolveSizeGuide(
  ctx: GuideContext,
  productProfile: string,
  sizeLabel: string,
): { row: MaterialSizeGuideRow; ref: ResolvedRuleRef } {
  const row = ctx.materialSizeGuides.find((r) => r.productProfile === productProfile && r.sizeLabel === sizeLabel);
  if (!row) throw Errors.rawSizeInvalid();
  return { row, ref: { table: "material_size_guides", id: row.sizeGuideId } };
}

/**
 * Raw bar diameter is material-dependent, not just profile+size-dependent —
 * the same Heavy Hex M22 needs a 22mm bar for A325/SCM440 but a 22.23mm bar
 * for A193-B8/SUS304, because that's what the Indonesian market actually
 * stocks (see DEC-039). Picks the smallest active raw_bar_stock diameter for
 * this material that is >= the nominal size (equal allowed — CBP confirmed
 * exact-nominal stock is usable, no oversize allowance required).
 *
 * A material with zero raw_bar_stock rows at all falls back to the size
 * guide's own raw_diameter_mm (untracked materials — this table was never
 * meant to cover, e.g. Washer plate stock). A material WITH stock rows but
 * nothing big enough for this nominal size is a genuine sourcing gap and
 * throws, rather than silently falling back to a diameter that may not
 * actually be purchasable.
 */
export function resolveRawBarDiameter(
  ctx: GuideContext,
  materialId: string,
  nominalDiameterMm: number,
  fallbackRawDiameterMm: number | null,
): { rawDiameterMm: number; ref: ResolvedRuleRef | null } {
  const candidates = ctx.rawBarStock.filter((r) => r.materialId === materialId);
  if (candidates.length === 0) {
    if (fallbackRawDiameterMm === null) throw Errors.rawSizeInvalid();
    return { rawDiameterMm: fallbackRawDiameterMm, ref: null };
  }
  const fitting = candidates.filter((r) => r.diameterMm >= nominalDiameterMm - 1e-9);
  if (fitting.length === 0) throw Errors.rawBarUnavailable();
  const best = fitting.reduce((min, r) => (r.diameterMm < min.diameterMm ? r : min));
  return { rawDiameterMm: best.diameterMm, ref: { table: "raw_bar_stock", id: best.stockId } };
}

/**
 * Dies/tooling cost for the "Tidak" (system-supplied) option — the real CBP
 * cetakan card is keyed by (product_family, product_profile, size), not
 * grade, since mold cost tracks hex geometry, not the steel it cuts. A metric
 * nominal diameter maps onto the nearest bigger Inch size in that same card
 * (business decision 2026-08-25 — e.g. M12 Hex Bolt follows the 1/2" price,
 * M24 Heavy Hex Bolt follows the 1" price). A nominal diameter beyond the
 * card's largest entry is capped at that largest entry rather than thrown,
 * since this is a cost estimate, not a genuine sourcing constraint.
 */
export function resolveDiesCost(
  ctx: GuideContext,
  params: { productFamily: string; productProfile: string; diameterMm: number },
): { cost: number; ref: ResolvedRuleRef } {
  const candidates = ctx.diesCostGuides.filter(
    (r) => r.productFamily === params.productFamily && r.productProfile === params.productProfile,
  );
  if (candidates.length === 0) throw Errors.diesCostGuideNotFound();
  const fitting = candidates.filter((r) => r.diameterMm >= params.diameterMm - 1e-9);
  const best =
    fitting.length > 0
      ? fitting.reduce((min, r) => (r.diameterMm < min.diameterMm ? r : min))
      : candidates.reduce((max, r) => (r.diameterMm > max.diameterMm ? r : max));
  return { cost: best.cost, ref: { table: "dies_cost_guides", id: best.diesCostId } };
}

/**
 * CBP's minimum selling price per item ("minimum harga"), keyed by product
 * family and Stainless/Non-Stainless. Returns null when no floor is published
 * for that combination — families without a card (Washer, Stud/Anchor) simply
 * have no floor, which must not be confused with a floor of zero.
 */
export function resolveMinimumPrice(
  ctx: GuideContext,
  productFamily: string,
  materialClass: "Stainless" | "Non-Stainless",
): { minimumPrice: number; ref: ResolvedRuleRef } | null {
  const row = ctx.minimumPrices.find((m) => m.productFamily === productFamily && m.materialClass === materialClass);
  if (!row) return null;
  return { minimumPrice: row.minimumPrice, ref: { table: "minimum_prices", id: row.minimumPriceId } };
}

/** 06_RULE_ENGINE step 5: width_corner when present, otherwise width_flat x 1.154. */
export function resolveEffectiveWidthCorner(sizeGuide: MaterialSizeGuideRow): number {
  if (sizeGuide.widthCorner !== null) return sizeGuide.widthCorner;
  if (sizeGuide.widthFlat !== null) return sizeGuide.widthFlat * 1.154;
  throw Errors.hexWidthMissing();
}

/**
 * 06_RULE_ENGINE step 13: raw base = costing_weight x price_per_kg.
 *
 * A family+grade+size combo can have more than one priced row when the real
 * guide distinguishes by thread condition (Bolt HT vs FT — same grade and
 * size, different price) or by product type (Stud vs Anchor within the
 * "Stud / Anchor" family — real data sets thread_condition to the same value
 * for both, so it never disambiguates that family; product_type does). When
 * multiple rows match, the caller's discriminators must narrow it to exactly
 * one; an ambiguous or unmatched combination is rejected rather than
 * silently picking one, since the wrong pick is a wrong price.
 *
 * A discriminator of `undefined` means the caller doesn't use that dimension
 * for this family at all — skip it. `null` means "match a row where the
 * field itself is unset" (e.g. no thread condition was selected yet).
 *
 * When no row exists at the exact size, the SAME grade's smallest priced size
 * at or above the requested diameter is used instead (business decision
 * 2026-09-04 — e.g. Nut A563 has no card entry below M27, matching grade
 * 4.6's own floor, so an M20 line takes the M27 rate). This never crosses
 * into a different grade and never falls back to a smaller size, either of
 * which would misrepresent what was actually quoted. It only runs when the
 * exact size has no row at all; an ambiguous exact match (ranked above) is a
 * missing discriminator, not a missing size, and is rejected as before.
 * Requires the caller to pass `nominalDiameterMm` — omitted, the fallback is
 * skipped and behaviour is unchanged.
 */
export function resolvePricePerKg(
  ctx: GuideContext,
  productFamily: string,
  canonicalGrade: string,
  sizeLabel: string,
  discriminators: { threadCondition?: string | null; productTypeLabel?: string | null; nominalDiameterMm?: number } = {},
): { pricePerKg: number; ref: ResolvedRuleRef } {
  const narrow = (rows: (typeof ctx.pricePerKg)[number][]) => {
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0];
    const narrowed = rows.filter((r) => {
      const threadOk =
        discriminators.threadCondition === undefined ? true : r.threadCondition === discriminators.threadCondition;
      const typeOk =
        discriminators.productTypeLabel === undefined
          ? true
          : discriminators.productTypeLabel === null
            ? r.productType === null
            : (r.productType ?? "").toLowerCase().includes(discriminators.productTypeLabel.toLowerCase());
      return threadOk && typeOk;
    });
    return narrowed.length === 1 ? narrowed[0] : null;
  };

  const exact = ctx.pricePerKg.filter(
    (r) => r.productFamily === productFamily && r.gradeOrSpec === canonicalGrade && r.sizeLabel === sizeLabel,
  );
  if (exact.length > 0) {
    const row = narrow(exact);
    if (!row) throw Errors.priceGuideNotFound();
    return { pricePerKg: row.sellingPricePerKg, ref: { table: "price_per_kg", id: row.priceId } };
  }

  if (discriminators.nominalDiameterMm !== undefined) {
    const bigger = ctx.pricePerKg.filter(
      (r) =>
        r.productFamily === productFamily &&
        r.gradeOrSpec === canonicalGrade &&
        r.diameterMm !== null &&
        r.diameterMm >= discriminators.nominalDiameterMm! - 1e-9,
    );
    const ascendingDiameters = [...new Set(bigger.map((r) => r.diameterMm!))].sort((a, b) => a - b);
    for (const d of ascendingDiameters) {
      const row = narrow(bigger.filter((r) => r.diameterMm === d));
      if (row) {
        return {
          pricePerKg: row.sellingPricePerKg,
          ref: {
            table: "price_per_kg",
            id: row.priceId,
            note: `Tidak ada harga di ukuran ${sizeLabel}; menggunakan ukuran lebih besar berikutnya (${row.sizeLabel}) pada grade yang sama (${canonicalGrade}).`,
          },
        };
      }
    }
  }

  throw Errors.priceGuideNotFound();
}

function inRange(rule: AdjustmentRuleRow, value: number): boolean {
  const min = rule.thresholdMin ?? -Infinity;
  const max = rule.thresholdMax ?? Infinity;
  const minOk = rule.minInclusive ? value >= min : value > min;
  const maxOk = rule.maxInclusive ? value <= max : value < max;
  return minOk && maxOk;
}

/**
 * 06_RULE_ENGINE step 14: select the single matching adjustment rule for one
 * family (quantity / lead-time / length / coating-weight). Import-time
 * validation (VAL-025) is what actually guarantees non-overlapping ranges;
 * this still defends against bad data reaching a published version.
 *
 * Returns `null` when the scope simply has no rules defined at all (the
 * adjustment doesn't apply to this product — e.g. Nut has no lead-time
 * rules). Throws ADJUSTMENT_NO_MATCH only when rules DO exist for the scope
 * but none cover the given value (a genuine gap, e.g. lead_time_days=8).
 */
export function resolveAdjustmentRule(
  ctx: GuideContext,
  params: { costingRoute: string; ruleGroup: string; scope: string; value: number },
): { rule: AdjustmentRuleRow; ref: ResolvedRuleRef } | null {
  const candidates = ctx.adjustmentRules.filter(
    (r) => r.costingRoute === params.costingRoute && r.ruleGroup === params.ruleGroup && r.scope === params.scope,
  );
  if (candidates.length === 0) return null;
  const matches = candidates.filter((r) => inRange(r, params.value));
  if (matches.length === 0) throw Errors.adjustmentNoMatch();
  if (matches.length > 1) throw Errors.adjustmentAmbiguous();
  const rule = matches[0];
  return { rule, ref: { table: "adjustment_rules", id: rule.adjustmentRuleId } };
}

/**
 * Coating rate lookup: exact process name, product-family scope, and the
 * highest min_diameter_mm breakpoint the line's diameter still clears (rates
 * step up/down at published diameter thresholds, e.g. HDG M10 vs M18 vs M27).
 */
export function resolveCoatingRule(
  ctx: GuideContext,
  params: { processName: string; productFamily: string; diameterMm: number },
): { rule: (typeof ctx.coatingPriceGuides)[number]; ref: ResolvedRuleRef } {
  const scoped = ctx.coatingPriceGuides.filter((r) => {
    if (r.processName !== params.processName) return false;
    if (!r.itemScope) return true;
    const scope = r.itemScope.toLowerCase();
    return scope.includes("all") || scope.includes(params.productFamily.toLowerCase());
  });
  if (scoped.length === 0) throw Errors.coatingGuideNotFound();

  const fitting = scoped.filter((r) => r.minDiameterMm === null || params.diameterMm >= r.minDiameterMm);
  if (fitting.length > 0) {
    const best = fitting.reduce((a, b) => ((b.minDiameterMm ?? -Infinity) > (a.minDiameterMm ?? -Infinity) ? b : a));
    return { rule: best, ref: { table: "coating_price_guides", id: best.coatingRuleId } };
  }

  // Smaller than every tiered size (e.g. a 1/4" bolt under HDG's 8mm floor) —
  // CBP confirmed 2026-09-12: use the next tier up rather than refuse, the
  // same "never smaller, never a different scope" fallback resolvePricePerKg
  // already applies to price_per_kg gaps, now generalized to every coating.
  const smallest = scoped.reduce((a, b) => ((b.minDiameterMm ?? Infinity) < (a.minDiameterMm ?? Infinity) ? b : a));
  return {
    rule: smallest,
    ref: {
      table: "coating_price_guides",
      id: smallest.coatingRuleId,
      note: `Tidak ada tarif ${params.processName} untuk diameter ${params.diameterMm}mm; menggunakan tarif ukuran lebih besar berikutnya (mulai ${smallest.minDiameterMm}mm).`,
    },
  };
}

/** Resolves the fixed-pricelist trading item for a product category + size (SCP-002). */
export function resolveTradingItem(
  ctx: GuideContext,
  productCategory: string,
  sizeLabel: string,
): { tradingItemId: string; ref: ResolvedRuleRef } | null {
  const item = ctx.tradingItems.find((t) => t.productCategory === productCategory && t.sizeLabel === sizeLabel);
  if (!item) return null;
  return { tradingItemId: item.tradingItemId, ref: { table: "trading_items", id: item.tradingItemId } };
}

/**
 * Resolves the fixed-pricelist trading item the costing line actually
 * points at (costing_lines.trading_item_id). category + size alone is
 * ambiguous whenever more than one item shares a size (routine for Nut,
 * where dozens of items across grades can share a size_label) — resolving
 * by the specific id the user selected, instead of re-deriving from
 * category + size, is what makes the right item's price win.
 */
export function resolveTradingItemById(
  ctx: GuideContext,
  tradingItemId: string,
  productCategory: string,
): { tradingItemId: string; ref: ResolvedRuleRef } | null {
  const item = ctx.tradingItems.find((t) => t.tradingItemId === tradingItemId && t.productCategory === productCategory);
  if (!item) return null;
  return { tradingItemId: item.tradingItemId, ref: { table: "trading_items", id: item.tradingItemId } };
}

/**
 * Trading tier lookup with the configured inherit-previous-lower-qty-tier
 * fallback (TRADING_TIER_NO_MATCH_BEHAVIOR): an exact covering tier wins;
 * if qty falls in an unlisted gap above the highest defined tier, the
 * nearest lower tier's price carries forward. AT-TRADING-002/003.
 */
export function resolveTradingTier(
  ctx: GuideContext,
  tradingItemId: string,
  qty: number,
): { tier: TradingPriceTierRow; ref: ResolvedRuleRef; inherited: boolean } {
  const tiers = ctx.tradingPriceTiers.filter((t) => t.tradingItemId === tradingItemId);

  const exact = tiers.find((t) => qty >= t.qtyMin && (t.qtyMax === null || qty <= t.qtyMax));
  if (exact) return { tier: exact, ref: { table: "trading_price_tiers", id: exact.tierId }, inherited: false };

  const lowerTiers = tiers.filter((t) => t.qtyMin <= qty);
  if (lowerTiers.length === 0) throw Errors.tradingTierNotFound();
  const nearest = lowerTiers.reduce((a, b) => (b.qtyMin > a.qtyMin ? b : a));
  return { tier: nearest, ref: { table: "trading_price_tiers", id: nearest.tierId }, inherited: true };
}
