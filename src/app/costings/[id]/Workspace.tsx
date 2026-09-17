"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, apiPatch, apiDelete, type ApiError } from "./clientApi";
import { buildLineTree, defaultSetDescription } from "@/lib/costings/sets";
import { DEFAULT_PAYMENT_TERMS, PAYMENT_TERMS_OPTIONS } from "@/lib/costings/paymentTerms";
import { StatusPill } from "@/components/Pills";
import { Modal } from "@/components/Modal";
import { Ticket, TicketLine, TicketDivider, TicketTotal } from "@/components/Ticket";

type Costing = {
  costingId: string;
  quotationNo: string | null;
  customerId: string | null;
  customerName: string;
  ownerUserId: string;
  status: string;
  revisionNo: number;
  parentCostingId: string | null;
  validityDays: number;
  paymentTermsOverride: string | null;
  accountPaymentTerms: string | null;
  accountMarkupPercent: number | null;
  signedByName: string | null;
  signedByTitle: string | null;
  totalDiscountType: "PERCENT" | "AMOUNT" | null;
  totalDiscountValue: number | null;
  updatedAt: string;
  canEdit: boolean;
};

type Explanation = {
  snapshotId: string;
  guideVersionId: string;
  rawWeightPerItemKg: number | null;
  costingWeightPerItemKg: number | null;
  basePricePerItem: number;
  coatingPricePerItem: number;
  diesPricePerItem: number;
  unitPriceBeforeRounding: number;
  unitSellingPrice: number;
  orderTotal: number;
  resultHash: string;
  calculatedAt: string;
  explainedRules: { table: string; id: string; note?: string; row: Record<string, unknown> | null }[];
};

type Line = {
  costingLineId: string;
  lineNo: number;
  lineKind: "item" | "set" | "component";
  parentLineId: string | null;
  qtyPerSet: number | null;
  route: string | null;
  productFamily: string | null;
  description: string | null;
  gradeInput: string | null;
  threadCondition: string | null;
  sizeLabel: string | null;
  diameterMm: number | null;
  lengthMm: number | null;
  developedCutLengthMm: number | null;
  qty: number | null;
  leadTimeDays: number | null;
  coatingCode: string | null;
  diesOption: "yes" | "no_lookup" | "manual" | null;
  diesTotalCost: number | null;
  weightTolerancePercent: number | null;
  marginPercent: number | null;
  tradingItemId: string | null;
  tradingQuoteId: string | null;
  discountType: "PERCENT" | "AMOUNT" | null;
  discountValue: number | null;
  pitchType: "STANDARD" | "CUSTOM" | null;
  pitchValue: string | null;
  chosenPriceKind: "PRODUCTION" | "TRADING" | null;
  unitPriceOverride: number | null;
  updatedAt: string;
  needsRecalculation: boolean;
  latestUnitSellingPrice: number | null;
  latestOrderTotal: number | null;
  productionUnitSellingPrice: number | null;
  productionOrderTotal: number | null;
  tradingUnitSellingPrice: number | null;
  tradingOrderTotal: number | null;
};

type LineForm = {
  productFamily: string;
  description: string;
  gradeInput: string;
  threadCondition: string;
  sizeLabel: string;
  diameterMm: string;
  /** Raw value as the user typed it, in whichever unit lengthUnit says — not necessarily mm despite the field's name (see formToBody's conversion). */
  lengthMm: string;
  /** Bolt/Stud finished length is commonly quoted in inches too — converted to mm only when submitting (formToBody). */
  lengthUnit: "mm" | "in";
  developedCutLengthMm: string;
  qty: string;
  leadTimeDays: string;
  coatingCode: string;
  diesOption: "" | "yes" | "no_lookup" | "manual";
  diesTotalCost: string;
  weightTolerancePercent: string;
  marginPercent: string;
  /** Standard has no price effect; Custom types a value and adds +10%. */
  pitchType: "STANDARD" | "CUSTOM";
  pitchValue: string;
  /** Components only: how many of this part go into one set. */
  qtyPerSet: string;
  /** Custom Part only — no calculation, this is the whole price (stored as unitPriceOverride). */
  customUnitPrice: string;
};

/**
 * Display-only relabeling of a product family value — the stored value
 * (`product_family` on the line, used throughout calc code and route rules)
 * never changes, only what the dropdown shows for it.
 */
const PRODUCT_FAMILY_LABELS: Record<string, string> = {
  Bolt: "Hex Bolt",
};

type Lookups = {
  guideVersionId: string | null;
  productFamilies: string[];
  gradesByFamily: Record<string, string[]>;
  gradeLabelsByFamily: Record<string, Record<string, string>>;
  gradeToProfile: Record<string, Record<string, string>>;
  sizesByProfile: Record<string, { sizeLabel: string; diameterMm: number | null }[]>;
  coatingCodes: string[];
  coatingLabels: Record<string, string>;
  leadTimeBucketsByFamily: Record<string, { label: string; value: number; ruleId: string }[]>;
  threadConditionsByFamily: Record<string, string[]>;
  /** Bolt/Nut standard (non-custom) thread pitch by family + size — a physical constant, not guide data. */
  standardPitchByFamilySize: Record<string, Record<string, string>>;
  defaultWeightTolerancePercent: number;
};

const EMPTY_LOOKUPS: Lookups = {
  guideVersionId: null,
  productFamilies: [],
  gradesByFamily: {},
  gradeLabelsByFamily: {},
  gradeToProfile: {},
  sizesByProfile: {},
  coatingCodes: [],
  coatingLabels: {},
  leadTimeBucketsByFamily: {},
  threadConditionsByFamily: {},
  standardPitchByFamilySize: {},
  defaultWeightTolerancePercent: 0,
};

/**
 * Fallback lead-time options for a family with no guide-defined buckets of
 * its own (e.g. Washer has none — adjustment_rules simply has no Lead Time
 * rows scoped to it). Same day values and labels every other family uses, so
 * the field looks and behaves identically regardless of family; the value
 * submitted is a plain day count either way, guide-backed or not.
 */
const GENERIC_LEAD_TIME_OPTIONS = [
  { value: 7, label: "7 hari" },
  { value: 10, label: "10 hari" },
  { value: 14, label: "2 minggu" },
  { value: 21, label: "3 minggu" },
  { value: 28, label: "4 minggu" },
  { value: 35, label: "5 minggu" },
  { value: 42, label: "6 minggu" },
];

const EMPTY_FORM: LineForm = {
  productFamily: "",
  description: "",
  gradeInput: "",
  threadCondition: "",
  sizeLabel: "",
  diameterMm: "",
  lengthMm: "",
  lengthUnit: "mm",
  developedCutLengthMm: "",
  qty: "1",
  // CBP's default lead time is 4 minggu (business-confirmed 2026-09-12) — the
  // day menu (7/10/14/21/28/35/42) is identical across every family's tiers,
  // only the surcharge differs, so 28 is always a valid option once one loads.
  leadTimeDays: "28",
  coatingCode: "",
  diesOption: "yes",
  diesTotalCost: "",
  weightTolerancePercent: "",
  marginPercent: "",
  pitchType: "STANDARD",
  pitchValue: "",
  qtyPerSet: "1",
  customUnitPrice: "",
};

function lineToForm(l: Line): LineForm {
  return {
    productFamily: l.productFamily ?? "",
    description: l.description ?? "",
    gradeInput: l.gradeInput ?? "",
    threadCondition: l.threadCondition ?? "",
    sizeLabel: l.sizeLabel ?? "",
    diameterMm: l.diameterMm?.toString() ?? "",
    // Only mm is ever stored — an inch entry is converted at save time
    // (formToBody) — so re-opening a line for edit always shows mm, even if
    // it was originally typed in inches.
    lengthMm: l.lengthMm?.toString() ?? "",
    lengthUnit: "mm",
    developedCutLengthMm: l.developedCutLengthMm?.toString() ?? "",
    qty: l.qty?.toString() ?? "1",
    leadTimeDays: l.leadTimeDays?.toString() ?? "",
    coatingCode: l.coatingCode ?? "",
    // A stored null means "not decided" from before this field defaulted to
    // "Ya" — pricing-identical to "yes" (both add zero dies cost), so editing
    // an old line just shows the equivalent, meaningful option instead of a
    // blank "n/a" that no longer exists in the dropdown.
    diesOption: l.diesOption ?? "yes",
    diesTotalCost: l.diesTotalCost?.toString() ?? "",
    weightTolerancePercent: l.weightTolerancePercent?.toString() ?? "",
    marginPercent: l.marginPercent?.toString() ?? "",
    pitchType: l.pitchType ?? "STANDARD",
    pitchValue: l.pitchValue ?? "",
    qtyPerSet: l.qtyPerSet?.toString() ?? "1",
    customUnitPrice: l.unitPriceOverride?.toString() ?? "",
  };
}

/**
 * Inch sizes are stored as bare fractions/whole numbers ("3/4", "1"); metric
 * sizes are already prefixed ("M20"). The quotation needs the inch mark
 * spelled out only for the former (3/4 -> 3/4", 1 -> 1").
 */
