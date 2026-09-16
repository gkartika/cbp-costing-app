"use client";

import { useState } from "react";
import { Modal } from "./Modal";

/** Self-service "Ubah Password" — any logged-in user, via /api/me/password. */
export function ChangePasswordButton() {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function reset() {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError(null);
    setDone(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      setError("Konfirmasi password baru tidak sama.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/me/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Gagal mengubah password.");
      setDone(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mengubah password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        className="btn secondary small"
      >
        Ubah Password
      </button>
      {open && (
        <Modal onClose={() => setOpen(false)} width={380} label="Ubah Password">
          <h2 style={{ marginTop: 0 }}>Ubah Password</h2>
          <form onSubmit={submit}>
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Password saat ini</span>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Password baru</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={4}
                autoComplete="new-password"
              />
            </label>
            <label className="field" style={{ marginBottom: 12 }}>
              <span className="field-label">Konfirmasi password baru</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={4}
                autoComplete="new-password"
              />
            </label>

            {error && (
              <p className="error-note" role="alert">
                {error}
              </p>
            )}
            {done && (
              <p className="pill success" role="status" style={{ display: "inline-block", marginBottom: 12 }}>
                Password berhasil diubah.
              </p>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" disabled={busy} className="btn small">
                {busy ? "Menyimpan…" : "Simpan"}
              </button>
              <button type="button" onClick={() => setOpen(false)} className="btn secondary small">
                Tutup
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
