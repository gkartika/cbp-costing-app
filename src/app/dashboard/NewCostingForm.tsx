"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Deliberately just a button. Customer used to be pickable here, but the
 * Workspace already has a customer control and creating a costing lands you
 * there immediately — so the dashboard copy was a second place to set the
 * same field, adding a decision before the user has opened anything.
 * Customer stays optional until Finalize, which is where it is enforced.
 */
export function NewCostingForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/costings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
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
    <form onSubmit={handleSubmit} style={{ marginBottom: 0 }}>
      <button type="submit" className="btn" disabled={submitting}>
        {submitting ? "Membuat…" : "+ New Costing"}
      </button>
      {error && (
        <p className="error-note" role="alert" style={{ marginTop: 8, marginBottom: 0 }}>
          {error}
        </p>
      )}
    </form>
  );
}