function formatSizeForDescription(sizeLabel: string): string {
  return /^M\d/i.test(sizeLabel) ? sizeLabel : `${sizeLabel}"`;
}

/**
 * Metric pitch is stored bare ("2.5") and gets a "P" prefix here so it reads
 * as a pitch, not a size — "P2.5". Imperial pitch is already T-prefixed by
 * convention (standard_pitches: "T13", "T4.5", ...) and is shown as-is.
 */
function formatPitchForDescription(rawSize: string, pitch: string): string {
  return /^M\d/i.test(rawSize) ? `P${pitch}` : pitch;
}

/**
 * CBP's standard item description, used when the user leaves Description
 * blank so every quotation line reads consistently:
 *   Bolt   — "Bolt, A193-B7, HT, M20x80, P2.5, HDG"
 *   Nut    — "Nut, A194-2H, M20, P2.5, Zinc"
 *   Washer — "Washer, A36, 3/4", Plain"
 * Uses the grade's display label (A193-B7, not B7) so the quotation shows the
 * full standard designation, and always names the size and coating so no line
 * ships ambiguous about either. Each part is its own comma segment — a blank
 * one (no thread condition, no length, no pitch) is simply dropped rather
 * than leaving a stray comma. Returns "" for families with no agreed format,
 * leaving the existing "family + grade" fallback in the summary untouched.
 */
function defaultDescription(f: LineForm, gradeLabel: string, coatingLabel: string, pitch?: string | null): string {
  const grade = gradeLabel || f.gradeInput;
  const rawSize = f.sizeLabel || (f.diameterMm ? `M${f.diameterMm}` : "");
  if (!f.productFamily || !grade || !rawSize) return "";
  const size = formatSizeForDescription(rawSize);
  const coating = coatingLabel || "Plain";
  const pitchDisplay = pitch ? formatPitchForDescription(rawSize, pitch) : null;

  if (f.productFamily === "Bolt") {
    const lengthSuffix = f.lengthMm ? `x${f.lengthMm}${f.lengthUnit === "in" ? '"' : "mm"}` : "";
    const sizeAndLength = `${size}${lengthSuffix}`;
    return [f.productFamily, grade, f.threadCondition || null, sizeAndLength, pitchDisplay, coating]
      .filter(Boolean)
      .join(", ");
  }
  if (f.productFamily === "Nut" || f.productFamily === "Washer") {
    return [f.productFamily, grade, size, pitchDisplay, coating].filter(Boolean).join(", ");
  }
  return "";
}

/**
 * On create, an empty field simply means "not set yet" — omit it. On edit,
 * an empty field means the user actively cleared it, so it must be sent as
 * `null` or the stale value survives server-side (e.g. a leftover
 * developedCutLengthMm silently rerouting a Stud line to the Anchor formula).
 */
function formToBody(
  f: LineForm,
  mode: "add" | "edit",
  gradeLabel = "",
  kind: "item" | "set" | "component" = "item",
  coatingLabel = "",
  pitch: string | null = null,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const set = (key: string, raw: string, parse: (s: string) => unknown = (s) => s) => {
    if (raw) {
      body[key] = parse(raw);
    } else if (mode === "edit") {
      body[key] = null;
    }
  };

  // A set has no product of its own — only a name, how many are ordered, and
  // the components underneath it. Sending the item fields would attach a
  // family and grade the calculator would then try to price directly.
  if (kind === "set") {
    if (mode === "add") body.lineKind = "set";
    set("description", f.description);
    set("qty", f.qty, Number);
    return body;
  }

  if (mode === "add" && kind === "component") body.lineKind = "component";

  set("productFamily", f.productFamily);
  // A blank Description falls back to CBP's standard format rather than
  // staying empty, so the quotation never ships an unlabelled line.
  set("description", f.description || defaultDescription(f, gradeLabel, coatingLabel, pitch));
  set("gradeInput", f.gradeInput);
  set("threadCondition", f.threadCondition);
  set("sizeLabel", f.sizeLabel);
  set("diameterMm", f.diameterMm, Number);
  // The engine only ever works in mm — an inch entry is converted here, once,
  // right at submission. The description above already used the raw typed
  // value + its own unit, so this doesn't affect what's printed.
  set("lengthMm", f.lengthMm, (raw) => (f.lengthUnit === "in" ? Number(raw) * 25.4 : Number(raw)));
  set("developedCutLengthMm", f.developedCutLengthMm, Number);
  // A component's produced quantity is qtyPerSet x the set's qty, worked out
  // server-side at calculation; its own qty column stays unused.
  if (kind === "component") body.qtyPerSet = Number(f.qtyPerSet || 1);
  else set("qty", f.qty, Number);
  set("leadTimeDays", f.leadTimeDays, Number);
  set("coatingCode", f.coatingCode);
  set("diesOption", f.diesOption);
  if (f.diesTotalCost) body.diesTotalCost = Number(f.diesTotalCost);
  else if (mode === "edit") body.diesTotalCost = null;
  set("weightTolerancePercent", f.weightTolerancePercent, Number);
  set("marginPercent", f.marginPercent, Number);
  set("pitchType", f.pitchType);
  // `pitch` is already the resolved value for whichever type is selected —
  // the user's own typed value for Custom, or the looked-up standard value
  // for Standard (see saveLine) — so it doubles as both the description
  // fragment and what gets stored. Switching to a size/type with no known
  // pitch on edit must still clear any leftover value rather than leave it
  // stranded.
  if (pitch) body.pitchValue = pitch;
  else if (mode === "edit") body.pitchValue = null;
  return body;
}

/** Mirrors the server's productTypeLabel() split of "Stud / Anchor" by which length field is filled in — used only to pick the right Lead Time option list, never to change what gets submitted. */
function resolveTypeLabelForLeadTime(form: LineForm): string | null {
  if (form.productFamily !== "Stud / Anchor") return form.productFamily || null;
  if (form.developedCutLengthMm) return "Anchor";
  if (form.lengthMm) return "Stud";
  return null;
}

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-US");
}

/** Same display rule as the server's lookups (7-day multiples >=14 read as weeks) — pure formatting, not a business value. */
function formatLeadTimeDays(days: number | null): string {
  if (days === null) return "—";
  return days >= 14 && days % 7 === 0 ? `${days / 7} minggu` : `${days} hari`;
}

/**
 * Shows which price kind a standalone item is priced at (route merge,
 * DEC-2026-09-14): a line with only a Production price shows an
 * informational pill, a line with both lets the owner switch between them
 * before Finalize — Finalize itself refuses to run while any such line is
 * still unresolved (Errors.priceKindRequired).
 */
