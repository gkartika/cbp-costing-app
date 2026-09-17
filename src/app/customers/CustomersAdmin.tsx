"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_PAYMENT_TERMS } from "@/lib/costings/paymentTerms";

const SEGMENTS = ["Distributor", "Fabricator", "Subcontractor", "End User"] as const;

type Customer = {
  customerId: string;
  customerName: string;
  customerCode: string | null;
  segment: (typeof SEGMENTS)[number] | null;
  markupPercent: number | null;
  paymentTerms: string | null;
};

type EditForm = {
  customerName: string;
  customerCode: string;
  segment: string;
  markupPercent: string;
  paymentTerms: string;
};

type ImportOutcome = { row: number; customerName: string; outcome: "created" | "updated" | "error"; message?: string };

const CSV_COLUMNS = ["customerName", "customerCode", "segment", "markupPercent", "paymentTerms"] as const;

/** Minimal RFC4180 parser: quoted fields, embedded commas, "" as an escaped quote. Good enough for a pasted customer masterlist without pulling in a CSV library. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/** Header-aware: matches columns by name (case-insensitive), so column order in the pasted file doesn't matter. */
function csvToRows(text: string): Record<string, string>[] {
  const table = parseCsv(text);
  if (table.length === 0) return [];
  const header = table[0].map((h) => h.trim().toLowerCase());
  return table.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    CSV_COLUMNS.forEach((col) => {
      const idx = header.indexOf(col.toLowerCase());
      record[col] = idx >= 0 ? (cells[idx] ?? "").trim() : "";
    });
    return record;
  });
}

function toEditForm(c: Customer): EditForm {
  return {
    customerName: c.customerName,
    customerCode: c.customerCode ?? "",
    segment: c.segment ?? "",
    // Stored as a fraction (0.05 = +5%) throughout the calc engine; shown to
    // the user as a plain percent so "5" means "5%", not "500%".
    markupPercent: c.markupPercent !== null ? (c.markupPercent * 100).toString() : "",
    paymentTerms: c.paymentTerms ?? "",
  };
}

