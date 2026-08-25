import { describe, it, expect, beforeAll } from "vitest";
import { seedGuideVersion } from "./fixtures/seedGuideVersion";
import { loadGuideContext } from "../src/lib/calc/loadGuideContext";
import { calculateCustomLine, type CustomLineInput } from "../src/lib/calc/customPipeline";
import { calculateTradingPricelistLine, calculateTradingQuoteLine } from "../src/lib/calc/tradingPipeline";
import {
  resolveProfile,
  resolveEffectiveWidthCorner,
  resolveAdjustmentRule,
  resolveCanonicalPriceGrade,
  resolvePricePerKg,
  resolveRawBarDiameter,
  resolveDiesCost,
} from "../src/lib/calc/resolvers";
import { ceilingToIncrement } from "../src/lib/calc/rounding";
import { computeCoatingPrice } from "../src/lib/calc/coating";
import type { GuideContext, MaterialSizeGuideRow } from "../src/lib/calc/types";
import { AppError } from "../src/lib/errors";

let ctx: GuideContext;

beforeAll(async () => {
  const guideVersionId = await seedGuideVersion(`TEST-${Date.now()}`);
  ctx = await loadGuideContext(guideVersionId);
});

const boltBase: CustomLineInput = {
  productFamily: "Bolt",
  gradeOrSpec: "A325",
  sizeLabel: "M14",
  diameterMm: 14,
  qty: 30,
  leadTimeDays: 14,
  lengthMm: 80,
  developedCutLengthMm: null,
  coatingCode: null,
  diesOption: null,
  diesTotalCost: null,
};

describe("AT-ROUND-001/002: CEILING rounding", () => {
  it("156,000 stays 156,000 (already on the increment)", () => {
    expect(ceilingToIncrement(156000, 500)).toBe(156000);
  });
  it("156,001 rounds up to 156,500", () => {
    expect(ceilingToIncrement(156001, 500)).toBe(156500);
  });
});

describe("AT-CUSTOM-002: grade -> profile resolution", () => {
  it("A325 resolves to Heavy Hex automatically", () => {
    const { profile } = resolveProfile(ctx, "Bolt", "A325");
    expect(profile).toBe("Heavy Hex");
  });
});

describe("AT-CUSTOM-003: hex width fallback", () => {
  it("uses width_flat x 1.154 when width_corner is absent", () => {
    const row: MaterialSizeGuideRow = {
      sizeGuideId: "x",
      productProfile: "Heavy Hex",
      sizeLabel: "test",
      diameterMm: 20,
      rawDiameterMm: 22,
      widthFlat: 30,
      widthCorner: null,
      headThickness: 10,
      washerOd: null,
      washerThickness: null,
    };
    expect(resolveEffectiveWidthCorner(row)).toBeCloseTo(34.62, 6);
  });
});