function PriceKindControl({
  line,
  costingId,
  canEdit,
  onSaved,
}: {
  line: Line;
  costingId: string;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);

  if (line.productionUnitSellingPrice === null && line.tradingUnitSellingPrice === null) {
    return <span style={{ color: "var(--ink-soft)" }}>—</span>;
  }
  if (line.tradingUnitSellingPrice === null) {
    return <span className="pill neutral">Production</span>;
  }

  async function choose(kind: "PRODUCTION" | "TRADING") {
    if (busy || line.chosenPriceKind === kind) return;
    setBusy(true);
    try {
      await apiPatch(`/api/costings/${costingId}/lines/${line.costingLineId}`, {
        expectedUpdatedAt: line.updatedAt,
        chosenPriceKind: kind,
      });
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  const options: { kind: "PRODUCTION" | "TRADING"; label: string; price: number | null }[] = [
    { kind: "PRODUCTION", label: "Production", price: line.productionUnitSellingPrice },
    { kind: "TRADING", label: "Trading", price: line.tradingUnitSellingPrice },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {options.map((o) => (
        <button
          key={o.kind}
          type="button"
          disabled={!canEdit || busy}
          onClick={() => choose(o.kind)}
          className={`pill ${line.chosenPriceKind === o.kind ? "success" : "neutral"}`}
          style={{ cursor: canEdit ? "pointer" : "default", border: 0, textAlign: "left" }}
          title={canEdit ? `Gunakan harga ${o.label}` : o.label}
        >
          {o.label}: {fmt(o.price)}
        </button>
      ))}
    </div>
  );
}

/**
 * Manual override of a line's quoted unit price, layered on top of whatever
 * Calculate All (and the Production/Trading pick) produced — for the cases
 * the guide simply can't price, or a one-off negotiated number. Purely a
 * quoting decision: saving it never touches the line's updated_at or forces
 * a recalculation (src/app/api/costings/[id]/lines/[lineId]/route.ts).
 */
function UnitPriceOverrideControl({
  line,
  costingId,
  onSaved,
}: {
  line: Line;
  costingId: string;
  onSaved: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(line.unitPriceOverride?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const parsed = value.trim() === "" ? null : Number(value);
      await apiPatch(`/api/costings/${costingId}/lines/${line.costingLineId}`, {
        expectedUpdatedAt: line.updatedAt,
        unitPriceOverride: parsed,
      });
      setEditing(false);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <input
          type="number"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={line.latestUnitSellingPrice?.toString() ?? "0"}
          style={{ width: 90 }}
          autoFocus
        />
        <button onClick={save} disabled={busy} className="btn small">
          OK
        </button>
        <button onClick={() => setEditing(false)} disabled={busy} className="btn secondary small">
          ✕
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => {
        setValue(line.unitPriceOverride?.toString() ?? "");
        setEditing(true);
      }}
      className="link-btn"
      style={{ fontFamily: "inherit", color: line.unitPriceOverride !== null ? "var(--amber)" : "inherit" }}
      title={line.unitPriceOverride !== null ? "Harga di-override manual — klik untuk ubah" : "Klik untuk override harga"}
    >
      {fmt(line.latestUnitSellingPrice)}
      {line.unitPriceOverride !== null && <span className="pill amber" style={{ marginLeft: 4, fontSize: 9 }}>manual</span>}
    </button>
  );
}

/**
 * Manual trading quote — the fallback price source when auto-matching this
 * item against the Trading pricelist finds nothing (src/lib/calc/resolvers.ts
 * resolveTradingItemByAttributes), for a one-off supplier quote instead. The
 * quoted price is normalized ex-tax and marked up by Margin, entered here
 * (calculateTradingQuoteLine) rather than as its own top-level field, since
 * it means nothing without a quote to mark up. Every submission creates a
 * new trading_quotes row and points the line at it (AUD-010), so this always
 * reads as "add a quote," never "edit the last one" — Margin, by contrast,
 * is saved with the rest of the line by the panel's own Save button.
 */
function TradingQuoteManualPanel({
  line,
  costingId,
  marginPercent,
  onMarginPercentChange,
  onSaved,
}: {
  line: Line;
  costingId: string;
  marginPercent: string;
  onMarginPercentChange: (value: string) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [quotedPrice, setQuotedPrice] = useState("");
  const [taxBasis, setTaxBasis] = useState<"EXCLUDE_PPN" | "INCLUDE_PPN">("EXCLUDE_PPN");
  const [ppnRate, setPpnRate] = useState("0.11");
  const [landedCostConfirmed, setLandedCostConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      if (!quotedPrice || Number(quotedPrice) <= 0) throw new Error("Masukkan harga quote.");
      if (!landedCostConfirmed) throw new Error("Konfirmasi bahwa harga sudah termasuk ongkir dan biaya impor.");
      await apiPost(`/api/costings/${costingId}/lines/${line.costingLineId}/trading-quote`, {
        quotedPrice: Number(quotedPrice),
        taxBasis,
        ...(taxBasis === "INCLUDE_PPN" ? { ppnRate: Number(ppnRate) } : {}),
        landedCostConfirmed,
      });
      setDone(true);
      setQuotedPrice("");
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan trading quote.");
    } finally {
      setBusy(false);
    }
  }

  // Mirrors calculateTradingQuoteLine (src/lib/calc/tradingPipeline.ts) purely
  // for display, so the user sees the resulting sell price before saving —
  // not used for the actual submission, the server computes that itself.
  const previewPrice = (() => {
    const price = Number(quotedPrice);
    const margin = Number(marginPercent);
    const ppn = Number(ppnRate);
    if (!price || price <= 0 || !Number.isFinite(margin) || margin < 0 || margin >= 1) return null;
    const exTaxPrice = taxBasis === "INCLUDE_PPN" ? (Number.isFinite(ppn) ? price / (1 + ppn) : null) : price;
    if (exTaxPrice === null) return null;
    return exTaxPrice / (1 - margin);
  })();

  return (
    <div style={{ marginBottom: 12, border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 10 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="link-btn"
        style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}
      >
        {open ? "▾" : "▸"} Trading quote manual (opsional)
        {line.tradingQuoteId && (
          <span className="pill success" style={{ fontSize: 9 }}>
            ada quote tersimpan
          </span>
        )}
      </button>
      <p className="hint" style={{ margin: "4px 0 0" }}>
        Dipakai hanya kalau item ini <strong>tidak</strong> auto-match ke pricelist Trading.
        <br />
        1) harga supplier → dinormalisasi ex-PPN, 2) dinaikkan sesuai Margin, 3) dikonfirmasi sebelum dipakai.
      </p>
      {open && (
        <div style={{ marginTop: 10 }}>
          <p className="field-label" style={{ marginBottom: 6 }}>
            1. Harga dari supplier
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
            <label className="field" style={{ flex: 1, marginBottom: 0 }}>
              <span className="field-label">Harga quote</span>
              <input type="number" min="0" value={quotedPrice} onChange={(e) => setQuotedPrice(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1, marginBottom: 0 }}>
              <span className="field-label">Basis pajak</span>
              <select value={taxBasis} onChange={(e) => setTaxBasis(e.target.value as typeof taxBasis)}>
                <option value="EXCLUDE_PPN">Belum termasuk PPN</option>
                <option value="INCLUDE_PPN">Sudah termasuk PPN</option>
              </select>
            </label>
          </div>
          {taxBasis === "INCLUDE_PPN" && (
            <label className="field" style={{ marginBottom: 8 }}>
              <span className="field-label">Tarif PPN (mis. 0.11)</span>
              <input type="number" step="0.01" min="0" value={ppnRate} onChange={(e) => setPpnRate(e.target.value)} />
            </label>
          )}

          <p className="field-label" style={{ marginTop: 10, marginBottom: 6 }}>
            2. Margin
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginBottom: 8 }}>
            <label className="field" style={{ flex: 1, marginBottom: 0 }}>
              <span className="field-label">Margin (0–0.999, mis. 0.25 = 25%)</span>
              <input
                type="number"
                step="0.01"
                value={marginPercent}
                onChange={(e) => onMarginPercentChange(e.target.value)}
              />
            </label>
            <p className="hint" style={{ margin: 0, whiteSpace: "nowrap" }}>
              {previewPrice !== null
                ? `≈ harga jual: ${fmt(Math.round(previewPrice))}`
                : "isi harga & margin untuk lihat harga jual"}
            </p>
          </div>

          <p className="field-label" style={{ marginTop: 10, marginBottom: 6 }}>
            3. Konfirmasi
          </p>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={landedCostConfirmed}
              onChange={(e) => setLandedCostConfirmed(e.target.checked)}
            />
            Harga sudah termasuk ongkir dan biaya impor
          </label>
          <p className="hint" style={{ marginTop: -4, marginBottom: 8 }}>
            Tanpa ini, harga tidak bisa dipakai untuk kalkulasi.
          </p>
          {error && (
            <p className="error-note" role="alert">
              {error}
            </p>
          )}
          {done && (
            <p className="pill success" role="status" style={{ display: "inline-block", marginBottom: 8 }}>
              Trading quote tersimpan.
            </p>
          )}
          <button type="button" onClick={submit} disabled={busy} className="btn small">
            {busy ? "Menyimpan…" : "Simpan Trading Quote"}
          </button>
        </div>
      )}
    </div>
  );
}

function formatDiscount(type: "PERCENT" | "AMOUNT" | null, value: number | null): string {
  if (!type || value === null) return "—";
  return type === "PERCENT" ? `${value}%` : fmt(value);
}

/**
 * Per-line discount editor, applied to the line's orderTotal before PPN and
 * before the costing's own total discount (see quotationDocument.ts). Sits
 * in the line table rather than the add/edit item panel — a discount is
 * something you add after seeing a price, not part of describing the item.
 */
function LineDiscountControl({
  line,
  costingId,
  onSaved,
}: {
  line: Line;
  costingId: string;
  onSaved: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<"PERCENT" | "AMOUNT">(line.discountType ?? "PERCENT");
  const [value, setValue] = useState(line.discountValue?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const parsed = value.trim() === "" ? null : Number(value);
      await apiPatch(`/api/costings/${costingId}/lines/${line.costingLineId}`, {
        expectedUpdatedAt: line.updatedAt,
        discountType: parsed === null ? null : type,
        discountValue: parsed,
      });
      setEditing(false);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => {
          setType(line.discountType ?? "PERCENT");
          setValue(line.discountValue?.toString() ?? "");
          setEditing(true);
        }}
        className="link-btn"
        style={{ fontSize: 12 }}
      >
        {formatDiscount(line.discountType, line.discountValue)}
      </button>
    );
  }

  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <select value={type} onChange={(e) => setType(e.target.value as "PERCENT" | "AMOUNT")} style={{ width: 56 }}>
        <option value="PERCENT">%</option>
        <option value="AMOUNT">Rp</option>
      </select>
      <input
        type="number"
        min="0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        style={{ width: 80 }}
        placeholder="0"
      />
      <button onClick={save} disabled={busy} className="btn small">
        OK
      </button>
      <button onClick={() => setEditing(false)} disabled={busy} className="btn secondary small">
        ✕
      </button>
    </div>
  );
}

