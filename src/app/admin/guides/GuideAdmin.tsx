"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusPill } from "@/components/Pills";

type Guide = { guideVersionId: string; versionCode: string; status: string; createdAt: string };
type ValidationReport = {
  formulaErrors: string[];
  rangeErrors: string[];
  duplicateKeyErrors: string[];
  rawBarErrors: string[];
  regressionFailures: string[];
  simulationCasesRun: number;
};
type TabDiff = {
  tabName: string;
  added: { sourceKey: string }[];
  removed: { sourceKey: string }[];
  changed: { sourceKey: string; changedColumns?: string[] }[];
  unchangedCount: number;
};

export function GuideAdmin({ initialGuides }: { initialGuides: Guide[] }) {
  const router = useRouter();
  const [guides, setGuides] = useState(initialGuides);
  const [versionCode, setVersionCode] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, ValidationReport>>({});
  const [diff, setDiff] = useState<{ targetVersionId: string; tabs: TabDiff[] } | null>(null);

  async function refresh() {
    const res = await fetch("/api/guides");
    const data = await res.json();
    setGuides(data.guides);
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !versionCode) return;
    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("versionCode", versionCode);
      const res = await fetch("/api/guides/import", { method: "POST", body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Import gagal.");
      setVersionCode("");
      setFile(null);
      await refresh();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function handleValidate(guideVersionId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/guides/${guideVersionId}/validate`, { method: "POST" });
      const body = await res.json();
      setReports((prev) => ({ ...prev, [guideVersionId]: body.report }));
      if (!res.ok && !body.report) throw new Error(body.error?.message ?? "Validasi gagal.");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Validasi gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function handlePublish(guideVersionId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/guides/${guideVersionId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Publish gagal.");
      await refresh();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publish gagal.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDiff(guideVersionId: string) {
    const published = guides.find((g) => g.status === "published");
    if (!published) {
      setError("Tidak ada versi Published untuk dibandingkan.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/guides/${guideVersionId}/diff?compareTo=${published.guideVersionId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Diff gagal.");
      setDiff(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Diff gagal.");
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
        <a href="/admin/master-data" className="link-btn">
          Master Data
        </a>
      </div>

      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">CBP</div>
          <div className="brand-text">
            <h1>Guide Version Management</h1>
            <p>Super Admin Only</p>
          </div>
        </div>
      </header>

      {error && <p className="error-note">{error}</p>}

      <div className="card">
        <h2>Import New Version</h2>
        <form onSubmit={handleImport} className="field-row cols-3" style={{ alignItems: "end", marginBottom: 0 }}>
          <label className="field">
            <span className="field-label">Version code</span>
            <input
              placeholder="e.g. 2026.09.01"
              value={versionCode}
              onChange={(e) => setVersionCode(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">Package (.xlsx)</span>
            <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button type="submit" className="btn" disabled={busy || !file || !versionCode}>
            Import
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Versions</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {guides.map((g) => (
                <React.Fragment key={g.guideVersionId}>
                  <tr>
                    <td className="mono" style={{ fontWeight: 600 }}>
                      {g.versionCode}
                    </td>
                    <td>
                      <StatusPill status={g.status} />
                    </td>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {new Date(g.createdAt).toLocaleString()}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        {g.status === "draft" && (
                          <button onClick={() => handleValidate(g.guideVersionId)} disabled={busy} className="btn small">
                            Validate
                          </button>
                        )}
                        {g.status === "validated" && (
                          <button onClick={() => handlePublish(g.guideVersionId)} disabled={busy} className="btn small">
                            Publish
                          </button>
                        )}
                        <button onClick={() => handleDiff(g.guideVersionId)} disabled={busy} className="btn secondary small">
                          Diff vs Published
                        </button>
                      </div>
                    </td>
                  </tr>
                  {reports[g.guideVersionId] && (
                    <tr>
                      <td colSpan={4} style={{ background: "var(--surface-alt)" }}>
                        <ValidationReportView report={reports[g.guideVersionId]} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {guides.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty-state">
                    No guide versions yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {diff && (
        <div className="card">
          <h2>Diff vs Published</h2>
          {diff.tabs
            .filter((t) => t.added.length + t.removed.length + t.changed.length > 0)
            .map((t) => (
              <div key={t.tabName} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13 }}>
                <strong style={{ minWidth: 200 }}>{t.tabName}</strong>
                {t.added.length > 0 && <span className="pill success">+{t.added.length} added</span>}
                {t.removed.length > 0 && <span className="pill danger">-{t.removed.length} removed</span>}
                {t.changed.length > 0 && <span className="pill amber">{t.changed.length} changed</span>}
                <span className="pill neutral">{t.unchangedCount} unchanged</span>
              </div>
            ))}
          {diff.tabs.every((t) => t.added.length + t.removed.length + t.changed.length === 0) && (
            <p className="empty-state">No differences.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ValidationReportView({ report }: { report: ValidationReport }) {
  const allPass =
    report.formulaErrors.length === 0 &&
    report.rangeErrors.length === 0 &&
    report.duplicateKeyErrors.length === 0 &&
    report.rawBarErrors.length === 0 &&
    report.regressionFailures.length === 0;
  return (
    <div style={{ padding: "10px 4px" }}>
      <p style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span className={`pill ${allPass ? "success" : "danger"}`}>{allPass ? "PASS" : "FAILED"}</span>
        <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>{report.simulationCasesRun} golden simulation cases run</span>
      </p>
      {report.formulaErrors.map((e, i) => (
        <div key={`f${i}`} className="error-note" style={{ marginBottom: 4 }}>
          Formula: {e}
        </div>
      ))}
      {report.rangeErrors.map((e, i) => (
        <div key={`r${i}`} className="error-note" style={{ marginBottom: 4 }}>
          Range: {e}
        </div>
      ))}
      {report.duplicateKeyErrors.map((e, i) => (
        <div key={`d${i}`} className="error-note" style={{ marginBottom: 4 }}>
          Duplicate key: {e}
        </div>
      ))}
      {report.rawBarErrors.map((e, i) => (
        <div key={`b${i}`} className="error-note" style={{ marginBottom: 4 }}>
          Raw bar stock: {e}
        </div>
      ))}
      {report.regressionFailures.map((e, i) => (
        <div key={`s${i}`} className="error-note" style={{ marginBottom: 4 }}>
          Regression: {e}
        </div>
      ))}
    </div>
  );
}