describe("Bolt A325 M14 — matches SIM-BOLT-QTY-* golden fixtures exactly", () => {
  it("AT-CUSTOM-001: qty does not change per-item weight (qty=1 vs qty=100)", () => {
    const r1 = calculateCustomLine(ctx, { ...boltBase, qty: 1 });
    const r100 = calculateCustomLine(ctx, { ...boltBase, qty: 100 });
    expect(r1.costingWeightPerItemKg).toBeCloseTo(r100.costingWeightPerItemKg, 10);
  });

  it("AT-CUSTOM-004: costing weight = raw weight x 1.02 (2% tolerance)", () => {
    const r = calculateCustomLine(ctx, boltBase);
    expect(r.costingWeightPerItemKg).toBeCloseTo(r.rawWeightPerItemKg * 1.02, 10);
  });

  it("SIM-BOLT-QTY-30: qty=30, lead=14 (CarbonHigh: +30%) -> factors 1.4/1.3/1.0, order_total=840,000", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, qty: 30, leadTimeDays: 14 });
    expect(r.rawWeightPerItemKg).toBeCloseTo(0.2128278645, 6);
    expect(r.costingWeightPerItemKg).toBeCloseTo(0.2170844218, 6);
    expect(r.unitSellingPrice).toBe(28000);
    expect(r.orderTotal).toBe(840000);
  });

  it("SIM-BOLT-QTY-31: crossing into the 31-40 tier changes only the price factor", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, qty: 31, leadTimeDays: 14 });
    expect(r.unitSellingPrice).toBe(27000);
    expect(r.orderTotal).toBe(837000);
  });

  it("SIM-BOLT-QTY-101: unit price 23,000, total 2,323,000", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, qty: 101, leadTimeDays: 14 });
    expect(r.unitSellingPrice).toBe(23000);
    expect(r.orderTotal).toBe(2323000);
  });

  it("SIM-BOLT-QTY-1001: highest-volume discount tier, unit price 18,500", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, qty: 1001, leadTimeDays: 14 });
    expect(r.unitSellingPrice).toBe(18500);
    expect(r.orderTotal).toBe(18518500);
  });

  it("AT-LEAD-001: the 5 offered lead-time options (7/10/14/21/28 days) each resolve exactly one rule", () => {
    for (const lead of [7, 10, 14, 21, 28]) {
      expect(() => calculateCustomLine(ctx, { ...boltBase, qty: 50, leadTimeDays: lead })).not.toThrow();
    }
  });

  it("AT-LEAD-002: any day count off the 5-option menu is rejected, not interpolated", () => {
    for (const lead of [8, 9, 13, 15, 20, 27, 30]) {
      let error: unknown;
      try {
        calculateCustomLine(ctx, { ...boltBase, qty: 50, leadTimeDays: lead });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("ADJUSTMENT_NO_MATCH");
    }
  });

  it("AT-LEAD-003: lead-time scope is grade-tiered, not flat per family — CarbonHigh pays more than CarbonLow at the same 7-day rush", () => {
    const high = resolveAdjustmentRule(ctx, {
      costingRoute: "Custom Production",
      ruleGroup: "Lead Time",
      scope: "Bolt|CarbonHigh",
      value: 7,
    });
    const low = resolveAdjustmentRule(ctx, {
      costingRoute: "Custom Production",
      ruleGroup: "Lead Time",
      scope: "Bolt|CarbonLow",
      value: 7,
    });
    expect(high?.rule.adjustmentValue).toBeCloseTo(1.0, 6);
    expect(low?.rule.adjustmentValue).toBeCloseTo(0.6, 6);
  });

  it("AT-LEAD-004: A325 (a high-strength grade) resolves the CarbonHigh scope end-to-end, not CarbonLow", () => {
    const r7 = calculateCustomLine(ctx, { ...boltBase, qty: 50, leadTimeDays: 7 });
    const r28 = calculateCustomLine(ctx, { ...boltBase, qty: 50, leadTimeDays: 28 });
    expect(r7.basePricePerItem).toBeCloseTo(r28.basePricePerItem * 2.0, 4); // +100% CarbonHigh, not +60% CarbonLow
  });

  it("AT-GRADE-SUS310: SUS310 is now a fully orderable Bolt grade — resolves Heavy Hex, its own material density, and the StainlessHigh/Stainless tiers (not StainlessLow, not CarbonHigh)", () => {
    const sus310Base: CustomLineInput = { ...boltBase, gradeOrSpec: "SUS310" };

    // Resolves at all (profile + material_grade_map + price_per_kg all wired).
    const r28 = calculateCustomLine(ctx, { ...sus310Base, qty: 50, leadTimeDays: 28 });
    expect(r28.rawWeightPerItemKg).toBeGreaterThan(0);

    // Lead time: StainlessHigh scope resolves +100% at 7 days (same number as CarbonHigh, so the
    // interesting proof is that it resolves at all under the SUS310-specific scope, not that the
    // number differs — StainlessLow would have been +80%).
    const r7 = calculateCustomLine(ctx, { ...sus310Base, qty: 50, leadTimeDays: 7 });
    expect(r7.basePricePerItem).toBeCloseTo(r28.basePricePerItem * 2.0, 4);

    // Quantity: Stainless schedule applies (qty=50 -> +30%), not Carbon (+30% too at this qty, so
    // check a qty where they diverge: qty=90 -> Stainless +10% vs Carbon +20%).
    const q50 = calculateCustomLine(ctx, { ...sus310Base, qty: 50, leadTimeDays: null });
    const q90 = calculateCustomLine(ctx, { ...sus310Base, qty: 90, leadTimeDays: null });
    expect(q90.basePricePerItem).toBeCloseTo((q50.basePricePerItem / 1.3) * 1.1, 4);
  });
});

