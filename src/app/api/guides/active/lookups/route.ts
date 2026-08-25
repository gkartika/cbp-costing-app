import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { getActivePublishedGuideVersionId } from "@/lib/guide/activeGuideVersion";
import { loadGuideContext } from "@/lib/calc/loadGuideContext";
import { getConfigNumber } from "@/lib/calc/appConfig";

/**
 * Lead time shown the way CBP quotes it: whole weeks as "N minggu", anything
 * else as "N hari". Pure formatting of the day count that already lives in the
 * rate card — the surcharge itself stays versioned master data.
 */
function formatLeadTime(days: number): string {
  return days >= 14 && days % 7 === 0 ? `${days / 7} minggu` : `${days} hari`;
}

/**
 * Read-only, guide-version-scoped option lists for the Workspace's dropdown
 * fields (grade, size, coating code, lead time, trading item). Every value
 * returned here is projected from the active Published guide's own master
 * tables — nothing is hardcoded, so the dropdowns can never offer a choice
 * the calculation engine wouldn't also accept.
 */
export const GET = apiHandler(async () => {
  await requireUser();

  const guideVersionId = await getActivePublishedGuideVersionId();
  if (!guideVersionId) {
    return NextResponse.json({
      guideVersionId: null,
      productFamilies: [],
      gradesByFamily: {},
      gradeLabelsByFamily: {},
      gradeToProfile: {},
      sizesByProfile: {},
      coatingCodes: [],
      coatingLabels: {},
      leadTimeBucketsByFamily: {},
      tradingItemsByCategory: {},
      threadConditionsByFamily: {},
      defaultWeightTolerancePercent: 0,
    });
  }

  const ctx = await loadGuideContext(guideVersionId);

  // Structural type discriminator the engine itself switches on (customPipeline
  // splits "Stud / Anchor" further by which length field is filled in) —
  // fixed, not a versioned business value, so it's safe to enumerate here.
  const productFamilies = ["Bolt", "Nut", "Washer", "Stud / Anchor"];

  const gradesByFamily: Record<string, string[]> = {};
  // grade -> resolved profile, so the client can filter the Size dropdown to
  // sizes that actually exist for the grade the user just picked, without
  // duplicating the resolution rule client-side.
  const gradeToProfile: Record<string, Record<string, string>> = {};
  // grade -> fuller standard designation for display (e.g. "2H" -> "A194-2H").
  // Falls back to the short code itself when no display_label is set, so the
  // client never needs its own fallback logic.
  const gradeLabelsByFamily: Record<string, Record<string, string>> = {};
  for (const rule of ctx.gradeProfileRules) {
    const list = gradesByFamily[rule.productFamily] ?? (gradesByFamily[rule.productFamily] = []);
    if (!list.includes(rule.gradeOrSpec)) list.push(rule.gradeOrSpec);
    const familyMap = gradeToProfile[rule.productFamily] ?? (gradeToProfile[rule.productFamily] = {});
    familyMap[rule.gradeOrSpec] = rule.defaultProductProfile;
    const labelMap = gradeLabelsByFamily[rule.productFamily] ?? (gradeLabelsByFamily[rule.productFamily] = {});
    labelMap[rule.gradeOrSpec] = rule.displayLabel ?? rule.gradeOrSpec;
  }
  Object.values(gradesByFamily).forEach((list) => list.sort());

  // Size label paired with its diameter_mm, since costing_lines stores only
  // the numeric diameter — the label is a display convenience, the value
  // submitted to the API is always the diameter.
  const sizesByProfile: Record<string, { sizeLabel: string; diameterMm: number | null }[]> = {};
  for (const size of ctx.materialSizeGuides) {
    const list = sizesByProfile[size.productProfile] ?? (sizesByProfile[size.productProfile] = []);
    if (!list.some((s) => s.sizeLabel === size.sizeLabel)) {
      list.push({ sizeLabel: size.sizeLabel, diameterMm: size.diameterMm });
    }
  }

  const coatingCodes = Array.from(new Set(ctx.coatingPriceGuides.map((c) => c.processName))).sort();
  // process_name -> human-facing name (e.g. "Dies" -> "Zinc"). The code stays
  // the matching key; only the label changes, same split as grade labels.
  const coatingLabels: Record<string, string> = {};
  for (const c of ctx.coatingPriceGuides) {
    coatingLabels[c.processName] = c.displayLabel ?? c.processName;
  }

  // Keyed by product family, NOT by the engine's tiered scope. Lead Time rules
  // are scoped "Bolt|CarbonHigh", "Nut|Stainless" and so on, but the day menu
  // is identical across a family's tiers — only the surcharge differs, and the
  // engine picks the tier itself from the grade at calculation time. Keying by
  // scope meant the client (which only knows the family) never matched a key,
  // so the dropdown silently fell back to a free-text day box.
  const leadTimeBucketsByFamily: Record<string, { label: string; value: number; ruleId: string }[]> = {};
  for (const rule of ctx.adjustmentRules) {
    if (rule.ruleGroup !== "Lead Time") continue;
    const min = rule.thresholdMin;
    if (min === null) continue;
    // A representative value guaranteed to fall inside this rule's own range,
    // regardless of whether the minimum boundary itself is inclusive.
    const value = rule.minInclusive ? min : min + 1;
    const family = rule.scope.split("|")[0];
    const list = leadTimeBucketsByFamily[family] ?? (leadTimeBucketsByFamily[family] = []);
    if (list.some((b) => b.value === value)) continue;
    list.push({ label: formatLeadTime(value), value, ruleId: rule.adjustmentRuleId });
  }
  Object.values(leadTimeBucketsByFamily).forEach((list) => list.sort((a, b) => a.value - b.value));

  const tradingItemsByCategory: Record<string, { tradingItemId: string; sizeLabel: string }[]> = {};
  for (const item of ctx.tradingItems) {
    const list = tradingItemsByCategory[item.productCategory] ?? (tradingItemsByCategory[item.productCategory] = []);
    list.push({ tradingItemId: item.tradingItemId, sizeLabel: item.sizeLabel });
  }

  // Thread condition is only a real choice where the guide actually prices two
  // or more of them at the same grade+size — today that is Bolt (HT vs FT).
  // Nut carries a single placeholder "NA" and Stud/Anchor a single "FT", which
  // the engine never discriminates on, so offering those as a one-item dropdown
  // just invited the user to set a field that changes nothing. Derived from the
  // data rather than hardcoding "Bolt", so a future family that genuinely
  // prices two conditions starts offering the choice on its own.
  const threadConditionsByFamily: Record<string, string[]> = {};
  for (const price of ctx.pricePerKg) {
    if (!price.threadCondition) continue;
    const list = threadConditionsByFamily[price.productFamily] ?? (threadConditionsByFamily[price.productFamily] = []);
    if (!list.includes(price.threadCondition)) list.push(price.threadCondition);
  }
  for (const [family, list] of Object.entries(threadConditionsByFamily)) {
    if (list.length < 2) delete threadConditionsByFamily[family];
    else list.sort();
  }

  return NextResponse.json({
    guideVersionId,
    productFamilies,
    gradesByFamily,
    gradeLabelsByFamily,
    gradeToProfile,
    sizesByProfile,
    coatingCodes,
    coatingLabels,
    leadTimeBucketsByFamily,
    tradingItemsByCategory,
    threadConditionsByFamily,
    defaultWeightTolerancePercent: getConfigNumber(ctx, "CUSTOM_WEIGHT_TOLERANCE"),
  });
});
