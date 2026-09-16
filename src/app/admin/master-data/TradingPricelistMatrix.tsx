"use client";

import { useEffect, useMemo, useState } from "react";

type ItemRow = {
  tradingItemId: string;
  sourceKey: string;
  productCategory: string;
  productName: string;
  gradeOrSpec: string | null;
  sizeLabel: string;
  pitch: string | null;
};

type TierRow = {
  tierId: string;
  sourceKey: string;
  tradingItemId: string;
  qtyMin: number;
  qtyMax: number | null;
  unitPrice: number;
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

/** "3/8" -> 0.375, "1-1/4" -> 1.25, "M12" -> 12, "100" -> 100 -- good enough to
 * sort sizes within one family (which is always all-metric or all-inch, never
 * mixed), not to compare across families. */
function sizeSortKey(sizeLabel: string): number {
  const s = sizeLabel.replace(/^M/i, "");
  const wholeAndFraction = s.match(/^(\d+)-(\d+)\/(\d+)$/);
  if (wholeAndFraction) return Number(wholeAndFraction[1]) + Number(wholeAndFraction[2]) / Number(wholeAndFraction[3]);
  const fraction = s.match(/^(\d+)\/(\d+)$/);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  const n = Number(s);
  return Number.isNaN(n) ? Infinity : n;
}

function bucketKey(qtyMin: number, qtyMax: number | null): string {
  return `${qtyMin}|${qtyMax ?? "inf"}`;
}

function bucketLabel(qtyMin: number, qtyMax: number | null): string {
  if (qtyMax === null) return `${qtyMin}+`;
  if (qtyMin <= 1) return `≤ ${qtyMax}`;
  return `${qtyMin}–${qtyMax}`;
}

function cellKey(tradingItemId: string, qtyMin: number, qtyMax: number | null): string {
  return `${tradingItemId}::${bucketKey(qtyMin, qtyMax)}`;
}

export function TradingPricelistMatrix(props: { onChanged?: () => void }) {
  const [items, setItems] = useState<ItemRow[]>([]);
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [familyKey, setFamilyKey] = useState<string>("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [newSize, setNewSize] = useState("");
  const [newPitch, setNewPitch] = useState("");

  async function load() {
    setLoading(true);
    const [itemsRes, tiersRes] = await Promise.all([
      api<{ rows: Record<string, unknown>[] }>("/api/master-data/trading_items"),
      api<{ rows: Record<string, unknown>[] }>("/api/master-data/trading_price_tiers"),
    ]);
    setItems(
      (itemsRes.data.rows ?? []).map((r) => ({
        tradingItemId: r.trading_item_id as string,
        sourceKey: r.source_key as string,
        productCategory: r.product_category as string,
        productName: r.product_name as string,
        gradeOrSpec: (r.grade_or_spec as string | null) ?? null,
        sizeLabel: r.size_label as string,
        pitch: (r.pitch as string | null) ?? null,
      })),
    );
    setTiers(
      (tiersRes.data.rows ?? []).map((r) => ({
        tierId: r.tier_id as string,
        sourceKey: r.source_key as string,
        tradingItemId: r.trading_item_id as string,
        qtyMin: Number(r.qty_min),
        qtyMax: r.qty_max === null ? null : Number(r.qty_max),
        unitPrice: Number(r.unit_price),
      })),
    );
    setLoading(false);
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const families = useMemo(() => {
    const map = new Map<string, { key: string; label: string; category: string; productName: string; grade: string | null }>();
    for (const item of items) {
      const key = `${item.productCategory}::${item.productName}::${item.gradeOrSpec ?? ""}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: `${item.productCategory} — ${item.productName}${item.gradeOrSpec ? ` — Grade ${item.gradeOrSpec}` : ""}`,
          category: item.productCategory,
          productName: item.productName,
          grade: item.gradeOrSpec,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [items]);

  // Defaulting familyKey to the first family is a render-time derivation, not
  // an effect -- avoids the extra render an effect-based default would cause.
  const effectiveFamilyKey = familyKey || families[0]?.key || "";

  const familyItems = useMemo(
    () =>
      items
        .filter((i) => `${i.productCategory}::${i.productName}::${i.gradeOrSpec ?? ""}` === effectiveFamilyKey)
        .sort((a, b) => sizeSortKey(a.sizeLabel) - sizeSortKey(b.sizeLabel)),
    [items, effectiveFamilyKey],
  );

  const familyItemIds = useMemo(() => new Set(familyItems.map((i) => i.tradingItemId)), [familyItems]);

  const buckets = useMemo(() => {
    const map = new Map<string, { qtyMin: number; qtyMax: number | null }>();
    for (const t of tiers) {
      if (!familyItemIds.has(t.tradingItemId)) continue;
      map.set(bucketKey(t.qtyMin, t.qtyMax), { qtyMin: t.qtyMin, qtyMax: t.qtyMax });
    }
    return [...map.values()].sort((a, b) => a.qtyMin - b.qtyMin);
  }, [tiers, familyItemIds]);

  const tierByCell = useMemo(() => {
    const map = new Map<string, TierRow>();
    for (const t of tiers) {
      if (!familyItemIds.has(t.tradingItemId)) continue;
      map.set(cellKey(t.tradingItemId, t.qtyMin, t.qtyMax), t);
    }
    return map;
  }, [tiers, familyItemIds]);

  function cellValue(itemId: string, qtyMin: number, qtyMax: number | null): string {
    const key = cellKey(itemId, qtyMin, qtyMax);
    if (key in edits) return edits[key];
    const tier = tierByCell.get(key);
    return tier ? String(tier.unitPrice) : "";
  }

  function isDirty(itemId: string, qtyMin: number, qtyMax: number | null): boolean {
    const key = cellKey(itemId, qtyMin, qtyMax);
    if (!(key in edits)) return false;
    const tier = tierByCell.get(key);
    const original = tier ? String(tier.unitPrice) : "";
    return edits[key] !== original;
  }

  function setCell(itemId: string, qtyMin: number, qtyMax: number | null, value: string) {
    setEdits((prev) => ({ ...prev, [cellKey(itemId, qtyMin, qtyMax)]: value }));
  }

  const dirtyCount = useMemo(
    () =>
      familyItems.reduce(
        (n, item) => n + buckets.filter((b) => isDirty(item.tradingItemId, b.qtyMin, b.qtyMax)).length,
        0,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edits, familyItems, buckets, tierByCell],
  );

  async function save() {
    setBusy(true);
    setError(null);
    setReport(null);
    setSuccessMsg(null);
    try {
      const changes: { operation: "create" | "update"; sourceKey: string; fields: Record<string, unknown> }[] = [];
      for (const item of familyItems) {
        for (const b of buckets) {
          if (!isDirty(item.tradingItemId, b.qtyMin, b.qtyMax)) continue;
          const raw = cellValue(item.tradingItemId, b.qtyMin, b.qtyMax);
          if (raw.trim() === "") continue; // clearing a cell back to blank is a no-op, not a delete
          const price = Number(raw);
          if (!Number.isFinite(price) || price < 0) {
            throw new Error(`Harga tidak valid untuk ${item.sizeLabel} / ${bucketLabel(b.qtyMin, b.qtyMax)}: "${raw}"`);
          }
          const existing = tierByCell.get(cellKey(item.tradingItemId, b.qtyMin, b.qtyMax));
          if (existing) {
            changes.push({ operation: "update", sourceKey: existing.sourceKey, fields: { unit_price: price } });
          } else {
            const sourceKey = `TIER-${item.sourceKey}-${b.qtyMin}${b.qtyMax !== null ? `-${b.qtyMax}` : ""}`;
            changes.push({
              operation: "create",
              sourceKey,
              fields: {
                trading_item_id: item.sourceKey,
                qty_min: b.qtyMin,
                qty_max: b.qtyMax,
                unit_price: price,
              },
            });
          }
        }
      }
      if (changes.length === 0) {
        setBusy(false);
        return;
      }

      const family = families.find((f) => f.key === effectiveFamilyKey);
      const reason = `Trading pricelist matrix edit: ${family?.label ?? effectiveFamilyKey} — ${changes.length} price(s)`;
      for (const change of changes) {
        const { ok, data } = await api("/api/master-data/trading_price_tiers/pending", {
          method: "POST",
          body: { ...change, reason },
        });
        if (!ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? "Gagal menyimpan perubahan.");
      }

      const { ok, data } = await api<{ published: boolean; report?: ValidationReport; error?: { message?: string } }>(
        "/api/master-data/trading_price_tiers/publish",
        { method: "POST" },
      );
      if (!ok || !data.published) {
        setReport(data.report ?? null);
        props.onChanged?.();
        throw new Error(
          data.report
            ? "Publikasi gagal — perubahan masih tersimpan sebagai pending, lihat laporan validasi di bawah."
            : (data.error?.message ?? "Publikasi gagal — perubahan masih tersimpan sebagai pending."),
        );
      }

      setEdits({});
      setSuccessMsg(`${changes.length} harga berhasil disimpan dan dipublikasikan.`);
      await load();
      props.onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan perubahan.");
    } finally {
      setBusy(false);
    }
  }

  async function addSize() {
    const family = families.find((f) => f.key === effectiveFamilyKey);
    if (!family) return;
    const sizeLabel = newSize.trim();
    if (!sizeLabel) {
      setError("Ukuran wajib diisi.");
      return;
    }
    if (familyItems.some((i) => i.sizeLabel.toLowerCase() === sizeLabel.toLowerCase())) {
      setError(`Ukuran ${sizeLabel} sudah ada untuk grade ini.`);
      return;
    }

    setBusy(true);
    setError(null);
    setReport(null);
    setSuccessMsg(null);
    try {
      const slug = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const sourceKey = ["TR", slug(family.category), family.grade ? slug(family.grade) : null, slug(sizeLabel)]
        .filter(Boolean)
        .join("-");

      const { ok, data } = await api("/api/master-data/trading_items/pending", {
        method: "POST",
        body: {
          operation: "create",
          sourceKey,
          fields: {
            product_category: family.category,
            product_name: family.productName,
            grade_or_spec: family.grade,
            size_label: sizeLabel,
            pitch: newPitch.trim() || undefined,
          },
          reason: `Trading pricelist matrix: new size ${sizeLabel} for ${family.label}`,
        },
      });
      if (!ok) throw new Error((data as { error?: { message?: string } }).error?.message ?? "Gagal menambah ukuran.");

      const publishRes = await api<{ published: boolean; report?: ValidationReport; error?: { message?: string } }>(
        "/api/master-data/trading_items/publish",
        { method: "POST" },
      );
      if (!publishRes.ok || !publishRes.data.published) {
        setReport(publishRes.data.report ?? null);
        throw new Error(
          publishRes.data.report
            ? "Publikasi gagal — ukuran masih tersimpan sebagai pending, lihat laporan validasi di bawah."
            : (publishRes.data.error?.message ?? "Publikasi gagal — ukuran masih tersimpan sebagai pending."),
        );
      }

      setNewSize("");
      setNewPitch("");
      setSuccessMsg(`Ukuran ${sizeLabel} ditambahkan — isi harganya di tabel di atas.`);
      await load();
      props.onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menambah ukuran.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="empty-state">Memuat data pricelist...</p>;

  return (
    <div className="card">
      <div className="section-actions">
        <h2 style={{ marginBottom: 0 }}>Trading Pricelist — Matrix</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <select value={effectiveFamilyKey} onChange={(e) => setFamilyKey(e.target.value)} disabled={busy}>
            {families.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={save} disabled={busy || dirtyCount === 0}>
            Save {dirtyCount > 0 ? `(${dirtyCount})` : ""}
          </button>
        </div>
      </div>

      <p className="helptext">
        Ukuran x kuantitas. Kolom kuantitas mengikuti tier yang sudah ada untuk grade ini — sel kosong berarti belum
        ada harga untuk kombinasi itu; isi untuk menambahkannya. Save langsung mempublikasikan (tidak ada langkah
        review terpisah), jadi periksa angkanya sebelum menekan Save.
      </p>

      {error && (
        <p className="error-note" role="alert">
          {error}
        </p>
      )}
      {successMsg && <p className="helptext" style={{ color: "var(--success)" }}>{successMsg}</p>}

      {buckets.length === 0 ? (
        <p className="empty-state">Belum ada tier harga untuk grade ini.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Ukuran</th>
                <th>Pitch</th>
                {buckets.map((b) => (
                  <th key={bucketKey(b.qtyMin, b.qtyMax)}>{bucketLabel(b.qtyMin, b.qtyMax)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {familyItems.map((item) => (
                <tr key={item.tradingItemId}>
                  <td className="mono">{item.sizeLabel}</td>
                  <td className="mono">{item.pitch ?? "—"}</td>
                  {buckets.map((b) => {
                    const dirty = isDirty(item.tradingItemId, b.qtyMin, b.qtyMax);
                    return (
                      <td key={bucketKey(b.qtyMin, b.qtyMax)}>
                        <input
                          type="number"
                          min="0"
                          value={cellValue(item.tradingItemId, b.qtyMin, b.qtyMax)}
                          placeholder="—"
                          disabled={busy}
                          style={{
                            width: 90,
                            background: dirty ? "var(--warn-bg)" : undefined,
                          }}
                          onChange={(e) => setCell(item.tradingItemId, b.qtyMin, b.qtyMax, e.target.value)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--surface-alt)" }}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span className="field-label">Ukuran baru</span>
          <input
            value={newSize}
            onChange={(e) => setNewSize(e.target.value)}
            placeholder="e.g. M24"
            disabled={busy}
            style={{ width: 120 }}
          />
        </label>
        <label className="field" style={{ marginBottom: 0 }}>
          <span className="field-label">Pitch (opsional)</span>
          <input
            value={newPitch}
            onChange={(e) => setNewPitch(e.target.value)}
            placeholder="e.g. 3.0"
            disabled={busy}
            style={{ width: 100 }}
          />
        </label>
        <button className="btn secondary small" onClick={addSize} disabled={busy || !newSize.trim()}>
          + Add size
        </button>
      </div>
      <p className="helptext">
        Menambah ukuran baru untuk grade yang sedang dipilih di atas — langsung muncul di tabel untuk diisi
        harganya, tanpa perlu pindah ke tab Trading Items. Untuk menambah family/grade baru atau mengubah nama
        produk, gunakan tab Trading Items.
      </p>

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
  );
}