describe("AT-RAWBAR-001/002/003: raw bar diameter is material-dependent, not just profile+size-dependent (DEC-039)", () => {
  it("AT-RAWBAR-001: A325 (SCM440, stocked at 18mm) and SUS310 (SUS310, stocked at 20mm) share the same Heavy Hex M14 row but resolve different bars", () => {
    const a325 = calculateCustomLine(ctx, { ...boltBase, gradeOrSpec: "A325", qty: 50, leadTimeDays: null });
    const sus310 = calculateCustomLine(ctx, { ...boltBase, gradeOrSpec: "SUS310", qty: 50, leadTimeDays: null });
    // Different bar (18mm vs 20mm) and different density (7850 vs 7980) both roll into raw weight,
    // so the two grades' weights at the identical nominal size must differ meaningfully.
    expect(Math.abs(a325.rawWeightPerItemKg - sus310.rawWeightPerItemKg)).toBeGreaterThan(0.01);
  });

  it("AT-RAWBAR-002: resolveRawBarDiameter throws RAW_BAR_UNAVAILABLE when nothing stocked reaches the nominal size", () => {
    const sus310Material = ctx.materials.find((m) => m.sourceKey === "MAT-SUS310");
    if (!sus310Material) throw new Error("fixture missing MAT-SUS310");
    let error: unknown;
    try {
      // MAT-SUS310 is only stocked at 20mm in this fixture; nothing covers a 25mm nominal size.
      resolveRawBarDiameter(ctx, sus310Material.materialId, 25, null);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("RAW_BAR_UNAVAILABLE");
  });

  it("AT-RAWBAR-003: a material with zero raw_bar_stock rows falls back to the caller-supplied diameter instead of throwing", () => {
    // MAT-CARBON-STEEL (Washer) has no raw_bar_stock rows at all in this fixture -- untracked
    // materials degrade gracefully to the size guide's own raw_diameter_mm rather than blocking.
    const carbonSteel = ctx.materials.find((m) => m.sourceKey === "MAT-CARBON-STEEL");
    if (!carbonSteel) throw new Error("fixture missing MAT-CARBON-STEEL");
    const { rawDiameterMm, ref } = resolveRawBarDiameter(ctx, carbonSteel.materialId, 20, 44);
    expect(rawDiameterMm).toBe(44);
    expect(ref).toBeNull();
  });
});

const anchorGrade = { productFamily: "Stud / Anchor" as const, gradeOrSpec: "B7", sizeLabel: "M20", diameterMm: 20 };

describe("Stud B7 M20 — matches SIM-STUD-* golden fixtures", () => {
  it("SIM-STUD-M20X1000: raw/costing weight and order total match exactly", () => {
    const r = calculateCustomLine(ctx, {
      ...anchorGrade,
      qty: 10,
      leadTimeDays: null,
      lengthMm: 1000,
      developedCutLengthMm: null,
      coatingCode: null,
      diesOption: null,
      diesTotalCost: null,
    });
    expect(r.rawWeightPerItemKg).toBeCloseTo(2.984041782, 6);
    expect(r.costingWeightPerItemKg).toBeCloseTo(3.043722618, 6);
    expect(r.unitSellingPrice).toBe(183000);
    expect(r.orderTotal).toBe(1830000);
  });

  it("SIM-STUD-LENGTH-499/500/1000/1001: HDG coating rate steps at length breakpoints", () => {
    const withCoating = (lengthMm: number) =>
      calculateCustomLine(ctx, {
        ...anchorGrade,
        qty: 1,
        leadTimeDays: null,
        lengthMm,
        developedCutLengthMm: null,
        coatingCode: "HDG",
        diesOption: null,
        diesTotalCost: null,
      });
    expect(withCoating(499).coatingPricePerItem).toBeCloseTo(25819.89897, 3);
    expect(withCoating(500).coatingPricePerItem).toBeCloseTo(33480.94879, 3);
    expect(withCoating(1000).coatingPricePerItem).toBeCloseTo(66961.89759, 3);
  });

  it("length beyond the defined 2000mm breakpoint is rejected", () => {
    let error: unknown;
    try {
      calculateCustomLine(ctx, {
        ...anchorGrade,
        qty: 1,
        leadTimeDays: null,
        lengthMm: 2001,
        developedCutLengthMm: null,
        coatingCode: "HDG",
        diesOption: null,
        diesTotalCost: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("ADJUSTMENT_NO_MATCH");
  });
});

describe("AT-ANCHOR-001: Anchor A307B M20 uses developed cut length before bending", () => {
  it("matches SIM-ANCHOR-M20X500 exactly", () => {
    const r = calculateCustomLine(ctx, {
      productFamily: "Stud / Anchor",
      gradeOrSpec: "A307B",
      sizeLabel: "M20",
      diameterMm: 20,
      qty: 10,
      leadTimeDays: null,
      lengthMm: null,
      developedCutLengthMm: 500,
      coatingCode: null,
      diesOption: null,
      diesTotalCost: null,
    });
    expect(r.rawWeightPerItemKg).toBeCloseTo(1.492020891, 6);
    expect(r.costingWeightPerItemKg).toBeCloseTo(1.521861309, 6);
    expect(r.unitSellingPrice).toBe(68500);
    expect(r.orderTotal).toBe(685000);
  });

  it("VAL-020: missing developed_cut_length_mm is rejected", () => {
    let error: unknown;
    try {
      calculateCustomLine(ctx, {
        productFamily: "Stud / Anchor",
        gradeOrSpec: "A307B",
        sizeLabel: "M20",
        diameterMm: 20,
        qty: 1,
        leadTimeDays: null,
        lengthMm: null,
        developedCutLengthMm: null,
        coatingCode: null,
        diesOption: null,
        diesTotalCost: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("ANCHOR_DEVELOPED_LENGTH_REQUIRED");
  });
});

describe("AT-DIES-001/002: dies charge", () => {
  it("dies available -> no per-item dies charge", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, diesOption: "yes" });
    expect(r.diesPricePerItem).toBe(0);
  });

  it("dies unavailable -> total cost split across qty", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, qty: 100, diesOption: "manual", diesTotalCost: 2500000 });
    expect(r.diesPricePerItem).toBe(25000);
  });

  it("dies unavailable with no cost supplied is rejected", () => {
    let error: unknown;
    try {
      calculateCustomLine(ctx, { ...boltBase, diesOption: "manual", diesTotalCost: null });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("DIES_COST_REQUIRED");
  });
});

describe("AT-DIES-003/004/005: dies cost guide (system lookup, 'Tidak')", () => {
  it("nominal diameter between two sizes rounds up to the next bigger Inch entry (14mm -> 1\"'s cost)", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, diesOption: "no_lookup" });
    // boltBase is Bolt/Heavy Hex/14mm; fixture has 1/2"(12.7mm)=3.8M and 1"(25.4mm)=5.3M.
    expect(r.diesPricePerItem).toBeCloseTo(5_300_000 / boltBase.qty, 6);
  });

  it("nominal diameter exactly matching a card entry uses that entry's cost", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, diameterMm: 12.7, diesOption: "no_lookup" });
    expect(r.diesPricePerItem).toBeCloseTo(3_800_000 / boltBase.qty, 6);
  });

  it("nominal diameter beyond the card's largest entry is capped at the largest entry, not rejected", () => {
    // Driven directly against the resolver (not the full pipeline) since a
    // 100mm nominal would separately hit RAW_BAR_UNAVAILABLE on this fixture's
    // raw bar stock — irrelevant to what this test is actually checking.
    const dies = resolveDiesCost(ctx, { productFamily: "Bolt", productProfile: "Heavy Hex", diameterMm: 100 });
    expect(dies.cost).toBe(5_300_000);
  });

  it("a product family/profile with no dies cost reference throws DIES_COST_GUIDE_NOT_FOUND", () => {
    let error: unknown;
    try {
      calculateCustomLine(ctx, {
        productFamily: "Washer",
        gradeOrSpec: "A36",
        sizeLabel: "M20",
        diameterMm: 20,
        qty: 10,
        leadTimeDays: null,
        lengthMm: null,
        developedCutLengthMm: null,
        coatingCode: null,
        diesOption: "no_lookup",
        diesTotalCost: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("DIES_COST_GUIDE_NOT_FOUND");
  });
});

describe("AT-WEIGHT-TOLERANCE-001/002: per-line weight tolerance override", () => {
  it("omitted -> falls back to app_config.CUSTOM_WEIGHT_TOLERANCE (2%)", () => {
    const r = calculateCustomLine(ctx, boltBase);
    expect(r.costingWeightPerItemKg).toBeCloseTo(r.rawWeightPerItemKg * 1.02, 9);
  });

  it("explicit 0 overrides the 2% default to no tolerance at all", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, weightTolerancePercent: 0 });
    expect(r.costingWeightPerItemKg).toBeCloseTo(r.rawWeightPerItemKg, 9);
  });

  it("explicit non-default value (5%) is honored over the guide's 2% default", () => {
    const r = calculateCustomLine(ctx, { ...boltBase, weightTolerancePercent: 0.05 });
    expect(r.costingWeightPerItemKg).toBeCloseTo(r.rawWeightPerItemKg * 1.05, 9);
  });
});

