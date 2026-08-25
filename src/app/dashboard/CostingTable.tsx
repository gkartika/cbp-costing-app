"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusPill, AccessPill } from "@/components/Pills";
import { Modal } from "@/components/Modal";

export type DashboardCosting = {
  costingId: string;
  quotationNo: string | null;
  customerName: string;
  status: string;
  isPo: boolean;
  poNumber: string | null;
  ownerName: string;
  isOwnedByMe: boolean;
  /**
   * Pre-formatted on the server. Formatting a Date inside this client
   * component made the SSR pass use the server's timezone and the hydration
   * pass the browser's, which React reports as a hydration mismatch — and
   * 04_DATA_MODEL specifies Asia/Jakarta as the display zone regardless of
   * where either happens to run.
   */
  createdAtLabel: string;
  totalNominal: number | null;
  canEdit: boolean;
  canDelete: boolean;
  canMarkPo: boolean;
};

function fmtMoney(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

export function CostingTable({ costings }: { costings: DashboardCosting[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState(costings);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Marking a PO opens a dialog for the customer's PO number; that entry is
  // both the data we need and the deliberate confirmation step.
  const [poPrompt, setPoPrompt] = useState<{ costing: DashboardCosting; value: string } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    // Customer and quotation number only — the two identifiers a user actually
    // has to hand when hunting for a past quote.
    return rows.filter(
      (c) =>
        c.customerName.toLowerCase().includes(q) || (c.quotationNo ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  /**
   * Not optimistic, unlike a plain toggle: recording a won deal is a
   * consequential claim, so the checkbox only moves once the server has
   * accepted it along with the PO number.
   */
  async function submitPo(c: DashboardCosting, next: boolean, poNumber?: string) {
    setBusyId(c.costingId);
    setError(null);
    try {
      const res = await fetch(`/api/costings/${c.costingId}/po`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next ? { isPo: true, poNumber } : { isPo: false }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error?.message ?? "Gagal memperbarui status PO.");
      setRows((prev) =>
        prev.map((r) => (r.costingId === c.costingId ? { ...r, isPo: body.isPo, poNumber: body.poNumber ?? null } : r)),
      );
      setPoPrompt(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memperbarui status PO.");
    } finally {
      setBusyId(null);
    }
  }

  function onPoCheckboxChange(c: DashboardCosting, next: boolean) {
    if (next) {
      setPoPrompt({ costing: c, value: "" });
      return;
    }
    if (confirm(`Batalkan status PO untuk ${c.customerName || "costing ini"}? Nomor PO ${c.poNumber ?? ""} akan dihapus.`)) {
      void submitPo(c, false);
    }
  }

  async function remove(c: DashboardCosting) {
    const label = c.customerName || "costing ini";
    if (!confirm(`Hapus ${label}? Item yang sudah difinalisasi tidak dapat dihapus.`)) return;
    setBusyId(c.costingId);
    setError(null);
    try {
      const res = await fetch(`/api/costings/${c.costingId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? "Gagal menghapus costing.");
      }
      setRows((prev) => prev.filter((r) => r.costingId !== c.costingId));
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menghapus costing.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 12 }}>
        <label className="field" style={{ flex: 1, marginBottom: 0 }}>
          <span className="sr-only">Cari costing</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari customer atau quotation no…"
            aria-label="Cari berdasarkan customer atau quotation no"
          />
        </label>
        <span style={{ fontSize: 12.5, color: "var(--ink-soft)", whiteSpace: "nowrap" }}>
          {filtered.length} dari {rows.length}
        </span>
      </div>

      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Created</th>
              <th scope="col">Customer</th>
              <th scope="col">Quotation No</th>
              <th scope="col">Status</th>
              <th scope="col">User</th>
              <th scope="col">Total Quotation</th>
              <th scope="col">PO</th>
              <th scope="col">Access</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr key={c.costingId}>
                <td className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                  {c.createdAtLabel}
                </td>
                <td>
                  <a href={`/costings/${c.costingId}`} style={{ color: "var(--steel)", fontWeight: 600 }}>
                    {c.customerName || (
                      <em style={{ color: "var(--ink-soft)", fontWeight: 400 }}>belum ada customer</em>
                    )}
                  </a>
                </td>
                <td className="mono">{c.quotationNo ?? "—"}</td>
                <td>
                  <StatusPill status={c.status} />
                </td>
                <td>{c.isOwnedByMe ? "You" : c.ownerName}</td>
                <td className="mono" style={{ textAlign: "right" }}>
                  {fmtMoney(c.totalNominal)}
                </td>
                <td style={{ textAlign: "center", whiteSpace: "nowrap" }}>
                  <input
                    type="checkbox"
                    checked={c.isPo}
                    disabled={!c.canMarkPo || busyId === c.costingId}
                    onChange={(e) => onPoCheckboxChange(c, e.target.checked)}
                    aria-label={`Tandai ${c.customerName || "costing"} ${c.quotationNo ?? ""} sebagai PO`}
                  />
                  {c.isPo && c.poNumber && (
                    <div className="mono" style={{ fontSize: 11, color: "var(--ink-soft)" }} title={`No. PO: ${c.poNumber}`}>
                      {c.poNumber}
                    </div>
                  )}
                </td>
                <td>
                  <AccessPill canEdit={c.canEdit} />
                </td>
                <td>
                  {c.canDelete && (
                    <button
                      onClick={() => remove(c)}
                      disabled={busyId === c.costingId}
                      className="icon-btn"
                      aria-label={`Hapus ${c.customerName || "costing"}`}
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="empty-state">
                  {rows.length === 0 ? "No costings yet." : "Tidak ada hasil untuk pencarian ini."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {poPrompt && (
        <Modal onClose={() => setPoPrompt(null)} width={440} label="Konfirmasi nomor PO">
          <h2 style={{ marginBottom: 6 }}>Tandai sebagai PO</h2>
          <p style={{ fontSize: 13, color: "var(--ink-soft)", marginBottom: 14 }}>
            {poPrompt.costing.customerName || "Costing ini"}
            {poPrompt.costing.quotationNo ? ` · ${poPrompt.costing.quotationNo}` : ""}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = poPrompt.value.trim();
              if (!v) return;
              void submitPo(poPrompt.costing, true, v);
            }}
          >
            <label className="field" style={{ marginBottom: 14 }}>
              <span className="field-label">Nomor PO dari customer</span>
              <input
                value={poPrompt.value}
                onChange={(e) => setPoPrompt({ ...poPrompt, value: e.target.value })}
                placeholder="mis. PO/2026/00123"
                required
                maxLength={100}
              />
            </label>
            {error && (
              <p className="error-note" role="alert">
                {error}
              </p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn" disabled={!poPrompt.value.trim() || busyId === poPrompt.costing.costingId}>
                Simpan
              </button>
              <button type="button" className="btn secondary" onClick={() => setPoPrompt(null)}>
                Batal
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
