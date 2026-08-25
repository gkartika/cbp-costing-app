"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusPill, AccessPill } from "@/components/Pills";

export type DashboardCosting = {
  costingId: string;
  quotationNo: string | null;
  customerName: string;
  status: string;
  isPo: boolean;
  ownerName: string;
  isOwnedByMe: boolean;
  createdAt: string;
  updatedAt: string;
  totalNominal: number | null;
  canEdit: boolean;
  canDelete: boolean;
  canMarkPo: boolean;
};

function fmtMoney(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function CostingTable({ costings }: { costings: DashboardCosting[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState(costings);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function togglePo(c: DashboardCosting, next: boolean) {
    setBusyId(c.costingId);
    setError(null);
    // Optimistic: the checkbox should feel instant, and a failure rolls it back.
    setRows((prev) => prev.map((r) => (r.costingId === c.costingId ? { ...r, isPo: next } : r)));
    try {
      const res = await fetch(`/api/costings/${c.costingId}/po`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isPo: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message ?? "Gagal memperbarui status PO.");
      }
    } catch (e) {
      setRows((prev) => prev.map((r) => (r.costingId === c.costingId ? { ...r, isPo: !next } : r)));
      setError(e instanceof Error ? e.message : "Gagal memperbarui status PO.");
    } finally {
      setBusyId(null);
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
              <th scope="col">Updated</th>
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
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {fmtDate(c.createdAt)}
                </td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {fmtDate(c.updatedAt)}
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
                <td style={{ textAlign: "center" }}>
                  <input
                    type="checkbox"
                    checked={c.isPo}
                    disabled={!c.canMarkPo || busyId === c.costingId}
                    onChange={(e) => togglePo(c, e.target.checked)}
                    aria-label={`Tandai ${c.customerName || "costing"} ${c.quotationNo ?? ""} sebagai PO`}
                  />
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
                <td colSpan={10} className="empty-state">
                  {rows.length === 0 ? "No costings yet." : "Tidak ada hasil untuk pencarian ini."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