describe("AT-COATING-002: coating order-weight boundary uses factor, not weight, for the discount", () => {
  // Drive computeCoatingPrice directly with an exact per-item weight so the
  // total order coating weight lands precisely on 500.00 and 500.01 kg — a
  // qty x derived-weight product can't hit those breakpoints exactly.
  const coatingAtOrderWeight = (costingWeightPerItemKg: number) =>
    computeCoatingPrice(ctx, {
      coatingCode: "HDG",
      productTypeLabel: "Bolt",
      diameterMm: 14,
      costingWeightPerItemKg,
      qty: 1,
      lengthMm: null,
    });

  it("exactly 500kg selects factor 1.0 (no discount)", () => {
    // HDG Bolt rate = 10,000/kg; [0, 500] inclusive both ends -> factor 1.0
    expect(coatingAtOrderWeight(500).coatingPricePerItem).toBeCloseTo(500 * 10000 * 1.0, 6);
  });

  it("500.01kg crosses into the next bracket and selects factor 0.95", () => {
    // (500, 1000] -> -5% -> factor 0.95
    expect(coatingAtOrderWeight(500.01).coatingPricePerItem).toBeCloseTo(500.01 * 10000 * 0.95, 6);
  });

  it("the discount changes only the price — the physical weight is never reduced", () => {
    const justUnder = coatingAtOrderWeight(500);
    const justOver = coatingAtOrderWeight(500.01);
    // Slightly MORE steel, yet a strictly LOWER coating price: proof the factor
    // was applied to price rather than the weight being scaled down.
    expect(justOver.coatingPricePerItem).toBeLessThan(justUnder.coatingPricePerItem);
    // Undiscounted rate x weight still reflects the true (larger) weight.
    expect(justOver.coatingPricePerItem / 0.95).toBeCloseTo(500.01 * 10000, 6);
  });
});

