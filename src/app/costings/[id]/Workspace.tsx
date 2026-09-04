"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { apiGet, apiPost, apiPatch, apiDelete, type ApiError } from "./clientApi";
import { buildLineTree, defaultSetDescription } from "@/lib/costings/sets";
import { StatusPill } from "@/components/Pills";
import { Modal } from "@/components/Modal";
import { Ticket, TicketLine, TicketDivider, TicketTotal } from "@/components/Ticket";

type Costing = {
  costingId: string;
  quotationNo: string | null;
  customerName: string;
  ownerUserId: string;
  status: string;
  revisionNo: number;
  parentCostingId: string | null;
  validityDays: number;
  paymentTermsOverride: string | null;
  accountPaymentTerms: string | null;
  signedByName: string | null;
  signedByTitle: string | null;
  updatedAt: string;
  canEdit: boolean;
};

type AuditEvent = {
  auditEventId: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeJson: unknown;
  afterJson: unknown;
  changedFields: string[] | null;
  reason: string | null;
  actorDisplayName: string | null;
  actorRole: string;
  occurredAt: string;
  requestId: string;
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
  updatedAt: string;
  needsRecalculation: boolean;
  latestUnitSellingPrice: number | null;
  latestOrderTotal: number | null;
};

type LineForm = {
  route: "TRADING" | "CUSTOM" | "";
  productFamily: string;
  description: string;
  gradeInput: string;
  threadCondition: string;
  sizeLabel: string;
  diameterMm: string;
  lengthMm: string;
  developedCutLengthMm: string;
  qty: string;
  leadTimeDays: string;
  coatingCode: string;
  diesOption: "" | "yes" | "no_lookup" | "manual";
  diesTotalCost: string;
  weightTolerancePercent: string;
  marginPercent: string;
  tradingItemId: string;
  /** Components only: how many of this part go into one set. */
  qtyPerSet: string;
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
  tradingItemsByCategory: Record<string, { tradingItemId: string; sizeLabel: string }[]>;
  threadConditionsByFamily: Record<string, string[]>;
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
  tradingItemsByCategory: {},
  threadConditionsByFamily: {},
  defaultWeightTolerancePercent: 0,
};

/** Sentinel for "not in the user directory" in the Salesperson picker. */
const SALESPERSON_OTHER = "__other__";

const EMPTY_FORM: LineForm = {
  route: "",
  productFamily: "",
  description: "",
  gradeInput: "",
  threadCondition: "",
  sizeLabel: "",
  diameterMm: "",
  lengthMm: "",
  developedCutLengthMm: "",
  qty: "1",
  leadTimeDays: "",
  coatingCode: "",
  diesOption: "",
  diesTotalCost: "",
  weightTolerancePercent: "",
  marginPercent: "",
  tradingItemId: "",
  qtyPerSet: "1",
};

function lineToForm(l: Line): LineForm {
  return {
    route: (l.route as "TRADING" | "CUSTOM" | null) ?? "",
    productFamily: l.productFamily ?? "",
    description: l.description ?? "",
    gradeInput: l.gradeInput ?? "",
    threadCondition: l.threadCondition ?? "",
    sizeLabel: l.sizeLabel ?? "",
    diameterMm: l.diameterMm?.toString() ?? "",
    lengthMm: l.lengthMm?.toString() ?? "",
    developedCutLengthMm: l.developedCutLengthMm?.toString() ?? "",
    qty: l.qty?.toString() ?? "1",
    leadTimeDays: l.leadTimeDays?.toString() ?? "",
    coatingCode: l.coatingCode ?? "",
    diesOption: l.diesOption ?? "",
    diesTotalCost: l.diesTotalCost?.toString() ?? "",
    weightTolerancePercent: l.weightTolerancePercent?.toString() ?? "",
    marginPercent: l.marginPercent?.toString() ?? "",
    tradingItemId: l.tradingItemId ?? "",
    qtyPerSet: l.qtyPerSet?.toString() ?? "1",
  };
}

/**
 * CBP's standard item description, used when the user leaves Description
 * blank so every quotation line reads consistently:
 *   Bolt — "Bolt, A193-B7, HT M20x80"
 *   Nut  — "Nut, A194-2H, M20"
 * Uses the grade's display label (A193-B7, not B7) so the quotation shows the
 * full standard designation. Returns "" for families with no agreed format,
 * leaving the existing "family + grade" fallback in the summary untouched.
 */