export function CustomersAdmin({
  initialCustomers,
  isSuperAdmin,
  canEditCustomer,
}: {
  initialCustomers: Customer[];
  isSuperAdmin: boolean;
  canEditCustomer: boolean;
}) {
  const router = useRouter();
  const [customers, setCustomers] = useState(initialCustomers);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResults, setImportResults] = useState<ImportOutcome[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [fileImportBusy, setFileImportBusy] = useState(false);
  const [fileImportMsg, setFileImportMsg] = useState<string | null>(null);
  const [fileImportError, setFileImportError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/customers");
    if (res.ok) setCustomers((await res.json()).customers);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerName: newName.trim(), customerCode: newCode.trim() || undefined }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Gagal menambah customer.");
      setNewName("");
      setNewCode("");
      await refresh();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menambah customer.");
    } finally {
      setBusy(false);
    }
  }

  function openEdit(c: Customer) {
    setEditingId(c.customerId);
    setForm(toEditForm(c));
    setError(null);
  }

  async function saveEdit() {
    if (!editingId || !form) return;
    setBusy(true);
    setError(null);
    try {
      const markup = form.markupPercent.trim() === "" ? null : Number(form.markupPercent) / 100;
      const res = await fetch(`/api/customers/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName: form.customerName.trim(),
          customerCode: form.customerCode.trim() || null,
          segment: form.segment || null,
          markupPercent: markup,
          paymentTerms: form.paymentTerms.trim() || null,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Gagal menyimpan customer.");
      setEditingId(null);
      setForm(null);
      await refresh();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan customer.");
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkImport() {
    setImportBusy(true);
    setImportError(null);
    setImportResults(null);
    try {
      const parsed = csvToRows(importText);
      if (parsed.length === 0) throw new Error("Tidak ada baris data untuk diimpor.");

      const clientErrors: ImportOutcome[] = [];
      const validRows: { rowNo: number; customerName: string; customerCode?: string; segment?: string; markupPercent?: number; paymentTerms?: string }[] = [];

      parsed.forEach((r, idx) => {
        const rowNo = idx + 1;
        const customerName = r.customerName.trim();
        if (!customerName) {
          clientErrors.push({ row: rowNo, customerName: "", outcome: "error", message: "Nama customer wajib diisi." });
          return;
        }
        if (r.segment && !SEGMENTS.includes(r.segment as (typeof SEGMENTS)[number])) {
          clientErrors.push({ row: rowNo, customerName, outcome: "error", message: `Segmen tidak dikenal: "${r.segment}".` });
          return;
        }
        let markupPercent: number | undefined;
        if (r.markupPercent) {
          const raw = Number(r.markupPercent);
          if (Number.isNaN(raw) || raw <= -100) {
            clientErrors.push({ row: rowNo, customerName, outcome: "error", message: "Kenaikan harga tidak valid." });
            return;
          }
          markupPercent = raw / 100;
        }
        validRows.push({
          rowNo,
          customerName,
          customerCode: r.customerCode || undefined,
          segment: r.segment || undefined,
          markupPercent,
          paymentTerms: r.paymentTerms || undefined,
        });
      });

      let serverResults: ImportOutcome[] = [];
      if (validRows.length > 0) {
        const res = await fetch("/api/customers/bulk-import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: validRows.map(({ rowNo: _rowNo, ...row }) => row) }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error?.message ?? "Gagal mengimpor customer.");
        serverResults = (body.results as ImportOutcome[]).map((r, i) => ({ ...r, row: validRows[i].rowNo }));
      }

      setImportResults([...clientErrors, ...serverResults].sort((a, b) => a.row - b.row));
      await refresh();
      router.refresh();
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "Gagal mengimpor customer.");
    } finally {
      setImportBusy(false);
    }
  }

  async function handleBulkImportFile(file: File) {
    setFileImportBusy(true);
    setFileImportError(null);
    setFileImportMsg(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/customers/import-xlsx", { method: "POST", body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Import gagal.");
      const skipped = (body.skipped as { row: number; reason: string }[]) ?? [];
      setFileImportMsg(
        `${body.summary.created} baru, ${body.summary.updated} diperbarui` +
          (body.summary.errors > 0 ? `, ${body.summary.errors} gagal: ${skipped.map((s) => `baris ${s.row} (${s.reason})`).join("; ")}` : "."),
      );
      await refresh();
      router.refresh();
    } catch (e) {
      setFileImportError(e instanceof Error ? e.message : "Import gagal.");
    } finally {
      setFileImportBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <div style={{ marginBottom: 16 }}>
        <a href="/dashboard" className="link-btn">
          &larr; Dashboard
        </a>
      </div>

      <header className="app-header">
        <div className="brand">
          <img src="/brand/cbp-logomark.png" alt="CBP" className="brand-mark" />
          <div className="brand-text">
            <h1>Customers</h1>
            <p>Nama tampil di quotation; segmen, kenaikan harga dan termin hanya untuk internal</p>
          </div>
        </div>
      </header>

      <div className="card">
        <h2>Tambah Customer</h2>
        <form onSubmit={handleCreate}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field" style={{ minWidth: 220 }}>
              <span className="field-label">Nama Customer</span>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} required placeholder="mis. PT Contoh Sejahtera" />
            </label>
            <label className="field" style={{ minWidth: 160 }}>
              <span className="field-label">Kode (opsional)</span>
              <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="mis. CS-001" />
            </label>
            <button type="submit" disabled={busy || !newName.trim()} className="btn" style={{ marginBottom: 12 }}>
              {busy ? "Menyimpan…" : "Tambah"}
            </button>
          </div>
        </form>
        <p className="hint" style={{ marginTop: 0 }}>
          Siapa pun bisa menambah customer baru. Segmen, kenaikan harga dan termin pembayaran hanya bisa diisi/diubah
          oleh Costing Head atau Super Admin lewat tombol Edit di bawah.
        </p>
        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}
      </div>

      {canEditCustomer && (
        <div className="card">
          <div className="section-actions">
            <h2 style={{ marginBottom: 0 }}>Export / Bulk Import (.xlsx)</h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {isSuperAdmin && (
                <a className="btn secondary small" href="/api/customers/export-xlsx" download="Customers.xlsx">
                  Export (.xlsx)
                </a>
              )}
              <label className="btn secondary small" style={{ cursor: "pointer", margin: 0 }}>
                Bulk import (.xlsx)
                <input
                  type="file"
                  accept=".xlsx"
                  style={{ display: "none" }}
                  disabled={fileImportBusy}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleBulkImportFile(file);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          </div>
          <p className="helptext">
            Export mengunduh semua customer aktif persis dalam format yang bisa diedit di Excel lalu diunggah kembali
            lewat Bulk import — cocok untuk mengubah banyak data sekaligus tanpa edit satu-satu di web. Customer yang
            sudah ada dicocokkan lewat Nama Customer; kolom kosong tidak menimpa nilai yang sudah tersimpan.
          </p>
          {fileImportError && (
            <p className="error-note" role="alert">
              {fileImportError}
            </p>
          )}
          {fileImportMsg && <p className="helptext">{fileImportMsg}</p>}
        </div>
      )}

      {canEditCustomer && (
        <div className="card">
          <h2>Bulk Import Customer</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            Tempel data CSV dengan header <code>customerName,customerCode,segment,markupPercent,paymentTerms</code>.
            Hanya <code>customerName</code> yang wajib; kolom lain boleh kosong. <code>segment</code> harus salah satu
            dari {SEGMENTS.join(", ")}. <code>markupPercent</code> ditulis sebagai persen biasa (mis. 5 untuk +5%,
            bukan 0.05). Nama yang sudah ada akan diperbarui memakai kolom yang diisi — kolom kosong tidak menimpa
            nilai yang sudah tersimpan.
          </p>
          <textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 13 }}
            placeholder={"customerName,customerCode,segment,markupPercent,paymentTerms\nPT Contoh Sejahtera,CS-001,Distributor,5,NET 30"}
          />
          <div style={{ marginTop: 8 }}>
            <button onClick={handleBulkImport} disabled={importBusy || !importText.trim()} className="btn">
              {importBusy ? "Mengimpor…" : "Import"}
            </button>
          </div>
          {importError && (
            <p className="error-note" role="alert">
              {importError}
            </p>
          )}
          {importResults && (
            <div style={{ marginTop: 12 }}>
              <p style={{ margin: "0 0 8px" }}>
                Selesai: {importResults.filter((r) => r.outcome === "created").length} baru,{" "}
                {importResults.filter((r) => r.outcome === "updated").length} diperbarui,{" "}
                {importResults.filter((r) => r.outcome === "error").length} gagal.
              </p>
              {importResults.some((r) => r.outcome === "error") && (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Baris</th>
                        <th scope="col">Nama</th>
                        <th scope="col">Masalah</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importResults
                        .filter((r) => r.outcome === "error")
                        .map((r) => (
                          <tr key={r.row}>
                            <td className="mono">{r.row}</td>
                            <td>{r.customerName || "—"}</td>
                            <td>{r.message}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Semua Customer</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Nama</th>
                <th scope="col">Kode</th>
                <th scope="col">Segmen</th>
                <th scope="col">Kenaikan Harga</th>
                <th scope="col">Termin Pembayaran</th>
                {canEditCustomer && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {customers.map((c) =>
                editingId === c.customerId && form ? (
                  <tr key={c.customerId}>
                    <td>
                      <input
                        value={form.customerName}
                        onChange={(e) => setForm({ ...form, customerName: e.target.value })}
                        style={{ minWidth: 160 }}
                      />
                    </td>
                    <td>
                      <input
                        value={form.customerCode}
                        onChange={(e) => setForm({ ...form, customerCode: e.target.value })}
                        style={{ width: 90 }}
                      />
                    </td>
                    <td>
                      <select value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })}>
                        <option value="">— belum diatur —</option>
                        {SEGMENTS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.1"
                        value={form.markupPercent}
                        onChange={(e) => setForm({ ...form, markupPercent: e.target.value })}
                        placeholder="0"
                        style={{ width: 70 }}
                      />
                      %
                    </td>
                    <td>
                      <input
                        value={form.paymentTerms}
                        onChange={(e) => setForm({ ...form, paymentTerms: e.target.value })}
                        placeholder="mis. NET 30"
                        style={{ minWidth: 140 }}
                      />
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button onClick={saveEdit} disabled={busy} className="btn small">
                          Save
                        </button>
                        <button
                          onClick={() => {
                            setEditingId(null);
                            setForm(null);
                          }}
                          disabled={busy}
                          className="btn secondary small"
                        >
                          Cancel
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={c.customerId}>
                    <td>{c.customerName}</td>
                    <td className="mono">{c.customerCode ?? "—"}</td>
                    <td>{c.segment ? <span className="pill neutral">{c.segment}</span> : "—"}</td>
                    <td className="mono">{c.markupPercent !== null ? `+${(c.markupPercent * 100).toFixed(1)}%` : "—"}</td>
                    <td>
                      {c.paymentTerms ?? (
                        <em style={{ color: "var(--ink-soft)" }} title="Default — belum diatur khusus">
                          {DEFAULT_PAYMENT_TERMS}
                        </em>
                      )}
                    </td>
                    {canEditCustomer && (
                      <td>
                        <button onClick={() => openEdit(c)} className="btn secondary small">
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ),
              )}
              {customers.length === 0 && (
                <tr>
                  <td colSpan={canEditCustomer ? 6 : 5} className="empty-state">
                    Belum ada customer.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
