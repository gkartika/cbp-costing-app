import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { getActivePublishedGuideVersionId } from "@/lib/guide/activeGuideVersion";
import { loadGuideContext } from "@/lib/calc/loadGuideContext";
import { getConfigNumber } from "@/lib/calc/appConfig";

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
      leadTimeBucketsByScope: {},
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

  const leadTimeBucketsByScope: Record<string, { label: string; value: number; ruleId: string }[]> = {};
  for (const rule of ctx.adjustmentRules) {
    if (rule.ruleGroup !== "Lead Time") continue;
    const min = rule.thresholdMin;
    if (min === null) continue;
    // A representative value guaranteed to fall inside this rule's own range,
    // regardless of whether the minimum boundary itself is inclusive.
    const value = rule.minInclusive ? min : min + 1;
    const label =
      rule.thresholdMax === null
        ? `${value}+ days`
        : `${rule.thresholdMin}–${rule.thresholdMax} days`;
    const list = leadTimeBucketsByScope[rule.scope] ?? (leadTimeBucketsByScope[rule.scope] = []);
    list.push({ label, value, ruleId: rule.adjustmentRuleId });
  }
  Object.values(leadTimeBucketsByScope).forEach((list) => list.sort((a, b) => a.value - b.value));

  const tradingItemsByCategory: Record<string, { tradingItemId: string; sizeLabel: string }[]> = {};
  for (const item of ctx.tradingItems) {
    const list = tradingItemsByCategory[item.productCategory] ?? (tradingItemsByCategory[item.productCategory] = []);
    list.push({ tradingItemId: item.tradingItemId, sizeLabel: item.sizeLabel });
  }

  // Only Bolt currently prices HT/FT separately; other families' price rows
  // carry no thread_condition, so this list stays empty for them and the
  // Workspace hides the dropdown rather than offering a no-op choice.
  const threadConditionsByFamily: Record<string, string[]> = {};
  for (const price of ctx.pricePerKg) {
    if (!price.threadCondition) continue;
    const list = threadConditionsByFamily[price.productFamily] ?? (threadConditionsByFamily[price.productFamily] = []);
    if (!list.includes(price.threadCondition)) list.push(price.threadCondition);
  }
  Object.values(threadConditionsByFamily).forEach((list) => list.sort());

  return NextResponse.json({
    guideVersionId,
    productFamilies,
    gradesByFamily,
    gradeLabelsByFamily,
    gradeToProfile,
    sizesByProfile,
    coatingCodes,
    leadTimeBucketsByScope,
    tradingItemsByCategory,
    threadConditionsByFamily,
    defaultWeightTolerancePercent: getConfigNumber(ctx, "CUSTOM_WEIGHT_TOLERANCE"),
  });
});