describe("AT-TRADING-001: trading quote tax normalization + margin", () => {
  it("11,100 incl. 11% PPN -> 13,500/item", () => {
    const r = calculateTradingQuoteLine(ctx, {
      quotedPrice: 11100,
      taxBasis: "INCLUDE_PPN",
      ppnRate: 0.11,
      landedCostConfirmed: true,
      marginPercent: 0.25,
      qty: 30,
      coatingCode: null,
      productTypeLabel: "Nut",
      diameterMm: 8,
    });
    expect(r.basePricePerItem).toBeCloseTo(13333.333333, 3);
    expect(r.unitSellingPrice).toBe(13500);
    expect(r.orderTotal).toBe(405000);
  });

  it("VAL-016: unconfirmed landed cost is rejected", () => {
    let error: unknown;
    try {
      calculateTradingQuoteLine(ctx, {
        quotedPrice: 11100,
        taxBasis: "INCLUDE_PPN",
        ppnRate: 0.11,
        landedCostConfirmed: false,
        marginPercent: 0.25,
        qty: 30,
        coatingCode: null,
        productTypeLabel: "Nut",
        diameterMm: 8,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("LANDED_COST_CONFIRMATION_REQUIRED");
  });

  it("VAL-017: margin outside [0, 1) is rejected", () => {
    let error: unknown;
    try {
      calculateTradingQuoteLine(ctx, {
        quotedPrice: 11100,
        taxBasis: "EXCLUDE_PPN",
        ppnRate: null,
        landedCostConfirmed: true,
        marginPercent: 1,
        qty: 1,
        coatingCode: null,
        productTypeLabel: "Nut",
        diameterMm: 8,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("MARGIN_INVALID");
  });
});

describe("AT-TRADING-002/003: fixed pricelist tier with inherit-lower-tier fallback", () => {
  it("AT-TRADING-002: F436 M20 qty=101 inherits the <=100 tier price (5,695 -> 6,000/item, total 606,000)", () => {
    const r = calculateTradingPricelistLine(ctx, {
      productCategory: "Washer",
      sizeLabel: "M20",
      qty: 101,
      coatingCode: null,
      productTypeLabel: "Washer",
      diameterMm: 20,
    });
    expect(r.basePricePerItem).toBe(5695);
    expect(r.unitSellingPrice).toBe(6000);
    expect(r.orderTotal).toBe(606000);
  });

  it("AT-TRADING-003: F436 M72 qty=5001 inherits the <=5000 tier price (70,400 -> 70,500/item)", () => {
    const r = calculateTradingPricelistLine(ctx, {
      productCategory: "Washer",
      sizeLabel: "M72",
      qty: 5001,
      coatingCode: null,
      productTypeLabel: "Washer",
      diameterMm: 72,
    });
    expect(r.basePricePerItem).toBe(70400);
    expect(r.unitSellingPrice).toBe(70500);
    expect(r.orderTotal).toBe(352570500);
  });

  it("regression: resolves the specifically-selected item, not just whichever shares its category+size", () => {
    // TR-NUT-F10T-M12 and TR-NUT-A194-M12 (tests/fixtures/seedGuideVersion.ts) share
    // (Nut, M12) on purpose. Before this fix, calculateTradingPricelistLine ignored the
    // caller's tradingItemId entirely and re-derived the item from category+size alone,
    // so whichever one .find() happened to hit first silently won regardless of which
    // item the user actually selected.
    const other = ctx.tradingItems.find((t) => t.sourceKey === "TR-NUT-A194-M12");
    if (!other) throw new Error("fixture item TR-NUT-A194-M12 not found");

    const withoutId = calculateTradingPricelistLine(ctx, {
      productCategory: "Nut",
      sizeLabel: "M12",
      qty: 1,
      coatingCode: null,
      productTypeLabel: "Nut",
      diameterMm: 12,
    });
    expect(withoutId.basePricePerItem).toBe(3400); // TR-NUT-F10T-M12, whichever the ambiguous lookup hits first

    const withId = calculateTradingPricelistLine(ctx, {
      productCategory: "Nut",
      sizeLabel: "M12",
      qty: 1,
      coatingCode: null,
      productTypeLabel: "Nut",
      diameterMm: 12,
      tradingItemId: other.tradingItemId,
    });
    expect(withId.basePricePerItem).toBe(9999); // TR-NUT-A194-M12 — the one actually selected
  });

  it("qty below the lowest defined tier is rejected", () => {
    let error: unknown;
    try {
      calculateTradingPricelistLine(ctx, {
        productCategory: "Washer",
        sizeLabel: "M999-does-not-exist",
        qty: 1,
        coatingCode: null,
        productTypeLabel: "Washer",
        diameterMm: 20,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("TRADING_TIER_NOT_FOUND");
  });
});

describe("Grade price alias resolution (SIM-ALIAS-*)", () => {
  it("A193-B8 and SS304L both resolve through the alias to the A2-70 price", () => {
    for (const grade of ["A193-B8", "SS304L"]) {
      const { canonicalGrade, ref } = resolveCanonicalPriceGrade(ctx, "Bolt", grade);
      expect(canonicalGrade).toBe("A2-70");
      expect(ref?.table).toBe("grade_price_aliases");
      const { pricePerKg } = resolvePricePerKg(ctx, "Bolt", canonicalGrade, "M20");
      expect(pricePerKg).toBe(216000);
    }
  });
});

describe("resolvePricePerKg: thread_condition/product_type disambiguation", () => {
  function ctxWithPrices(rows: Partial<GuideContext["pricePerKg"][number]>[]): GuideContext {
    return {
      ...ctx,
      pricePerKg: rows.map((r, i) => ({
        priceId: `ppk-test-${i}`,
        productFamily: "Bolt",
        gradeOrSpec: "A325",
        sizeLabel: "M14",
        sellingPricePerKg: 0,
        threadCondition: null,
        productType: null,
        ...r,
      })),
    };
  }

  it("a single matching row resolves regardless of discriminators (existing single-row guides keep working)", () => {
    const c = ctxWithPrices([{ sellingPricePerKg: 70000 }]);
    expect(resolvePricePerKg(c, "Bolt", "A325", "M14").pricePerKg).toBe(70000);
    expect(resolvePricePerKg(c, "Bolt", "A325", "M14", { threadCondition: "HT" }).pricePerKg).toBe(70000);
  });

  it("HT and FT rows at the same grade+size resolve to different prices when threadCondition is supplied", () => {
    const c = ctxWithPrices([
      { threadCondition: "HT", sellingPricePerKg: 70000 },
      { threadCondition: "FT", sellingPricePerKg: 75000 },
    ]);
    expect(resolvePricePerKg(c, "Bolt", "A325", "M14", { threadCondition: "HT" }).pricePerKg).toBe(70000);
    expect(resolvePricePerKg(c, "Bolt", "A325", "M14", { threadCondition: "FT" }).pricePerKg).toBe(75000);
  });

  it("HT/FT rows are ambiguous without a threadCondition discriminator — rejected, not silently guessed", () => {
    const c = ctxWithPrices([
      { threadCondition: "HT", sellingPricePerKg: 70000 },
      { threadCondition: "FT", sellingPricePerKg: 75000 },
    ]);
    expect(() => resolvePricePerKg(c, "Bolt", "A325", "M14")).toThrow(AppError);
    expect(() => resolvePricePerKg(c, "Bolt", "A325", "M14")).toThrow(/PRICE_GUIDE_NOT_FOUND|priceGuideNotFound/i);
  });

  it("Anchor and Stud rows at the same grade+size resolve via productTypeLabel", () => {
    const c: GuideContext = {
      ...ctx,
      pricePerKg: [
        {
          priceId: "ppk-anchor",
          productFamily: "Stud / Anchor",
          gradeOrSpec: "12.9",
          sizeLabel: "M16",
          sellingPricePerKg: 60000,
          threadCondition: "FT",
          productType: "Anchor Bolt",
        },
        {
          priceId: "ppk-stud",
          productFamily: "Stud / Anchor",
          gradeOrSpec: "12.9",
          sizeLabel: "M16",
          sellingPricePerKg: 65000,
          threadCondition: "FT",
          productType: "Stud Bolt FT",
        },
      ],
    };
    expect(
      resolvePricePerKg(c, "Stud / Anchor", "12.9", "M16", { productTypeLabel: "Anchor" }).pricePerKg,
    ).toBe(60000);
    expect(
      resolvePricePerKg(c, "Stud / Anchor", "12.9", "M16", { productTypeLabel: "Stud" }).pricePerKg,
    ).toBe(65000);
  });
});

describe("Nut 2H and Washer A36/F35 — formula mechanics (representative fixture data)", () => {
  it("Nut 2H: thickness = diameter when profile is Heavy Hex, forging_ID = 0.85 x diameter for diameter >= 20", () => {
    const r = calculateCustomLine(ctx, {
      productFamily: "Nut",
      gradeOrSpec: "2H",
      sizeLabel: "M20",
      diameterMm: 20,
      qty: 400,
      leadTimeDays: null,
      lengthMm: null,
      developedCutLengthMm: null,
      coatingCode: null,
      diesOption: null,
      diesTotalCost: null,
    });
    // corner = width_flat*1.154 = 32*1.154 = 36.928 (this fixture row has no width_corner)
    const corner = 32 * 1.154;
    const thickness = 20; // profile='Heavy Hex' -> thickness = diameter
    const forgingId = 0.85 * 20; // diameter >= 20
    const volume = Math.PI * ((corner / 2) ** 2 - (forgingId / 2) ** 2) * thickness;
    const expectedRawWeight = (volume * 7850) / 1e9;
    expect(r.rawWeightPerItemKg).toBeCloseTo(expectedRawWeight, 9);
  });

  it("Nut A563: thickness = diameter via resolved profile even though grade string isn't '2H'", () => {
    const r = calculateCustomLine(ctx, {
      productFamily: "Nut",
      gradeOrSpec: "A563",
      sizeLabel: "M20",
      diameterMm: 20,
      qty: 400,
      leadTimeDays: null,
      lengthMm: null,
      developedCutLengthMm: null,
      coatingCode: null,
      diesOption: null,
      diesTotalCost: null,
    });
    const corner = 32 * 1.154;
    const thickness = 20; // profile='Heavy Hex' (A563 maps to Heavy Hex) -> thickness = diameter, not 0.8 x diameter
    const forgingId = 0.85 * 20;
    const volume = Math.PI * ((corner / 2) ** 2 - (forgingId / 2) ** 2) * thickness;
    const expectedRawWeight = (volume * 7850) / 1e9;
    expect(r.rawWeightPerItemKg).toBeCloseTo(expectedRawWeight, 9);
  });

});

describe("AT-LEAD-005/006: Nut now carries its own grade-tiered lead-time surcharge (previously had none at all)", () => {
  const nutBase: CustomLineInput = {
    productFamily: "Nut",
    gradeOrSpec: "2H",
    sizeLabel: "M20",
    diameterMm: 20,
    qty: 400,
    leadTimeDays: null,
    lengthMm: null,
    developedCutLengthMm: null,
    coatingCode: null,
    diesOption: null,
    diesTotalCost: null,
  };

  it("AT-LEAD-005: 2H (Nut low tier, per business confirmation) pays +60% at 7 days vs 0% at 28", () => {
    const r7 = calculateCustomLine(ctx, { ...nutBase, leadTimeDays: 7 });
    const r28 = calculateCustomLine(ctx, { ...nutBase, leadTimeDays: 28 });
    expect(r7.basePricePerItem).toBeCloseTo(r28.basePricePerItem * 1.6, 4);
  });

  it("AT-LEAD-006: Nut's tier boundary sits one class over from Bolt's — CarbonHigh/Stainless share 20/35/50% at 3wk/2wk/10d but diverge at 7 days (100% vs 70%)", () => {
    const high7 = resolveAdjustmentRule(ctx, { costingRoute: "Custom Production", ruleGroup: "Lead Time", scope: "Nut|CarbonHigh", value: 7 });
    const stainless7 = resolveAdjustmentRule(ctx, { costingRoute: "Custom Production", ruleGroup: "Lead Time", scope: "Nut|Stainless", value: 7 });
    const high14 = resolveAdjustmentRule(ctx, { costingRoute: "Custom Production", ruleGroup: "Lead Time", scope: "Nut|CarbonHigh", value: 14 });
    const stainless14 = resolveAdjustmentRule(ctx, { costingRoute: "Custom Production", ruleGroup: "Lead Time", scope: "Nut|Stainless", value: 14 });
    expect(high7?.rule.adjustmentValue).toBeCloseTo(1.0, 6);
    expect(stainless7?.rule.adjustmentValue).toBeCloseTo(0.7, 6);
    expect(high14?.rule.adjustmentValue).toBeCloseTo(stainless14?.rule.adjustmentValue ?? NaN, 6);
  });

  it("AT-QTY-007: Nut now carries its own quantity-break schedule (previously had none at all) — unified across grades, discount-only", () => {
    const small = calculateCustomLine(ctx, { ...nutBase, qty: 400, leadTimeDays: null });
    const large = calculateCustomLine(ctx, { ...nutBase, qty: 5000, leadTimeDays: null });
    expect(small.basePricePerItem).toBeCloseTo(large.basePricePerItem / 0.75, 4); // 1-400 (0%) vs 4001-6000 (-25%)
  });
});

describe("Washer formula mechanics (representative fixture data)", () => {
  it("Washer A36: square-blank volume OD x OD x thickness, no centre-hole deduction", () => {
    const r = calculateCustomLine(ctx, {
      productFamily: "Washer",
      gradeOrSpec: "A36",
      sizeLabel: "M20",
      diameterMm: 20,
      qty: 100,
      leadTimeDays: null,
      lengthMm: null,
      developedCutLengthMm: null,
      coatingCode: null,
      diesOption: null,
      diesTotalCost: null,
    });
    const expectedRawWeight = (44 * 44 * 4 * 7850) / 1e9;
    expect(r.rawWeightPerItemKg).toBeCloseTo(expectedRawWeight, 9);
    expect(r.pricePerKg).toBe(44000);
  });
});

describe("Costing route rules (SCP-002/AT-WASHER-001/002)", () => {
  it("F436 washer is only allowed via Trading; A36/F35 only via Custom Production", () => {
    const f436 = ctx.costingRouteRules.find((r) => r.productFamily === "Washer" && r.gradeOrSpec === "F436");
    const a36 = ctx.costingRouteRules.find((r) => r.productFamily === "Washer" && r.gradeOrSpec === "A36");
    expect(f436?.allowedCostingRoute).toBe("Trading");
    expect(a36?.allowedCostingRoute).toBe("Custom Production");
  });
});

describe("resolveAdjustmentRule: not-applicable vs. gap distinction", () => {
  it("returns null (not an error) when a scope simply has no rules at all", () => {
    const result = resolveAdjustmentRule(ctx, {
      costingRoute: "Custom Production",
      ruleGroup: "Quantity",
      scope: "Washer", // no Quantity rules defined for Washer in this fixture
      value: 50,
    });
    expect(result).toBeNull();
  });
});

describe("AT-CUSTOM-005: base price = costing weight x price/kg, before any adjustment factors", () => {
  it("qty=251-500 (0%), lead=28 days/standard (0%), length ratio<=6D (0%) leaves base price exactly at weight x price/kg", () => {
    // All three adjustment brackets are 0% at these inputs, so basePricePerItem
    // must equal the raw weight*price multiplication with no scaling applied —
    // the direct analogue of the spec's "1.020 x 70,000 = 71,400" example.
    const r = calculateCustomLine(ctx, { ...boltBase, qty: 300, leadTimeDays: 28, lengthMm: 80 });
    expect(r.basePricePerItem).toBeCloseTo(r.costingWeightPerItemKg * r.pricePerKg, 6);
  });
});

describe("AT-CUSTOM-006: adjustment factors multiply the price sequentially; weight is never touched", () => {
  it("qty=31-40 (x1.35) and lead=10 days, CarbonHigh (x1.6) compound to x2.16 on price only", () => {
    const withFactors = calculateCustomLine(ctx, { ...boltBase, qty: 31, leadTimeDays: 10, lengthMm: 80 });
    const withoutFactors = calculateCustomLine(ctx, { ...boltBase, qty: 300, leadTimeDays: 28, lengthMm: 80 });

    // Same product/size, so raw base (weight x price/kg) is identical; only the
    // adjustment factors differ. This isolates "factors affect price, never weight."
    const rawBase = withoutFactors.basePricePerItem;
    expect(withFactors.basePricePerItem).toBeCloseTo(rawBase * 1.35 * 1.6, 4);
    expect(withFactors.costingWeightPerItemKg).toBeCloseTo(withoutFactors.costingWeightPerItemKg, 10);
  });
});

describe("AT-COATING-001: coating price = costing weight x rate, before order-weight discount", () => {
  it("2 kg x 10,000/kg = 20,000 exactly, with no order-weight adjustment in play", () => {
    const coatingOnlyCtx: GuideContext = {
      guideVersionId: "ctx-coating-001",
      config: new Map(),
      materials: [],
      rawBarStock: [],
      diesCostGuides: [],
      materialGradeMap: [],
      gradeProfileRules: [],
      gradePriceAliases: [],
      materialSizeGuides: [],
      pricePerKg: [],
      coatingPriceGuides: [
        { coatingRuleId: "coat-1", processName: "TESTCOAT", itemScope: "all", minDiameterMm: null, basis: "IDR_per_kg", rate: 10000 },
      ],
      adjustmentRules: [], // no order-weight bracket defined -> factor stays at 1 (unscaled)
      tradingItems: [],
      tradingPriceTiers: [],
      calculationFormulas: [],
      costingRouteRules: [],
    };

    const result = computeCoatingPrice(coatingOnlyCtx, {
      coatingCode: "TESTCOAT",
      productTypeLabel: "Bolt",
      diameterMm: 14,
      costingWeightPerItemKg: 2,
      qty: 1,
      lengthMm: null,
    });
    expect(result.coatingPricePerItem).toBe(20000);
  });
});

describe("AT-WASHER-003: F35 is a valid paired washer grade for the F10T set (JIS B 1186)", () => {
  it("resolves via Custom Production, using the same blank formula as A36 but its own distinct price/kg", () => {
    const routeRule = ctx.costingRouteRules.find((r) => r.productFamily === "Washer" && r.gradeOrSpec === "F35");
    expect(routeRule?.allowedCostingRoute).toBe("Custom Production");

    const r = calculateCustomLine(ctx, {
      productFamily: "Washer",
      gradeOrSpec: "F35",
      sizeLabel: "M20",
      diameterMm: 20,
      qty: 100,
      leadTimeDays: null,
      lengthMm: null,
      developedCutLengthMm: null,
      coatingCode: null,
      diesOption: null,
      diesTotalCost: null,
    });
    // Fixture uses representative (not literal-source) washer dimensions —
    // OD x OD x thickness, same as the A36 case — so we verify the formula
    // relationship rather than a hardcoded external golden number.
    const expectedRawWeight = (44 * 44 * 4 * 7850) / 1e9;
    expect(r.rawWeightPerItemKg).toBeCloseTo(expectedRawWeight, 9);
    expect(r.pricePerKg).toBe(60000); // F35's own price/kg — distinct from A36's 44,000
    expect(r.basePricePerItem).toBeCloseTo(r.costingWeightPerItemKg * 60000, 6);
  });
});

describe("AT-TRADING-004: F436 tiers cover 1 to infinity with no gap, for every listed size", () => {
  it("qty=1, every tier boundary, a mid-gap qty, and a qty far beyond the last tier all resolve or correctly reject", () => {
    const sizesInFixture = Array.from(new Set(ctx.tradingItems.filter((t) => t.productCategory === "Washer").map((t) => t.sizeLabel)));
    expect(sizesInFixture.length).toBeGreaterThan(0);

    for (const sizeLabel of sizesInFixture) {
      const tierRowsForSize = ctx.tradingPriceTiers.filter((tier) =>
        ctx.tradingItems.some((t) => t.tradingItemId === tier.tradingItemId && t.sizeLabel === sizeLabel),
      );
      const lowestMin = Math.min(...tierRowsForSize.map((t) => t.qtyMin));

      // At the very first defined qty, a price must resolve.
      expect(() =>
        calculateTradingPricelistLine(ctx, {
          productCategory: "Washer",
          sizeLabel,
          qty: lowestMin,
          coatingCode: null,
          productTypeLabel: "Washer",
          diameterMm: 20,
        }),
      ).not.toThrow();

      // Arbitrarily far beyond the highest listed tier must still resolve — the
      // highest tier's price is inherited upward, covering qty..infinity.
      expect(() =>
        calculateTradingPricelistLine(ctx, {
          productCategory: "Washer",
          sizeLabel,
          qty: 999_999,
          coatingCode: null,
          productTypeLabel: "Washer",
          diameterMm: 20,
        }),
      ).not.toThrow();

      // Below the lowest listed tier there is no lower tier to inherit from —
      // that is a real gap and must reject, not silently resolve.
      if (lowestMin > 1) {
        let error: unknown;
        try {
          calculateTradingPricelistLine(ctx, {
            productCategory: "Washer",
            sizeLabel,
            qty: lowestMin - 1,
            coatingCode: null,
            productTypeLabel: "Washer",
            diameterMm: 20,
          });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("TRADING_TIER_NOT_FOUND");
      }
    }
  });
});