function defaultDescription(f: LineForm, gradeLabel: string): string {
  const grade = gradeLabel || f.gradeInput;
  const size = f.sizeLabel || (f.diameterMm ? `M${f.diameterMm}` : "");
  if (!f.productFamily || !grade || !size) return "";

  if (f.productFamily === "Bolt") {
    const thread = f.threadCondition ? `${f.threadCondition} ` : "";
    const length = f.lengthMm ? `x${f.lengthMm}` : "";
    return `${f.productFamily}, ${grade}, ${thread}${size}${length}`;
  }
  if (f.productFamily === "Nut") {
    return `${f.productFamily}, ${grade}, ${size}`;
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

  set("route", f.route);
  set("productFamily", f.productFamily);
  // A blank Description falls back to CBP's standard format rather than
  // staying empty, so the quotation never ships an unlabelled line.
  set("description", f.description || defaultDescription(f, gradeLabel));
  set("gradeInput", f.gradeInput);
  set("threadCondition", f.threadCondition);
  set("sizeLabel", f.sizeLabel);
  set("diameterMm", f.diameterMm, Number);
  set("lengthMm", f.lengthMm, Number);
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
  set("tradingItemId", f.tradingItemId);
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
  const [showAudit, setShowAudit] = useState(false);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [showExplanation, setShowExplanation] = useState(false);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [adminPanel, setAdminPanel] = useState<"closed" | "void" | "reassign">("closed");
  const [voidReason, setVoidReason] = useState("");
  const [reassignNewOwnerId, setReassignNewOwnerId] = useState("");
  const [reassignReason, setReassignReason] = useState("");
  const [preview, setPreview] = useState<{
    totalExPpn: number;
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
    const existing = customers.find((c) => c.customerName === costing.customerName);
    setCustomerSelected(existing?.customerId ?? "");
    setCustomerNewName("");
    setEditingCustomer(true);
  }

  async function saveCustomer() {
    const customerName =
      customerSelected === CUSTOMER_ADD_NEW
        ? customerNewName.trim()
        : (customers.find((c) => c.customerId === customerSelected)?.customerName ?? "");
    if (!customerName) {
      setError("Pilih atau masukkan nama customer.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiPatch(`/api/costings/${costing.costingId}`, { expectedUpdatedAt: costing.updatedAt, customerName });
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
    setForm({ ...EMPTY_FORM, route: "CUSTOM" });
    setPanel({ mode: "add", kind: "set" });
    setError(null);
  }

  function openAddComponentPanel(set: Line) {
    setForm({ ...EMPTY_FORM, route: "CUSTOM" });
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
      const kind = panel.kind ?? "item";
      if (panel.mode === "add") {
        await apiPost(`/api/costings/${costing.costingId}/lines`, {
          ...formToBody(form, "add", gradeLabel, kind),
          ...(kind === "component" ? { parentLineId: panel.parentLineId } : {}),
        });
      } else if (panel.mode === "edit" && panel.lineId) {
        const line = lines.find((l) => l.costingLineId === panel.lineId)!;
        await apiPatch(`/api/costings/${costing.costingId}/lines/${panel.lineId}`, {
          expectedUpdatedAt: line.updatedAt,
          ...formToBody(form, "edit", gradeLabel, kind),
        });
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

  async function loadAudit() {
    try {
      const data = await apiGet<{ events: AuditEvent[] }>(`/api/costings/${costing.costingId}/audit`);
      setAuditEvents(data.events);
      setShowAudit(true);
    } catch (e) {
      setError((e as ApiError).message ?? "Gagal memuat audit trail.");
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
  const availableTradingItems = form.productFamily ? (lookups.tradingItemsByCategory[form.productFamily] ?? []) : [];

  return (
    <div className="app-shell" style={{ maxWidth: 1220 }}>
      <div style={{ marginBottom: 16 }}>
        <a href="/dashboard" className="link-btn">
          &larr; Dashboard
        </a>
      </div>

      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">CBP</div>
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
            <SignatureField costing={costing} canEdit={canEdit && editableStatus} onSaved={refreshCosting} />
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
        <button onClick={loadPreview} className="btn secondary small">
          Preview
        </button>
        {lines.length > 0 && (
          <button onClick={openWaText} className="btn secondary small">
            Copy as WA Text
          </button>
        )}
        <button onClick={loadAudit} className="btn secondary small">
          Audit Trail
        </button>
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
                <th scope="col">Route</th>
                <th scope="col">Description</th>
                <th scope="col">Qty</th>
                <th scope="col">Lead Time</th>
                <th scope="col">Unit Price</th>
                <th scope="col">Order Total</th>
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
                        ) : l.route ? (
                          <span className="pill neutral">{l.route}</span>
                        ) : (
                          <span className="pill danger">belum dipilih</span>
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
                          (() => {
                            const distinctLeadTimes = [...new Set(components.map((c) => c.leadTimeDays))];
                            if (distinctLeadTimes.length === 0) return "—";
                            if (distinctLeadTimes.length === 1) return formatLeadTimeDays(distinctLeadTimes[0]);
                            return (
                              <span className="pill amber" title="Komponen dalam set ini punya lead time berbeda-beda">
                                campuran
                              </span>
                            );
                          })()
                        ) : (
                          formatLeadTimeDays(l.leadTimeDays)
                        )}
                      </td>
                      <td className="mono">{fmt(l.latestUnitSellingPrice)}</td>
                      <td className="mono">{fmt(l.latestOrderTotal)}</td>
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
                        <td>{actions(c, `component ${displayNo}.${ci + 1}`)}</td>
                      </tr>
                    ))}

                    {l.lineKind === "set" && (
                      <tr className="component-row">
                        <td />
                        <td colSpan={7} style={{ paddingLeft: 18 }}>
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
                  <td colSpan={8} className="empty-state">
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
                <input type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
              </label>
            </>
          )}

          {panelKind !== "set" && (
            <>
          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Route</span>
            <select
              value={form.route}
              onChange={(e) => setForm({ ...form, route: e.target.value as LineForm["route"] })}
            >
              <option value="">-- pilih --</option>
              <option value="CUSTOM">Custom Production</option>
              <option value="TRADING">Trading</option>
            </select>
          </label>

          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Product Family</span>
            <select
              value={form.productFamily}
              onChange={(e) => setForm({ ...form, productFamily: e.target.value, gradeInput: "", diameterMm: "" })}
            >
              <option value="">-- pilih --</option>
              {lookups.productFamilies.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>

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
            <span className="field-label">Description</span>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>

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

          {form.route === "CUSTOM" && (
            <>
              <label className="field" style={{ marginBottom: 12 }}>
                <span className="field-label">Length (mm) — finished length (Bolt/Stud)</span>
                <input
                  type="number"
                  value={form.lengthMm}
                  onChange={(e) => setForm({ ...form, lengthMm: e.target.value })}
                />
              </label>
              <label className="field" style={{ marginBottom: 12 }}>
                <span className="field-label">Developed cut length (mm) — Anchor only</span>
                <input
                  type="number"
                  value={form.developedCutLengthMm}
                  onChange={(e) => setForm({ ...form, developedCutLengthMm: e.target.value })}
                />
              </label>
              <label className="field" style={{ marginBottom: 12 }}>
                <span className="field-label">Lead time</span>
                {availableLeadTimes.length > 0 ? (
                  <select value={form.leadTimeDays} onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })}>
                    <option value="">-- pilih --</option>
                    {availableLeadTimes.map((b) => (
                      <option key={b.ruleId} value={b.value}>
                        {b.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="number"
                    value={form.leadTimeDays}
                    onChange={(e) => setForm({ ...form, leadTimeDays: e.target.value })}
                    placeholder="days"
                  />
                )}
              </label>
              <label className="field" style={{ marginBottom: 12 }}>
                <span className="field-label">Dies/Tooling tersedia?</span>
                <select
                  value={form.diesOption}
                  onChange={(e) => setForm({ ...form, diesOption: e.target.value as LineForm["diesOption"] })}
                >
                  <option value="">n/a</option>
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
            </>
          )}

          {form.route === "TRADING" && (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Trading item (pricelist) — leave blank to use a quote instead</span>
              {availableTradingItems.length > 0 ? (
                <select value={form.tradingItemId} onChange={(e) => setForm({ ...form, tradingItemId: e.target.value })}>
                  <option value="">— use trading quote instead —</option>
                  {availableTradingItems.map((t) => (
                    <option key={t.tradingItemId} value={t.tradingItemId}>
                      {form.productFamily} {t.sizeLabel}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={form.tradingItemId}
                  onChange={(e) => setForm({ ...form, tradingItemId: e.target.value })}
                  placeholder={form.productFamily ? "no pricelist items in active guide" : "pilih Product Family dulu"}
                />
              )}
            </label>
          )}

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

          {panelKind === "component" ? (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Qty per set</span>
              <input
                type="number"
                min={1}
                value={form.qtyPerSet}
                onChange={(e) => setForm({ ...form, qtyPerSet: e.target.value })}
              />
              <span className="hint">
                Berapa buah komponen ini dalam satu set. Jumlah yang diproduksi = angka ini x jumlah set, dan itulah
                yang dipakai untuk potongan kuantitas dan pembagian biaya dies.
              </span>
            </label>
          ) : (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Qty</span>
              <input type="number" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} />
            </label>
          )}

          {form.route === "TRADING" && (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Margin (0–0.999, e.g. 0.25)</span>
              <input
                type="number"
                step="0.01"
                value={form.marginPercent}
                onChange={(e) => setForm({ ...form, marginPercent: e.target.value })}
              />
            </label>
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
          <TicketTotal label="Total (excl. PPN)" value={fmt(preview.totalExPpn)} />
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

      {showAudit && (
        <Modal onClose={() => setShowAudit(false)} width={640} label="Audit Trail">
          <h2 style={{ marginBottom: 14 }}>Audit Trail</h2>
          {auditEvents.length === 0 && <p className="empty-state">No events yet.</p>}
          {auditEvents.map((ev) => (
            <div key={ev.auditEventId} style={{ borderBottom: "1px solid var(--surface-alt)", padding: "10px 0", fontSize: 13 }}>
              <div>
                <strong>{ev.action}</strong>{" "}
                <span style={{ color: "var(--ink-soft)" }}>
                  · {ev.entityType} · {new Date(ev.occurredAt).toLocaleString()}
                </span>
              </div>
              <div style={{ color: "var(--ink-soft)" }}>
                {ev.actorDisplayName ?? "system"} ({ev.actorRole})
                {ev.reason && <> — {ev.reason}</>}
              </div>
              {ev.changedFields && ev.changedFields.length > 0 && (
                <div style={{ color: "var(--ink-soft)", fontSize: 12 }}>Changed: {ev.changedFields.join(", ")}</div>
              )}
            </div>
          ))}
          <button onClick={() => setShowAudit(false)} className="btn secondary small" style={{ marginTop: 14 }}>
            Close
          </button>
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
  const effective = costing.paymentTermsOverride ?? accountTerms;

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
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={accountTerms ?? "mis. 30 hari setelah invoice"}
          aria-label="Termin pembayaran khusus quotation ini"
          style={{ minWidth: 240 }}
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
      Termin: {effective ?? <em style={{ color: "var(--ink-soft)" }}>belum diatur</em>}
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
 * The salesperson whose name appears under "Melayani Sepenuh Hati" on the
 * quotation. Defaults to the costing owner, since the person pricing it
 * usually is the sender — but a quotation often goes out over a colleague's
 * name, so name and jabatan are both set per quotation.
 */
function SignatureField({
  costing,
  canEdit,
  onSaved,
}: {
  costing: Costing;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [freeText, setFreeText] = useState(false);
  const [busy, setBusy] = useState(false);
  const [users, setUsers] = useState<{ userId: string; displayName: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiGet<{ users: { userId: string; displayName: string }[] }>("/api/users");
        if (!cancelled) setUsers(data.users);
      } catch {
        // The picker degrades to the free-text box; tagging must not be blocked
        // by a directory that failed to load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    setBusy(true);
    try {
      await apiPatch(`/api/costings/${costing.costingId}`, {
        expectedUpdatedAt: costing.updatedAt,
        signedByName: name.trim() || null,
        signedByTitle: title.trim() || null,
      });
      setEditing(false);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    // A registered colleague is picked from the list so the name is spelled
    // identically every time and the Salesperson report groups cleanly;
    // "Lainnya…" still allows someone without an app account.
    const known = users.some((u) => u.displayName === name);
    return (
      <p style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <select
          value={freeText || (name && !known) ? SALESPERSON_OTHER : name}
          onChange={(e) => {
            if (e.target.value === SALESPERSON_OTHER) {
              setFreeText(true);
              setName("");
            } else {
              setFreeText(false);
              setName(e.target.value);
            }
          }}
          aria-label="Salesperson yang menangani quotation ini"
          style={{ minWidth: 180 }}
        >
          <option value="">— pemilik costing —</option>
          {users.map((u) => (
            <option key={u.userId} value={u.displayName}>
              {u.displayName}
            </option>
          ))}
          <option value={SALESPERSON_OTHER}>Lainnya…</option>
        </select>
        {(freeText || (name && !known)) && (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nama salesperson"
            aria-label="Nama salesperson lainnya"
            style={{ minWidth: 160 }}
          />
        )}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Jabatan (opsional)"
          aria-label="Jabatan salesperson"
          style={{ minWidth: 150 }}
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
      Salesperson:{" "}
      {costing.signedByName ? (
        <>
          {costing.signedByName}
          {costing.signedByTitle && <span style={{ color: "var(--ink-soft)" }}> · {costing.signedByTitle}</span>}
        </>
      ) : (
        <em style={{ color: "var(--ink-soft)" }}>pemilik costing</em>
      )}
      {canEdit && (
        <button
          onClick={() => {
            setName(costing.signedByName ?? "");
            setTitle(costing.signedByTitle ?? "");
            setFreeText(false);
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
