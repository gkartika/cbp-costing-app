"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const ADD_NEW = "__add_new__";

type Customer = { customerId: string; customerName: string; customerCode: string | null };

export function NewCostingForm() {
  const router = useRouter();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch("/api/customers")
      .then((r) => r.json())
      .then((data) => setCustomers(data.customers ?? []))
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Customer is optional at creation — it can be set later in the
    // Workspace, but is required before Finalize.
    const customerName =
      selected === ADD_NEW ? newName.trim() : (customers.find((c) => c.customerId === selected)?.customerName ?? "");
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/costings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(customerName ? { customerName } : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error?.message ?? "Gagal membuat costing.");
        return;
      }
      // UX-001: creating a costing opens the Workspace directly.
      router.push(`/costings/${data.costingId}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="field-row cols-3" style={{ alignItems: "end", marginBottom: 0 }}>
      <label className="field">
        <span className="field-label">Customer (optional — can be set later)</span>
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">— belum ditentukan —</option>
          {customers.map((c) => (
            <option key={c.customerId} value={c.customerId}>
              {c.customerName}
              {c.customerCode ? ` (${c.customerCode})` : ""}
            </option>
          ))}
          <option value={ADD_NEW}>+ Customer baru…</option>
        </select>
      </label>

      {selected === ADD_NEW ? (
        <label className="field">
          <span className="field-label">Nama customer baru</span>
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. PT Contoh Sejahtera" />
        </label>
      ) : (
        <div />
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span className="field-label">&nbsp;</span>
        <button type="submit" className="btn" disabled={submitting}>
          {submitting ? "Membuat…" : "+ New Costing"}
        </button>
      </div>

      {error && (
        <div className="field-row cols-1" style={{ gridColumn: "1 / -1", marginTop: 4, marginBottom: 0 }}>
          <p className="error-note" style={{ margin: 0 }}>
            {error}
          </p>
        </div>
      )}
    </form>
  );
}
