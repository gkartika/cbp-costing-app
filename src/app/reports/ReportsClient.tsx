"use client";

import { useEffect, useState } from "react";
import { StatusPill } from "@/components/Pills";
import type { ReportResult } from "@/lib/reports/buildReport";

const STATUSES = ["draft", "calculated", "finalized", "revised", "voided"] as const;

/** Issued quotations only — drafts are internal work in progress and would inflate the totals. */
const DEFAULT_STATUSES = ["finalized", "revised"];

function money(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("en-US");
}

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(new Date(iso));
}

export function ReportsClient() {
  const [customer, setCustomer] = useState("");
  const [salesperson, setSalesperson] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [statuses, setStatuses] = useState<string[]>(DEFAULT_STATUSES);
  const [po, setPo] = useState<"all" | "po" | "no_po">("all");
  const [tab, setTab] = useState<"summary" | "lines">("summary");

  const [customerOptions, setCustomerOptions] = useState<string[]>([]);
  const [salespersonOptions, setSalespersonOptions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [customersRes, usersRes] = await Promise.all([fetch("/api/customers"), fetch("/api/users")]);
        if (cancelled) return;
        if (customersRes.ok) {
          const body = (await customersRes.json()) as { customers: { customerName: string }[] };
          setCustomerOptions(body.customers.map((c) => c.customerName).sort());
        }
        if (usersRes.ok) {
          const body = (await usersRes.json()) as { users: { displayName: string }[] };
          setSalespersonOptions(body.users.map((u) => u.displayName).sort());
        }
      } catch {
        // Filters still work as free-form values below if the pickers fail to load.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [result, setResult] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function queryString(): string {
    const p = new URLSearchParams();
    if (customer.trim()) p.set("customer", customer.trim());
    if (salesperson.trim()) p.set("salesperson", salesperson.trim());
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    statuses.forEach((s) => p.append("status", s));
    if (po !== "all") p.set("po", po);
    return p.toString();
  }

  async function fetchReport(qs: string): Promise<ReportResult> {
    const res = await fetch(`/api/reports?${qs}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error?.message ?? "Gagal memuat laporan.");
    return body as ReportResult;
  }

  async function run() {
    setLoading(true);
    setError(null);
    try {
      setResult(await fetchReport(queryString()));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal memuat laporan.");
    } finally {
      setLoading(false);
    }
  }

  // Load once on mount with the default filters so the page is never blank.
  // State is only set after the await, never synchronously in the effect body.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchReport(new URLSearchParams(DEFAULT_STATUSES.map((s) => ["status", s])).toString());
        if (!cancelled) setResult(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Gagal memuat laporan.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleStatus(s: string) {
    setStatuses((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  return (
    <>
      <div className="card">
        <h2>Filter</h2>
        <div className="field-row" style={{ alignItems: "end" }}>
          <label className="field">
            <span className="field-label">Customer</span>
            <select value={customer} onChange={(e) => setCustomer(e.target.value)}>
              <option value="">Semua customer</option>
              {customerOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Salesperson</span>
            <select value={salesperson} onChange={(e) => setSalesperson(e.target.value)}>
              <option value="">Semua salesperson</option>
              {salespersonOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row" style={{ alignItems: "end" }}>
          <label className="field">
            <span className="field-label">Dari tanggal</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Sampai tanggal</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>

        <fieldset style={{ border: 0, padding: 0, margin: "0 0 12px" }}>
          <legend className="field-label" style={{ padding: 0 }}>
            Status
          </legend>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            {STATUSES.map((s) => (
              <label key={s} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 13 }}>
                <input type="checkbox" checked={statuses.includes(s)} onChange={() => toggleStatus(s)} />
                {s}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="field" style={{ maxWidth: 260, marginBottom: 12 }}>
          <span className="field-label">Status PO</span>
          <select value={po} onChange={(e) => setPo(e.target.value as typeof po)}>
            <option value="all">Semua</option>
            <option value="po">Hanya yang sudah PO</option>
            <option value="no_po">Hanya yang belum PO</option>
          </select>
        </label>

        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={run} className="btn" disabled={loading}>
            {loading ? "Memuat…" : "Tampilkan"}
          </button>
          <a
            href={`/api/reports/export?${queryString()}`}
            className="btn secondary"
            aria-disabled={!result || result.totals.costingCount === 0}
          >
            Download XLSX
          </a>
        </div>
      </div>

      {result && (
        <div className="card">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 22, marginBottom: 16 }}>
            <Stat label="Quotation" value={result.totals.costingCount.toLocaleString("en-US")} />
            <Stat label="Sudah PO" value={result.totals.poCount.toLocaleString("en-US")} />
            <Stat label="Total nilai" value={money(result.totals.grandTotal)} />
            <Stat label="Nilai PO" value={money(result.totals.poTotal)} />
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button
              className={tab === "summary" ? "btn" : "btn secondary"}
              onClick={() => setTab("summary")}
              aria-pressed={tab === "summary"}
            >
              Summary ({result.summary.length})
            </button>
            <button
              className={tab === "lines" ? "btn" : "btn secondary"}
              onClick={() => setTab("lines")}
              aria-pressed={tab === "lines"}
            >
              Line Detail ({result.lines.length})
            </button>
          </div>

          <div className="table-scroll">
            {tab === "summary" ? (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Tanggal</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Quotation No</th>
                    <th scope="col">Status</th>
                    <th scope="col">Salesperson</th>
                    <th scope="col">Total Quotation</th>
                    <th scope="col">PO</th>
                  </tr>
                </thead>
                <tbody>
                  {result.summary.map((s) => (
                    <tr key={s.costingId}>
                      <td className="mono" style={{ whiteSpace: "nowrap" }}>
                        {fmtDate(s.createdAt)}
                      </td>
                      <td>
                        <a href={`/costings/${s.costingId}`} style={{ color: "var(--steel)", fontWeight: 600 }}>
                          {s.customerName || "—"}
                        </a>
                      </td>
                      <td className="mono">{s.quotationNo ?? "—"}</td>
                      <td>
                        <StatusPill status={s.status} />
                      </td>
                      <td>{s.salesperson}</td>
                      <td className="mono" style={{ textAlign: "right" }}>
                        {money(s.totalNominal)}
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {s.isPo ? (s.poNumber ?? "Ya") : "—"}
                      </td>
                    </tr>
                  ))}
                  {result.summary.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty-state">
                        Tidak ada data untuk filter ini.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Quotation No</th>
                    <th scope="col">Customer</th>
                    <th scope="col">#</th>
                    <th scope="col">Deskripsi</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Harga Satuan</th>
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {result.lines.map((l) => (
                    <tr key={`${l.costingId}-${l.lineNo}`}>
                      <td className="mono">{l.quotationNo ?? "—"}</td>
                      <td>{l.customerName || "—"}</td>
                      <td className="mono">{l.lineNo}</td>
                      <td>{l.description || `${l.productFamily ?? ""} ${l.gradeInput ?? ""}`.trim() || "—"}</td>
                      <td className="mono" style={{ textAlign: "right" }}>
                        {l.qty ?? "—"}
                      </td>
                      <td className="mono" style={{ textAlign: "right" }}>
                        {money(l.unitSellingPrice)}
                      </td>
                      <td className="mono" style={{ textAlign: "right" }}>
                        {money(l.orderTotal)}
                      </td>
                    </tr>
                  ))}
                  {result.lines.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty-state">
                        Tidak ada item untuk filter ini.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 19, fontWeight: 600 }}>
        {value}
      </div>
    </div>
  );
}
