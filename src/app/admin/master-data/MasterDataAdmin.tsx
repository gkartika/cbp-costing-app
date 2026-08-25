"use client";

import { useEffect, useMemo, useState } from "react";

type ColumnMeta = {
  header: string;
  dbColumn: string;
  type: "string" | "number" | "boolean" | "reference";
  required: boolean;
  refTab?: string;
};

type TableMeta = {
  table: string;
  tabName: string;
  keyHeader: string;
  uniqueBusinessKey: string[] | null;
  columns: ColumnMeta[];
};

type PendingChange = {
  pendingChangeId: string;
  tableName: string;
  operation: "create" | "update" | "deactivate";
  sourceKey: string;
  fields: Record<string, unknown> | null;
  reason: string | null;
  status: string;
  createdBy: string;
  createdAt: string;
};

type ValidationReport = {
  formulaErrors: string[];
  rangeErrors: string[];
  duplicateKeyErrors: string[];
  rawBarErrors: string[];
  regressionFailures: string[];
  simulationCasesRun: number;
};

async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<{ ok: boolean; data: T }> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

export function MasterDataAdmin() {
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [selectedTable, setSelectedTable] = useState<string>("");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [pending, setPending] = useState<PendingChange[]>([]);
  const [editing, setEditing] = useState<{ mode: "add" | "edit"; sourceKey?: string } | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const activeTableMeta = useMemo(() => tables.find((t) => t.table === selectedTable), [tables, selectedTable]);

  useEffect(() => {
    api<{ tables: TableMeta[] }>("/api/master-data/tables").then(({ data }) => {
      setTables(data.tables ?? []);
      if (data.tables?.length) setSelectedTable(data.tables[0].table);
    });
  }, []);

  async function loadTableData(table: string) {
    setError(null);
    setReport(null);
    setImportMsg(null);
    const [rowsRes, pendingRes] = await Promise.all([
      api<{ guideVersionId: string | null; rows: Record<string, unknown>[] }>(`/api/master-data/${table}`),
      api<{ changes: PendingChange[] }>(`/api/master-data/${table}/pending`),
    ]);
    setRows(rowsRes.data.rows ?? []);
    setPending(pendingRes.data.changes ?? []);
  }

  useEffect(() => {
    if (selectedTable) loadTableData(selectedTable);
    setEditing(null);
  }, [selectedTable]);

  function openAdd() {
    setForm({});
    setEditing({ mode: "add" });
    setReason("");
    setError(null);
  }

  function openEdit(row: Record<string, unknown>) {
    const initial: Record<string, string> = {};
    for (const col of activeTableMeta?.columns ?? []) {
      const v = row[col.dbColumn];
      initial[col.dbColumn] = v === null || v === undefined ? "" : String(v);
    }
    setForm(initial);
    setEditing({ mode: "edit", sourceKey: row.source_key as string });
    setReason("");
    setError(null);
  }

  async function submitChange() {
    if (!activeTableMeta || !editing) return;
    setBusy(true);
    setError(null);
    try {
      const fields: Record<string, unknown> = {};
      for (const col of activeTableMeta.columns) {
        const raw = form[col.dbColumn] ?? "";
        if (raw === "") {
          if (col.required) {
            throw new Error(`${col.header} wajib diisi.`);
          }
          continue;
        }
        fields[col.dbColumn] = col.type === "number" ? Number(raw) : col.type === "boolean" ? raw === "true" : raw;
      }

      const sourceKey = editing.mode === "add" ? form.__sourceKey : editing.sourceKey!;
      if (!sourceKey) throw new Error(`${activeTableMeta.keyHeader} wajib diisi.`);

      const { ok, data } = await api(`/api/master-data/${selectedTable}/pending`, {
        method: "POST",
        body: { operation: editing.mode === "add" ? "create" : "update", sourceKey, fields, reason: reason || undefined },
      });
      if (!ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? "Gagal menyimpan perubahan.");

      setEditing(null);
      await loadTableData(selectedTable);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan perubahan.");
    } finally {
      setBusy(false);
    }
  }

  async function stageDeactivate(row: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await api(`/api/master-data/${selectedTable}/pending`, {
        method: "POST",
        body: { operation: "deactivate", sourceKey: row.source_key, reason: "Deactivated via Master Data admin" },
      });
      if (!ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? "Gagal menonaktifkan.");
      await loadTableData(selectedTable);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menonaktifkan.");
    } finally {
      setBusy(false);
    }
  }

  async function discard(pendingChangeId: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/master-data/pending/${pendingChangeId}`, { method: "DELETE" });
      await loadTableData(selectedTable);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal membatalkan perubahan.");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const { ok, data } = await api<{ published: boolean; report?: ValidationReport }>(
        `/api/master-data/${selectedTable}/publish`,
        { method: "POST" },
      );
      if (!ok || !data.published) {
        setReport(data.report ?? null);
        throw new Error("Publikasi gagal — lihat laporan validasi di bawah.");
      }
      await loadTableData(selectedTable);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal publikasi.");
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkImport(file: File) {
    setBusy(true);
    setError(null);
    setImportMsg(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/master-data/${selectedTable}/import-xlsx`, { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? "Import gagal.");
      const skipped = (data.skipped as { row: number; reason: string }[]) ?? [];
      setImportMsg(
        `Staged ${data.staged} row(s) as pending changes.` +
          (skipped.length > 0 ? ` ${skipped.length} row(s) skipped: ${skipped.map((s) => `row ${s.row} (${s.reason})`).join("; ")}` : ""),
      );
      await loadTableData(selectedTable);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import gagal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <div style={{ marginBottom: 16, display: "flex", gap: 16 }}>
        <a href="/dashboard" className="link-btn">
          &larr; Dashboard
        </a>
        <a href="/admin/guides" className="link-btn">
          Guide Versions
        </a>
      </div>

      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">CBP</div>
          <div className="brand-text">
            <h1>Master Data</h1>
            <p>Super Admin Only &middot; edit one table, review, publish</p>
          </div>
        </div>
      </header>

      <div className="category-tabs">
        {tables.map((t) => (
          <button key={t.table} className={t.table === selectedTable ? "active" : ""} onClick={() => setSelectedTable(t.table)}>
            {t.tabName.replace(/_/g, " ")}
          </button>
        ))}
      </div>

      {error && <p className="error-note">{error}</p>}

      {activeTableMeta && (
        <>
          <div className="card">
            <div className="section-actions">
              <h2 style={{ marginBottom: 0 }}>{activeTableMeta.tabName.replace(/_/g, " ")} — Active Rows</h2>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label className="btn secondary small" style={{ cursor: "pointer", margin: 0 }}>
                  Bulk import (.xlsx)
                  <input
                    type="file"
                    accept=".xlsx"
                    style={{ display: "none" }}
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleBulkImport(file);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button className="btn small" onClick={openAdd} disabled={busy}>
                  + Add row
                </button>
              </div>
            </div>
            {importMsg && <p className="helptext">{importMsg}</p>}
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{activeTableMeta.keyHeader}</th>
                    {activeTableMeta.columns.map((c) => (
                      <th key={c.dbColumn}>{c.header}</th>
                    ))}
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.source_key as string}>
                      <td className="mono">{row.source_key as string}</td>
                      {activeTableMeta.columns.map((c) => (
                        <td key={c.dbColumn} className={c.type === "number" ? "mono" : undefined}>
                          {String(row[c.dbColumn] ?? "—")}
                        </td>
                      ))}
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="btn secondary small" onClick={() => openEdit(row)} disabled={busy}>
                            Edit
                          </button>
                          <button className="icon-btn" onClick={() => stageDeactivate(row)} disabled={busy} title="Deactivate">
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={activeTableMeta.columns.length + 2} className="empty-state">
                        No active rows.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <div className="section-actions">
              <h2 style={{ marginBottom: 0 }}>Pending Changes ({pending.length})</h2>
              <button className="btn small" onClick={publish} disabled={busy || pending.length === 0}>
                Publish {pending.length > 0 ? `${pending.length} change${pending.length > 1 ? "s" : ""}` : ""}
              </button>
            </div>
            {pending.length === 0 && <p className="empty-state">Nothing queued for this table.</p>}
            {pending.map((p) => (
              <div key={p.pendingChangeId} style={{ borderBottom: "1px solid var(--surface-alt)", padding: "8px 0", fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <div>
                  <span className={`pill ${p.operation === "create" ? "success" : p.operation === "deactivate" ? "danger" : "amber"}`}>
                    {p.operation}
                  </span>{" "}
                  <span className="mono">{p.sourceKey}</span>
                  {p.reason && <span style={{ color: "var(--ink-soft)" }}> — {p.reason}</span>}
                </div>
                <button className="icon-btn" onClick={() => discard(p.pendingChangeId)} disabled={busy} title="Discard">
                  ✕
                </button>
              </div>
            ))}
            {report && (
              <div className="error-note" style={{ marginTop: 12 }}>
                <strong>Validation failed</strong>
                {report.formulaErrors.map((e, i) => (
                  <div key={`f${i}`}>Formula: {e}</div>
                ))}
                {report.rangeErrors.map((e, i) => (
                  <div key={`r${i}`}>Range: {e}</div>
                ))}
                {report.duplicateKeyErrors.map((e, i) => (
                  <div key={`d${i}`}>Duplicate key: {e}</div>
                ))}
                {report.rawBarErrors.map((e, i) => (
                  <div key={`b${i}`}>Raw bar stock: {e}</div>
                ))}
                {report.regressionFailures.map((e, i) => (
                  <div key={`s${i}`}>Regression: {e}</div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {editing && activeTableMeta && (
        <div
          style={{
            position: "fixed",
            right: 0,
            top: 0,
            bottom: 0,
            width: 420,
            background: "var(--surface)",
            borderLeft: "1px solid var(--border)",
            padding: 20,
            overflowY: "auto",
            boxShadow: "-4px 0 16px rgba(0,0,0,0.15)",
            zIndex: 100,
          }}
        >
          <h2 style={{ fontSize: 16, marginBottom: 16 }}>{editing.mode === "add" ? "Add row" : "Edit row"}</h2>

          {editing.mode === "add" && (
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">{activeTableMeta.keyHeader} (business key)</span>
              <input value={form.__sourceKey ?? ""} onChange={(e) => setForm({ ...form, __sourceKey: e.target.value })} />
            </label>
          )}

          {activeTableMeta.columns.map((col) => (
            <label className="field" key={col.dbColumn} style={{ marginBottom: 12 }}>
              <span className="field-label">
                {col.header}
                {col.required ? " *" : ""}
                {col.type === "reference" ? ` (${col.refTab} key)` : ""}
              </span>
              {col.type === "boolean" ? (
                <select value={form[col.dbColumn] ?? ""} onChange={(e) => setForm({ ...form, [col.dbColumn]: e.target.value })}>
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : (
                <input
                  type={col.type === "number" ? "number" : "text"}
                  value={form[col.dbColumn] ?? ""}
                  onChange={(e) => setForm({ ...form, [col.dbColumn]: e.target.value })}
                />
              )}
            </label>
          ))}

          <label className="field" style={{ marginBottom: 12 }}>
            <span className="field-label">Reason for this change</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. supplier price update Aug 2026" />
          </label>

          {error && <p className="error-note">{error}</p>}

          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={submitChange} disabled={busy} className="btn">
              Stage change
            </button>
            <button onClick={() => setEditing(null)} disabled={busy} className="btn secondary">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