export function Workspace(props: {
  initialCosting: Costing;
  initialLines: Line[];
  currentUserId: string;
  isSuperAdmin: boolean;
}) {
  const router = useRouter();
  const [costing, setCosting] = useState(props.initialCosting);
  const [lines, setLines] = useState(props.initialLines);
  // `kind` says what is being edited; `parentLineId` is set only while adding a
  // component, since that is the one case where the target set is not
  // recoverable from the line being edited.
  const [panel, setPanel] = useState<{
    mode: "closed" | "add" | "edit";
    kind?: "item" | "set" | "component";
    lineId?: string;
    parentLineId?: string;
  }>({ mode: "closed" });
  const [form, setForm] = useState<LineForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [showPreview, setShowPreview] = useState(false);
  const [showWaText, setShowWaText] = useState(false);
  const [waCopied, setWaCopied] = useState(false);
  const [showExplanation, setShowExplanation] = useState(false);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [adminPanel, setAdminPanel] = useState<"closed" | "void" | "reassign">("closed");
  const [voidReason, setVoidReason] = useState("");
  const [reassignNewOwnerId, setReassignNewOwnerId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [preview, setPreview] = useState<{
    subtotal: number;
    lineDiscountTotal: number;
    totalDiscountAmount: number;
    totalExPpn: number;
    ppnRate: number;
    ppnAmount: number;
    grandTotal: number;
    lines: {
      lineNo: number;
      description: string | null;
      qty: number;
      unitSellingPrice: number;
      orderTotal: number;
      components: { description: string | null; qtyPerSet: number }[];
    }[];
    quotationNo: string | null;
  } | null>(null);
  const [lookups, setLookups] = useState<Lookups>(EMPTY_LOOKUPS);
  const [adminUsers, setAdminUsers] = useState<{ userId: string; username: string; displayName: string }[]>([]);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [editingCustomer, setEditingCustomer] = useState(false);
  const [customers, setCustomers] = useState<{ customerId: string; customerName: string; customerCode: string | null; paymentTerms: string | null }[]>([]);
  const [customerSelected, setCustomerSelected] = useState("");
  const [customerNewName, setCustomerNewName] = useState("");

  const canEdit = costing.canEdit;
  // Native confirm()/alert() dialogs are inconsistent across browsers and
  // block automated testing (no in-page way to accept them), so
  // irreversible-ish actions use this inline confirm banner instead.
  const [pendingConfirm, setPendingConfirm] = useState<{ message: string; onConfirm: () => void } | null>(null);

  useEffect(() => {
    apiGet<Lookups>("/api/guides/active/lookups")
      // Merged over the empty shape rather than replacing it: a response that
      // is missing a key (an older server during a rolling deploy, a cached
      // payload from a previous build) would otherwise leave that field
      // undefined and crash the first render that indexes into it.
      .then((data) => setLookups({ ...EMPTY_LOOKUPS, ...data }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!canEdit) return;
    fetch("/api/customers")
      .then((r) => r.json())
      .then((data) => setCustomers(data.customers ?? []))
      .catch(() => {});
  }, [canEdit]);

const CUSTOMER_ADD_NEW = "__add_new__";

  function openCustomerEditor() {
    setCustomerSelected(costing.customerId ?? "");
    setCustomerNewName("");
    setEditingCustomer(true);
  }

  async function saveCustomer() {
    const isNew = customerSelected === CUSTOMER_ADD_NEW;
    const customerName = isNew ? customerNewName.trim() : "";
    if (isNew && !customerName) {
      setError("Masukkan nama customer baru.");
      return;
    }
    if (!isNew && !customerSelected) {
      setError("Pilih atau masukkan nama customer.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Selecting an existing customer sends its id directly -- precise, no
      // name-matching. Only the "+ Customer baru..." path sends a bare name,
      // which the server resolves-or-creates by exact match (same as costing
      // creation), so this is the one place a brand-new customer can appear.
      await apiPatch(`/api/costings/${costing.costingId}`, {
        expectedUpdatedAt: costing.updatedAt,
        ...(isNew ? { customerName } : { customerId: customerSelected }),
      });
      setEditingCustomer(false);
      await refreshCosting();
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal menyimpan customer.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!props.isSuperAdmin) return;
    apiGet<{ users: { userId: string; username: string; displayName: string }[] }>("/api/admin/users")
      .then((data) => setAdminUsers(data.users))
      .catch(() => {});
  }, [props.isSuperAdmin]);

  async function refreshCosting() {
    const data = await apiGet<Costing & { lines: Line[] }>(`/api/costings/${costing.costingId}`);
    setCosting(data);
    setLines(data.lines);
  }

  function openAddPanel() {
    setForm(EMPTY_FORM);
    setPanel({ mode: "add", kind: "item" });
    setError(null);
  }

  function openAddSetPanel() {
    setForm(EMPTY_FORM);
    setPanel({ mode: "add", kind: "set" });
    setError(null);
  }

  function openAddComponentPanel(set: Line) {
    setForm(EMPTY_FORM);
    setPanel({ mode: "add", kind: "component", parentLineId: set.costingLineId });
    setError(null);
  }

  function openEditPanel(line: Line) {
    setForm(lineToForm(line));
    setPanel({ mode: "edit", kind: line.lineKind, lineId: line.costingLineId });
    setError(null);
  }

  async function saveLine() {
    setBusy(true);
    setSaveStatus("saving");
    setError(null);
    try {
      const gradeLabel = gradeLabelFor(form.productFamily, form.gradeInput) ?? "";
      const coatingLabel = lookups.coatingLabels[form.coatingCode] ?? form.coatingCode;
      // Custom names whatever the user typed; Standard looks up Bolt/Nut's
      // known thread pitch for this size (standard_pitches — a physical
      // constant, not guide data). Neither carries a price effect for
      // Standard; only Custom's +10% surcharge does (calculate/route.ts).
      const pitchForDescription =
        form.pitchType === "CUSTOM"
          ? form.pitchValue || null
          : (lookups.standardPitchByFamilySize[form.productFamily]?.[form.sizeLabel] ?? null);
      const kind = panel.kind ?? "item";
      if (form.productFamily === "Custom Part" && !form.description.trim()) {
        throw new Error("Isi Description untuk Custom Part.");
      }
      if (form.productFamily === "Custom Part" && form.customUnitPrice.trim() === "") {
        throw new Error("Isi Unit Price untuk Custom Part.");
      }
      if (panel.mode === "add") {
        const created = await apiPost<{ costingLineId: string; updatedAt: string }>(`/api/costings/${costing.costingId}/lines`, {
          ...formToBody(form, "add", gradeLabel, kind, coatingLabel, pitchForDescription),
          ...(kind === "component" ? { parentLineId: panel.parentLineId } : {}),
        });
        if (form.productFamily === "Custom Part") {
          await apiPatch(`/api/costings/${costing.costingId}/lines/${created.costingLineId}`, {
            expectedUpdatedAt: created.updatedAt,
            unitPriceOverride: Number(form.customUnitPrice),
          });
        }
      } else if (panel.mode === "edit" && panel.lineId) {
        const line = lines.find((l) => l.costingLineId === panel.lineId)!;
        const updated = await apiPatch<{ updatedAt: string }>(`/api/costings/${costing.costingId}/lines/${panel.lineId}`, {
          expectedUpdatedAt: line.updatedAt,
          ...formToBody(form, "edit", gradeLabel, kind, coatingLabel, pitchForDescription),
        });
        if (form.productFamily === "Custom Part") {
          await apiPatch(`/api/costings/${costing.costingId}/lines/${panel.lineId}`, {
            expectedUpdatedAt: updated.updatedAt,
            unitPriceOverride: Number(form.customUnitPrice),
          });
        }
      }
      setPanel({ mode: "closed" });
      await refreshCosting();
      router.refresh();
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal menyimpan item.");
      setSaveStatus("error");
    } finally {
      setBusy(false);
    }
  }

  function deleteLine(line: Line) {
    setPendingConfirm({
      message: `Hapus item #${line.lineNo}?`,
      onConfirm: async () => {
        setBusy(true);
        try {
          await apiDelete(`/api/costings/${costing.costingId}/lines/${line.costingLineId}`);
          await refreshCosting();
        } catch (e) {
          setError((e as ApiError).message ?? "Gagal menghapus item.");
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function calculateAll() {
    setBusy(true);
    setError(null);
    setLineErrors({});
    try {
      await apiPost(`/api/costings/${costing.costingId}/calculate`);
      await refreshCosting();
    } catch (e) {
      const err = e as ApiError;
      setError(err.message ?? "Gagal menghitung.");
      if (err.lineErrors) {
        setLineErrors(Object.fromEntries(err.lineErrors.map((le) => [le.lineId, le.message])));
      }
    } finally {
      setBusy(false);
    }
  }

  function finalize() {
    setPendingConfirm({
      message: "Finalisasi costing ini? Setelah final, perubahan hanya melalui revisi baru.",
      onConfirm: async () => {
        setBusy(true);
        setError(null);
        try {
          await apiPost(`/api/costings/${costing.costingId}/finalize`, { expectedUpdatedAt: costing.updatedAt });
          await refreshCosting();
        } catch (e) {
          setError((e as ApiError).message ?? "Gagal finalisasi.");
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function createRevision() {
    setBusy(true);
    setError(null);
    try {
      const created = await apiPost<{ costingId: string }>(`/api/costings/${costing.costingId}/revisions`);
      router.push(`/costings/${created.costingId}`);
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal membuat revisi.");
    } finally {
      setBusy(false);
    }
  }

  async function duplicateAsNew() {
    setBusy(true);
    setError(null);
    try {
      const created = await apiPost<{ costingId: string }>(`/api/costings/${costing.costingId}/duplicate`);
      router.push(`/costings/${created.costingId}`);
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal menduplikasi.");
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    try {
      // Read-only at any status; never audited (AUD-016 — a screen view isn't an export).
      const data = await apiGet<{ document: typeof preview }>(`/api/costings/${costing.costingId}/quotation-summary`);
      setPreview(data.document);
      setShowPreview(true);
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal memuat preview.");
    }
  }

  async function downloadExport(format: "xlsx" | "pdf") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/costings/${costing.costingId}/export?format=${format}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? "Gagal mengekspor quotation.");
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameMatch?.[1] ?? `${costing.costingId}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mengekspor quotation.");
    } finally {
      setBusy(false);
    }
  }

  async function submitVoid() {
    if (!voidReason.trim()) {
      setError("Alasan pembatalan wajib diisi.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/costings/${costing.costingId}/void`, { reason: voidReason.trim() });
      setAdminPanel("closed");
      setVoidReason("");
      await refreshCosting();
      router.refresh();
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal membatalkan costing.");
    } finally {
      setBusy(false);
    }
  }

  async function submitReassign() {
    if (!reassignNewOwnerId.trim() || !reassignReason.trim()) {
      setError("Owner baru dan alasan wajib diisi.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/costings/${costing.costingId}/reassign`, {
        newOwnerId: reassignNewOwnerId.trim(),
        reason: reassignReason.trim(),
      });
      setAdminPanel("closed");
      setReassignNewOwnerId("");
      setReassignReason("");
      await refreshCosting();
      router.refresh();
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal reassign owner.");
    } finally {
      setBusy(false);
    }
  }

  async function loadExplanation(line: Line) {
    try {
      const data = await apiGet<Explanation>(`/api/costings/${costing.costingId}/lines/${line.costingLineId}/explanation`);
      setExplanation(data);
      setShowExplanation(true);
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal memuat penjelasan perhitungan.");
    }
  }

  const editableStatus = costing.status === "draft" || costing.status === "calculated";
  const isOwner = costing.ownerUserId === props.currentUserId;

  const availableGrades = form.productFamily ? (lookups.gradesByFamily[form.productFamily] ?? []) : [];
  const gradeLabels = form.productFamily ? (lookups.gradeLabelsByFamily[form.productFamily] ?? {}) : {};
  const gradeLabelFor = (family: string | null, grade: string | null): string | null =>
    family && grade ? (lookups.gradeLabelsByFamily[family]?.[grade] ?? grade) : grade;
  /** Fallback label for a line the user never described, used for both items and set components. */
  const describeLine = (l: Line): string =>
    `${l.productFamily ?? ""} ${gradeLabelFor(l.productFamily, l.gradeInput) ?? ""} ${l.sizeLabel ?? ""}`.trim();
  const lineTree = useMemo(() => buildLineTree(lines), [lines]);

  /**
   * Best-effort match for how CBP actually types a quotation into WhatsApp —
   * "- DESCRIPTION = qty @price" per item, a set printed as its own
   * description with components listed under it, and a shared footer only
   * when every line actually agrees (tax mode is a system-wide constant;
   * lead time is per-line and often isn't uniform, which is exactly what the
   * Lead Time column exists to catch — so the footer omits it rather than
   * print a number that doesn't hold for every line).
   */
  function buildWaText(): string {
    const idNum = (n: number) => n.toLocaleString("id-ID");
    const blocks: string[] = [];
    for (const { line: l, components } of lineTree) {
      if (l.latestUnitSellingPrice === null) continue; // not calculated yet — nothing to quote
      const desc = (l.description ?? describeLine(l)).toUpperCase();
      if (l.lineKind === "set") {
        const compLines = components.map(
          (c) => `  - ${(c.description ?? describeLine(c)).toUpperCase()}${(c.qtyPerSet ?? 1) > 1 ? ` (${c.qtyPerSet}x)` : ""}`,
        );
        blocks.push(
          [desc, ...compLines, `Qty ${idNum(l.qty ?? 0)} set @ ${idNum(l.latestUnitSellingPrice)}`].join("\n"),
        );
      } else {
        blocks.push(`- ${desc} = ${idNum(l.qty ?? 0)} @ ${idNum(l.latestUnitSellingPrice)}`);
      }
    }

    const topLevelLeadTimes = [...new Set(lineTree.map(({ line: l }) => l.leadTimeDays).filter((d) => d !== null))];
    const footer = ["Exclude PPN"]; // tax_output_mode is a system-wide constant (always EXCLUDE_PPN)
    if (topLevelLeadTimes.length === 1) footer.push(formatLeadTimeDays(topLevelLeadTimes[0]));

    return [...blocks, "", ...footer].join("\n");
  }

  function openWaText() {
    setWaCopied(false);
    setShowWaText(true);
  }

  async function copyWaText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setWaCopied(true);
    } catch {
      setWaCopied(false);
    }
  }

  const panelKind = panel.kind ?? "item";
  const resolvedProfile =
    form.productFamily && form.gradeInput ? lookups.gradeToProfile[form.productFamily]?.[form.gradeInput] : undefined;
  const availableSizes = resolvedProfile ? (lookups.sizesByProfile[resolvedProfile] ?? []) : [];
  const availableThreadConditions = form.productFamily ? (lookups.threadConditionsByFamily[form.productFamily] ?? []) : [];
  const leadTimeScope = resolveTypeLabelForLeadTime(form);
  const availableLeadTimes = leadTimeScope ? (lookups.leadTimeBucketsByFamily[leadTimeScope] ?? []) : [];
  const editingLine = panel.mode === "edit" && panel.lineId ? lines.find((l) => l.costingLineId === panel.lineId) : null;

  return (
    <div className="app-shell" style={{ maxWidth: 1220 }}>
      <div style={{ marginBottom: 16 }}>
        <a href="/dashboard" className="link-btn">
          &larr; Dashboard
        </a>
      </div>

      <header className="app-header">
        <div className="brand">
          <img src="/brand/cbp-logomark.png" alt="CBP" className="brand-mark" />
          <div className="brand-text">
            {editingCustomer ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <select value={customerSelected} onChange={(e) => setCustomerSelected(e.target.value)} style={{ minWidth: 200 }}>
                  <option value="">— pilih customer —</option>
                  {customers.map((c) => (
                    <option key={c.customerId} value={c.customerId}>
                      {c.customerName}
                    </option>
                  ))}
                  <option value={CUSTOMER_ADD_NEW}>+ Customer baru…</option>
                </select>
                {customerSelected === CUSTOMER_ADD_NEW && (
                  <input
                    value={customerNewName}
                    onChange={(e) => setCustomerNewName(e.target.value)}
                    placeholder="Nama customer baru"
                    style={{ width: 180 }}
                  />
                )}
                <button onClick={saveCustomer} disabled={busy} className="btn small">
                  Save
                </button>
                <button onClick={() => setEditingCustomer(false)} disabled={busy} className="btn secondary small">
                  Cancel
                </button>
              </div>
            ) : (
              <h1 style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                {costing.customerName || <em style={{ color: "var(--ink-soft)", fontSize: 15 }}>belum ada customer</em>}
                {canEdit && editableStatus && (
                  <button onClick={openCustomerEditor} className="link-btn" style={{ fontSize: 12 }}>
                    {costing.customerName ? "change" : "+ set customer"}
                  </button>
                )}
              </h1>
            )}
            <p>
              {costing.quotationNo ?? "no quotation no."} {costing.revisionNo > 0 && `· revision #${costing.revisionNo}`}
            </p>
            <PaymentTermsField costing={costing} canEdit={canEdit && editableStatus} onSaved={refreshCosting} />
            <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
              <MarkupDisplay costing={costing} />
              <TotalDiscountField costing={costing} canEdit={canEdit && editableStatus} onSaved={refreshCosting} />
            </div>
          </div>
        </div>
        <div className="header-actions">
          <StatusPill status={costing.status} />
          {!canEdit && <span className="pill neutral">View-only</span>}
          {saveStatus !== "idle" && (
            <span
              className={`save-status ${saveStatus === "saving" ? "busy" : saveStatus === "error" ? "error" : "ok"}`}
            >
              {saveStatus === "saving" ? "saving…" : saveStatus === "error" ? "error" : "saved"}
            </span>
          )}
        </div>
      </header>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {costing.status !== "finalized" && costing.status !== "revised" && (
          <button onClick={loadPreview} className="btn secondary small">
            Preview
          </button>
        )}
        {(costing.status === "finalized" || costing.status === "revised") && lines.length > 0 && (
          <button onClick={openWaText} className="btn secondary small">
            Copy as WA Text
          </button>
        )}
        {(costing.status === "finalized" || costing.status === "revised") && (
          <>
            <button onClick={() => downloadExport("xlsx")} disabled={busy} className="btn secondary small">
              Download XLSX
            </button>
            <button onClick={() => downloadExport("pdf")} disabled={busy} className="btn secondary small">
              Download PDF
            </button>
          </>
        )}
        {canEdit && editableStatus && (
          <button onClick={calculateAll} disabled={busy || lines.length === 0} className="btn small">
            Calculate All
          </button>
        )}
        {canEdit && costing.status === "calculated" && (
          <button onClick={finalize} disabled={busy} className="btn small">
            Finalize
          </button>
        )}
        {isOwner && (costing.status === "finalized" || costing.status === "revised") && (
          <button onClick={createRevision} disabled={busy} className="btn small">
            Create Revision
          </button>
        )}
        <button onClick={duplicateAsNew} disabled={busy} className="btn secondary small">
          Duplicate as New
        </button>
        {props.isSuperAdmin && (costing.status === "finalized" || costing.status === "revised") && (
          <button onClick={() => setAdminPanel("void")} disabled={busy} className="btn danger small">
            Void
          </button>
        )}
        {props.isSuperAdmin && (
          <button onClick={() => setAdminPanel("reassign")} disabled={busy} className="btn secondary small">
            Reassign Owner
          </button>
        )}
      </div>

      {adminPanel === "void" && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          <h2 style={{ color: "var(--danger)" }}>Void this costing (Super Admin)</h2>
          <div className="field-row cols-1">
            <label className="field">
              <span className="field-label">Reason (required)</span>
              <input value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={submitVoid} disabled={busy} className="btn danger small">
              Confirm Void
            </button>
            <button onClick={() => setAdminPanel("closed")} disabled={busy} className="btn secondary small">
              Cancel
            </button>
          </div>
        </div>
      )}

      {adminPanel === "reassign" && (
        <div className="card">
          <h2>Reassign owner (Super Admin)</h2>
          <div className="field-row cols-2">
            <label className="field">
              <span className="field-label">New owner (required)</span>
              <select value={reassignNewOwnerId} onChange={(e) => setReassignNewOwnerId(e.target.value)}>
                <option value="">— pilih user —</option>
                {adminUsers
                  .filter((u) => u.userId !== costing.ownerUserId)
                  .map((u) => (
                    <option key={u.userId} value={u.userId}>
                      {u.displayName} ({u.username})
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Reason (required)</span>
              <input value={reassignReason} onChange={(e) => setReassignReason(e.target.value)} />
            </label>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={submitReassign} disabled={busy} className="btn small">
              Confirm Reassign
            </button>
            <button onClick={() => setAdminPanel("closed")} disabled={busy} className="btn secondary small">
              Cancel
            </button>
          </div>
        </div>
      )}

      {pendingConfirm && (
        <div className="warn-note" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>{pendingConfirm.message}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                const action = pendingConfirm.onConfirm;
                setPendingConfirm(null);
                action();
              }}
              disabled={busy}
              className="btn small"
            >
              Ya, lanjutkan
            </button>
            <button onClick={() => setPendingConfirm(null)} disabled={busy} className="btn secondary small">
              Batal
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}

      <div className="card">
        <div className="section-actions">
          <h2 style={{ marginBottom: 0 }}>Items</h2>
          {canEdit && editableStatus && panel.mode === "closed" && (
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={openAddPanel} className="btn small">
                + Add Item
              </button>
              <button onClick={openAddSetPanel} className="btn secondary small">
                + Add Set
              </button>
            </div>
          )}
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Harga</th>
                <th scope="col">Description</th>
                <th scope="col">Qty</th>
                <th scope="col">Lead Time</th>
                <th scope="col">Unit Price</th>
                <th scope="col">Order Total</th>
                <th scope="col">Diskon</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lineTree.map(({ line: l, components }, i) => {
                const displayNo = i + 1;
                const actions = (line: Line, label: string) => (
                  <div style={{ display: "flex", gap: 6 }}>
                    {canEdit && editableStatus && (
                      <>
                        <button
                          onClick={() => openEditPanel(line)}
                          className="btn secondary small"
                          aria-label={`Edit ${label}`}
                        >
                          Edit
                        </button>
                        <button onClick={() => deleteLine(line)} className="icon-btn" aria-label={`Delete ${label}`}>
                          <span aria-hidden="true">✕</span>
                        </button>
                      </>
                    )}
                    {line.latestUnitSellingPrice !== null && (
                      <button
                        onClick={() => loadExplanation(line)}
                        className="btn secondary small"
                        aria-label={`Explain calculation for ${label}`}
                      >
                        Explain
                      </button>
                    )}
                  </div>
                );

                return (
                  <Fragment key={l.costingLineId}>
                    <tr>
                      <td className="mono">{displayNo}</td>
                      <td>
                        {l.lineKind === "set" ? (
                          <span className="pill neutral">SET</span>
                        ) : (
                          <PriceKindControl
                            line={l}
                            costingId={costing.costingId}
                            canEdit={canEdit && editableStatus}
                            onSaved={refreshCosting}
                          />
                        )}
                      </td>
                      <td>
                        {l.description ??
                          (l.lineKind === "set"
                            ? defaultSetDescription(
                                components.map((c) => ({
                                  description: describeLine(c),
                                  qtyPerSet: c.qtyPerSet ?? 1,
                                })),
                              ) || "Set tanpa nama"
                            : describeLine(l))}
                        {l.needsRecalculation && (
                          <span className="pill amber" style={{ marginLeft: 6 }}>
                            perlu hitung ulang
                          </span>
                        )}
                        {lineErrors[l.costingLineId] && (
                          <div className="error-note" style={{ marginTop: 4, marginBottom: 0 }}>
                            {lineErrors[l.costingLineId]}
                          </div>
                        )}
                      </td>
                      <td className="mono">{l.qty}</td>
                      <td className="mono">
                        {l.lineKind === "set" ? (
                          // A set's own lead_time_days is the max of its components' —
                          // rolled up by Calculate All. Before the first calculation
                          // there's nothing to roll up yet, so fall back to a live
                          // preview from whatever the components currently show.
                          l.leadTimeDays !== null
                            ? formatLeadTimeDays(l.leadTimeDays)
                            : (() => {
                                const componentLeadTimes = components
                                  .map((c) => c.leadTimeDays)
                                  .filter((d): d is number => d !== null);
                                if (componentLeadTimes.length === 0) return "—";
                                return formatLeadTimeDays(Math.max(...componentLeadTimes));
                              })()
                        ) : (
                          formatLeadTimeDays(l.leadTimeDays)
                        )}
                      </td>
                      <td className="mono">
                        {canEdit && editableStatus ? (
                          <UnitPriceOverrideControl line={l} costingId={costing.costingId} onSaved={refreshCosting} />
                        ) : (
                          fmt(l.latestUnitSellingPrice)
                        )}
                      </td>
                      <td className="mono">{fmt(l.latestOrderTotal)}</td>
                      <td>
                        {canEdit && editableStatus ? (
                          <LineDiscountControl
                            line={l}
                            costingId={costing.costingId}
                            onSaved={refreshCosting}
                          />
                        ) : (
                          formatDiscount(l.discountType, l.discountValue)
                        )}
                      </td>
                      <td>{actions(l, `${l.lineKind === "set" ? "set" : "item"} ${displayNo}`)}</td>
                    </tr>

                    {components.map((c, ci) => (
                      <tr key={c.costingLineId} className="component-row">
                        <td />
                        <td style={{ paddingLeft: 18, color: "var(--muted)" }}>{`${displayNo}.${ci + 1}`}</td>
                        <td style={{ color: "var(--muted)" }}>
                          {c.description ?? describeLine(c)}
                          {lineErrors[c.costingLineId] && (
                            <div className="error-note" style={{ marginTop: 4, marginBottom: 0 }}>
                              {lineErrors[c.costingLineId]}
                            </div>
                          )}
                        </td>
                        {/* Per set, not the produced total — the figure the user typed. */}
                        <td className="mono" style={{ color: "var(--muted)" }}>{`${c.qtyPerSet ?? 1} / set`}</td>
                        <td className="mono" style={{ color: "var(--muted)" }}>{formatLeadTimeDays(c.leadTimeDays)}</td>
                        <td className="mono" style={{ color: "var(--muted)" }}>
                          {fmt(c.latestUnitSellingPrice)}
                        </td>
                        <td />
                        <td />
                        <td>{actions(c, `component ${displayNo}.${ci + 1}`)}</td>
                      </tr>
                    ))}

                    {l.lineKind === "set" && (
                      <tr className="component-row">
                        <td />
                        <td colSpan={8} style={{ paddingLeft: 18 }}>
                          {canEdit && editableStatus && panel.mode === "closed" && (
                            <button onClick={() => openAddComponentPanel(l)} className="btn secondary small">
                              + Add Component
                            </button>
                          )}
                          {components.length === 0 && (
                            <span className="pill danger" style={{ marginLeft: 8 }}>
                              set kosong
                            </span>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={9} className="empty-state">
                    Belum ada item.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {panel.mode !== "closed" && (
        <div
          style={{
            position: "fixed",
            right: 0,
            top: 0,
            bottom: 0,
            width: 400,
            background: "var(--surface)",
            borderLeft: "1px solid var(--border)",
            padding: 20,
            overflowY: "auto",
            boxShadow: "-4px 0 16px rgba(0,0,0,0.15)",
            zIndex: 100,
          }}
        >
          <h2 style={{ fontSize: 16, marginBottom: 16 }}>
            {panel.mode === "add" ? "Add" : "Edit"}{" "}
            {panelKind === "set" ? "Set" : panelKind === "component" ? "Component" : "Item"}
          </h2>

          {panelKind === "set" && (
            <>
              <p className="hint" style={{ marginTop: 0 }}>
                Sebuah set dihargai dari komponennya. Isi nama dan jumlah set di sini, lalu tambahkan komponen dari
                tabel.
              </p>
              <label className="field" style={{ marginBottom: 12 }}>
                <span className="field-label">Description</span>
                <input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="mis. Hex Bolt c/w Hex Nut, Washer"
                />
              </label>
              <label className="field" style={{ marginBottom: 12 }}>
                <span className="field-label">Qty (jumlah set)</span>
                <input
                  type="number"
                  min="1"
                  value={form.qty}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== "" && Number(v) < 1) return;
                    setForm({ ...form, qty: v });
                  }}
                />
              </label>
            </>
          )}

          {panelKind !== "set" && (
            <>
          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Product Family</span>
            <select
              value={form.productFamily}
              onChange={(e) => setForm({ ...form, productFamily: e.target.value, gradeInput: "", diameterMm: "" })}
            >
              <option value="">-- pilih --</option>
              {lookups.productFamilies
                .filter((f) => f !== "Custom Part" || panelKind !== "component")
                .map((f) => (
                  <option key={f} value={f}>
                    {PRODUCT_FAMILY_LABELS[f] ?? f}
                  </option>
                ))}
            </select>
          </label>

          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Description</span>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={form.productFamily === "Custom Part" ? "mis. Stud Bolt A193-B7, M20x150" : undefined}
            />
          </label>

          {form.productFamily !== "Custom Part" && (
          <>
          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Grade</span>
            {availableGrades.length > 0 ? (
              <select
                value={form.gradeInput}
                onChange={(e) => setForm({ ...form, gradeInput: e.target.value, diameterMm: "" })}
              >
                <option value="">-- pilih --</option>
                {availableGrades.map((g) => (
                  <option key={g} value={g}>
                    {gradeLabels[g] ?? g}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={form.gradeInput}
                onChange={(e) => setForm({ ...form, gradeInput: e.target.value })}
                placeholder={form.productFamily ? "no grades in active guide" : "pilih Product Family dulu"}
              />
            )}
          </label>

          {availableThreadConditions.length > 0 && (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Thread Condition</span>
              <select
                value={form.threadCondition}
                onChange={(e) => setForm({ ...form, threadCondition: e.target.value })}
              >
                <option value="">-- pilih --</option>
                {availableThreadConditions.map((tc) => (
                  <option key={tc} value={tc}>
                    {tc}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Size / Diameter (mm)</span>
            {availableSizes.length > 0 ? (
              <select
                value={form.sizeLabel}
                onChange={(e) => {
                  const chosen = availableSizes.find((s) => s.sizeLabel === e.target.value);
                  setForm({ ...form, sizeLabel: e.target.value, diameterMm: chosen?.diameterMm?.toString() ?? "" });
                }}
              >
                <option value="">-- pilih --</option>
                {availableSizes.map((s) => (
                  <option key={s.sizeLabel} value={s.sizeLabel}>
                    {s.sizeLabel}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                value={form.diameterMm}
                onChange={(e) => setForm({ ...form, diameterMm: e.target.value, sizeLabel: "" })}
                placeholder={resolvedProfile ? "no sizes in active guide" : "pilih Grade dulu"}
              />
            )}
          </label>

          {form.productFamily !== "Nut" && form.productFamily !== "Washer" && (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Length</span>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="number"
                  min="0"
                  value={form.lengthMm}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v !== "" && Number(v) < 0) return;
                    setForm({ ...form, lengthMm: v });
                  }}
                  style={{ flex: 1 }}
                />
                <select
                  value={form.lengthUnit}
                  onChange={(e) => setForm({ ...form, lengthUnit: e.target.value as LineForm["lengthUnit"] })}
                  style={{ width: 70 }}
                  aria-label="Satuan panjang"
                >
                  <option value="mm">mm</option>
                  <option value="in">&quot;</option>
                </select>
              </div>
            </label>
          )}
          </>
          )}
          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Lead time</span>
            <select value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })}>
              <option value="">-- pilih --</option>
              {(availableLeadTimes.length > 0 ? availableLeadTimes : GENERIC_LEAD_TIME_OPTIONS).map((b) => (
                <option key={String(b.value)} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          {form.productFamily !== "Custom Part" && (
          <>
          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Pitch / Thread</span>
            <select
              value={form.pitchType}
              onChange={(e) => setForm({ ...form, pitchType: e.target.value as LineForm["pitchType"] })}
            >
              <option value="STANDARD">Standard</option>
              <option value="CUSTOM">Custom (+10%)</option>
            </select>
          </label>
          {form.pitchType === "CUSTOM" && (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Pitch/Thread custom</span>
              <input
                value={form.pitchValue}
                onChange={(e) => setForm({ ...form, pitchValue: e.target.value })}
                placeholder="mis. T16"
              />
            </label>
          )}
          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Dies/Tooling tersedia?</span>
            <select
              value={form.diesOption}
              onChange={(e) => setForm({ ...form, diesOption: e.target.value as LineForm["diesOption"] })}
            >
              <option value="yes">Ya</option>
              <option value="no_lookup">Tidak</option>
              <option value="manual">Lainnya...</option>
            </select>
          </label>
          {form.diesOption === "manual" && (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Dies total cost</span>
              <input
                type="number"
                value={form.diesTotalCost}
                onChange={(e) => setForm({ ...form, diesTotalCost: e.target.value })}
              />
            </label>
          )}
          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">
              Weight tolerance (0–1, e.g. 0.02 = 2%) — leave blank for guide default ({(lookups.defaultWeightTolerancePercent * 100).toFixed(2)}%)
            </span>
            <input
              type="number"
              step="0.001"
              min="0"
              max="1"
              value={form.weightTolerancePercent}
              onChange={(e) => setForm({ ...form, weightTolerancePercent: e.target.value })}
              placeholder={lookups.defaultWeightTolerancePercent.toString()}
            />
          </label>

          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Coating code</span>
            <select value={form.coatingCode} onChange={(e) => setForm({ ...form, coatingCode: e.target.value })}>
              {/* No coating is quoted as "Plain"; the empty value is what the engine sees. */}
              <option value="">Plain</option>
              {lookups.coatingCodes.map((c) => (
                <option key={c} value={c}>
                  {lookups.coatingLabels[c] ?? c}
                </option>
              ))}
            </select>
          </label>
          </>
          )}

          {form.productFamily === "Custom Part" && (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Unit Price</span>
              <input
                type="number"
                min="0"
                value={form.customUnitPrice}
                onChange={(e) => setForm({ ...form, customUnitPrice: e.target.value })}
                placeholder="Harga jual per unit"
              />
              <span className="hint">
                Custom Part tidak dihitung otomatis — harga ini langsung dipakai sebagai harga jual per unit.
              </span>
            </label>
          )}

          {panelKind === "component" ? (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Qty per set</span>
              <input
                type="number"
                min="1"
                value={form.qtyPerSet}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== "" && Number(v) < 1) return;
                  setForm({ ...form, qtyPerSet: v });
                }}
              />
              <span className="hint">
                Berapa buah komponen ini dalam satu set. Jumlah yang diproduksi = angka ini x jumlah set, dan itulah
                yang dipakai untuk potongan kuantitas dan pembagian biaya dies.
              </span>
            </label>
          ) : (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Qty</span>
              <input
                type="number"
                min="1"
                value={form.qty}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v !== "" && Number(v) < 1) return;
                  setForm({ ...form, qty: v });
                }}
              />
            </label>
          )}

          {panel.mode === "edit" && panelKind === "item" && editingLine && form.productFamily !== "Custom Part" && (
            <TradingQuoteManualPanel
              line={editingLine}
              costingId={costing.costingId}
              marginPercent={form.marginPercent}
              onMarginPercentChange={(v) => setForm({ ...form, marginPercent: v })}
              onSaved={async () => {
                await refreshCosting();
                router.refresh();
              }}
            />
          )}
            </>
          )}

          {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={saveLine} disabled={busy} className="btn">
              Save
            </button>
            <button onClick={() => setPanel({ mode: "closed" })} disabled={busy} className="btn secondary">
              Cancel
            </button>
          </div>
        </div>
      )}

      {showPreview && preview && (
        <Modal onClose={() => setShowPreview(false)} width={560} label="Quotation Preview">
          <Ticket title="Quotation Preview" tag={preview.quotationNo ?? "DRAFT"}>
            {preview.lines.map((l) => (
              <div key={l.lineNo}>
                <TicketLine label={l.description ?? `Item #${l.lineNo}`} value={fmt(l.orderTotal)} />
                <TicketLine label={`${l.qty} × ${fmt(l.unitSellingPrice)}`} value="" sub />
                {l.components.map((c, ci) => (
                  <TicketLine
                    key={ci}
                    label={`    • ${c.qtyPerSet > 1 ? `${c.qtyPerSet}x ` : ""}${c.description ?? "—"}`}
                    value=""
                    sub
                  />
                ))}
              </div>
            ))}
          </Ticket>
          <div style={{ padding: "0 18px" }}>
            {(preview.lineDiscountTotal > 0 || preview.totalDiscountAmount > 0) && (
              <>
                <TicketLine label="Subtotal" value={fmt(preview.subtotal)} sub />
                {preview.lineDiscountTotal > 0 && (
                  <TicketLine label="Diskon per item" value={`-${fmt(preview.lineDiscountTotal)}`} sub />
                )}
                {preview.totalDiscountAmount > 0 && (
                  <TicketLine label="Diskon total" value={`-${fmt(preview.totalDiscountAmount)}`} sub />
                )}
              </>
            )}
            <TicketLine label="Total sebelum PPN" value={fmt(preview.totalExPpn)} sub />
            <TicketLine label={`PPN ${(preview.ppnRate * 100).toFixed(0)}%`} value={fmt(preview.ppnAmount)} sub />
          </div>
          <TicketTotal label="TOTAL" value={fmt(preview.grandTotal)} />
          <div style={{ background: "var(--ink)", padding: "0 18px 16px" }}>
            <button onClick={() => setShowPreview(false)} className="btn secondary small">
              Close
            </button>
          </div>
        </Modal>
      )}

      {showWaText && (
        <Modal onClose={() => setShowWaText(false)} width={480} label="Copy as WhatsApp Text">
          <div style={{ padding: 16 }}>
            <h2 style={{ fontSize: 15, marginTop: 0 }}>Copy as WA Text</h2>
            <p className="hint" style={{ marginTop: 0 }}>
              Format perkiraan seperti biasa ditulis di WhatsApp. Cek dan sesuaikan sebelum dikirim.
            </p>
            <textarea
              readOnly
              value={buildWaText()}
              rows={14}
              style={{ width: "100%", fontFamily: "monospace", fontSize: 12.5, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
              <button onClick={() => copyWaText(buildWaText())} className="btn small">
                {waCopied ? "Tersalin!" : "Copy"}
              </button>
              <button onClick={() => setShowWaText(false)} className="btn secondary small">
                Close
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showExplanation && explanation && (
        <Modal onClose={() => setShowExplanation(false)} width={620} label="Calculation Explanation">
          <Ticket title="Calculation Explanation" tag={new Date(explanation.calculatedAt).toLocaleDateString()}>
            {explanation.rawWeightPerItemKg !== null && (
              <TicketLine label="Raw weight / item" value={`${explanation.rawWeightPerItemKg.toFixed(6)} kg`} sub />
            )}
            {explanation.costingWeightPerItemKg !== null && (
              <TicketLine
                label="Costing weight / item (+2% tolerance)"
                value={`${explanation.costingWeightPerItemKg.toFixed(6)} kg`}
                sub
              />
            )}
            <TicketLine label="Base price / item" value={fmt(explanation.basePricePerItem)} />
            <TicketLine label="Coating price / item" value={fmt(explanation.coatingPricePerItem)} />
            <TicketLine label="Dies price / item" value={fmt(explanation.diesPricePerItem)} />
            <TicketLine label="Before rounding" value={explanation.unitPriceBeforeRounding.toFixed(2)} sub />
            <TicketDivider />
            {explanation.explainedRules.map((r, i) => (
              <Fragment key={i}>
                <TicketLine label={r.table} value={(r.row?.source_key as string) ?? r.id} sub />
                {r.note && <TicketLine label={r.note} value="" sub />}
              </Fragment>
            ))}
          </Ticket>
          <TicketTotal
            label="Unit selling price"
            value={fmt(explanation.unitSellingPrice)}
            note={`Order total: ${fmt(explanation.orderTotal)} · hash ${explanation.resultHash.slice(0, 16)}…`}
          />
          <div style={{ background: "var(--ink)", padding: "0 18px 16px" }}>
            <button onClick={() => setShowExplanation(false)} className="btn secondary small">
              Close
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * Payment terms are negotiated per customer account, so the account value is
 * the default and this field only records a deviation for one quotation.
 * Showing the inherited value (rather than an empty box) makes clear that
 * blank means "use the account terms", not "no terms".
 */
/**
 * Read-only display of the customer account's markup — a segment attribute
 * set on the Customer record (CustomersAdmin), not something negotiated per
 * quotation, so unlike Payment Terms there's no override control here.
 */
function MarkupDisplay({ costing }: { costing: Costing }) {
  return (
    <p style={{ fontSize: 12 }}>
      Markup:{" "}
      {costing.accountMarkupPercent !== null ? (
        `${(costing.accountMarkupPercent * 100).toFixed(2)}%`
      ) : (
        <em style={{ color: "var(--ink-soft)" }}>tidak ada</em>
      )}
    </p>
  );
}

function PaymentTermsField({
  costing,
  canEdit,
  onSaved,
}: {
  costing: Costing;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const accountTerms = costing.accountPaymentTerms;
  // No override and no account default: fall back to CBP's standard terms
  // rather than showing nothing (business-confirmed 2026-09-12).
  const isDefault = !costing.paymentTermsOverride && !accountTerms;
  const effective = costing.paymentTermsOverride ?? accountTerms ?? DEFAULT_PAYMENT_TERMS;

  async function save() {
    setBusy(true);
    try {
      await apiPatch(`/api/costings/${costing.costingId}`, {
        expectedUpdatedAt: costing.updatedAt,
        paymentTermsOverride: value.trim() || null,
      });
      setEditing(false);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <p style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Termin pembayaran khusus quotation ini"
          style={{ minWidth: 240 }}
        >
          <option value="">-- pakai default akun ({accountTerms ?? DEFAULT_PAYMENT_TERMS}) --</option>
          {PAYMENT_TERMS_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
        <button onClick={save} disabled={busy} className="btn small">
          Simpan
        </button>
        <button onClick={() => setEditing(false)} disabled={busy} className="btn secondary small">
          Batal
        </button>
      </p>
    );
  }

  return (
    <p style={{ fontSize: 12 }}>
      Termin: {isDefault ? <em style={{ color: "var(--ink-soft)" }}>{effective}</em> : effective}
      {costing.paymentTermsOverride && (
        <span className="pill neutral" style={{ marginLeft: 6, fontSize: 10 }}>
          khusus quotation ini
        </span>
      )}
      {canEdit && (
        <button
          onClick={() => {
            setValue(costing.paymentTermsOverride ?? "");
            setEditing(true);
          }}
          className="link-btn"
          style={{ fontSize: 11, marginLeft: 6 }}
        >
          ubah
        </button>
      )}
    </p>
  );
}

/**
 * Total discount, applied after every line's own discount and before PPN
 * (see quotationDocument.ts). Separate from per-line discounts (the table's
 * Diskon column) — this is the one negotiated on the whole PO, not on one
 * item.
 */
function TotalDiscountField({
  costing,
  canEdit,
  onSaved,
}: {
  costing: Costing;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<"PERCENT" | "AMOUNT">(costing.totalDiscountType ?? "PERCENT");
  const [value, setValue] = useState(costing.totalDiscountValue?.toString() ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const parsed = value.trim() === "" ? null : Number(value);
      await apiPatch(`/api/costings/${costing.costingId}`, {
        expectedUpdatedAt: costing.updatedAt,
        totalDiscountType: parsed === null ? null : type,
        totalDiscountValue: parsed,
      });
      setEditing(false);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <p style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 12 }}>Diskon total:</span>
        <select value={type} onChange={(e) => setType(e.target.value as "PERCENT" | "AMOUNT")} style={{ width: 56 }}>
          <option value="PERCENT">%</option>
          <option value="AMOUNT">Rp</option>
        </select>
        <input
          type="number"
          min="0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ width: 100 }}
          placeholder="0"
        />
        <button onClick={save} disabled={busy} className="btn small">
          Simpan
        </button>
        <button onClick={() => setEditing(false)} disabled={busy} className="btn secondary small">
          Batal
        </button>
      </p>
    );
  }

  return (
    <p style={{ fontSize: 12 }}>
      Diskon total: {formatDiscount(costing.totalDiscountType, costing.totalDiscountValue)}
      {canEdit && (
        <button
          onClick={() => {
            setType(costing.totalDiscountType ?? "PERCENT");
            setValue(costing.totalDiscountValue?.toString() ?? "");
            setEditing(true);
          }}
          className="link-btn"
          style={{ fontSize: 11, marginLeft: 6 }}
        >
          ubah
        </button>
      )}
    </p>
  );
}

