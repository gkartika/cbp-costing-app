"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";

type User = {
  userId: string;
  username: string;
  displayName: string;
  active: boolean;
  mustResetPassword: boolean;
  roles: string[];
};

const ROLE_LABELS: Record<string, string> = {
  costing_user: "Costing User",
  costing_head: "Costing Head",
  super_admin: "Super Admin",
  auditor: "Auditor",
};

export function UserAdmin({ initialUsers, currentUserId }: { initialUsers: User[]; currentUserId: string }) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("costing_user");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ username: string; password: string } | null>(null);

  const [resetTargetId, setResetTargetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetDone, setResetDone] = useState<string | null>(null);

  const [nameTargetId, setNameTargetId] = useState<string | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  async function handleRenameUser(userId: string) {
    setNameBusy(true);
    setNameError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/display-name`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: nameValue.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Gagal mengubah nama tampilan.");
      setUsers((prev) => prev.map((u) => (u.userId === userId ? { ...u, displayName: body.displayName } : u)));
      setNameTargetId(null);
      setNameValue("");
    } catch (e) {
      setNameError(e instanceof Error ? e.message : "Gagal mengubah nama tampilan.");
    } finally {
      setNameBusy(false);
    }
  }

  async function handleResetPassword(userId: string) {
    setResetBusy(true);
    setResetError(null);
    try {
      const res = await fetch(`/api/admin/users/${userId}/password`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Gagal reset password.");
      setResetDone(resetPassword);
      setResetPassword("");
      setResetTargetId(null);
      router.refresh();
    } catch (e) {
      setResetError(e instanceof Error ? e.message : "Gagal reset password.");
    } finally {
      setResetBusy(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          roles: [role],
          // Blank means "call them by their username" — the server applies the
          // same default, this just avoids sending an empty string.
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error?.message ?? "Gagal membuat user.");

      setCreated({ username: username.trim(), password });
      setUsername("");
      setPassword("");
      setDisplayName("");
      setRole("costing_user");

      const listed = await fetch("/api/admin/users");
      if (listed.ok) setUsers((await listed.json()).users);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal membuat user.");
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
        <a href="/admin/guides" className="link-btn">
          Guide Admin
        </a>
      </div>

      <header className="app-header">
        <div className="brand">
          <img src="/brand/cbp-logomark.png" alt="CBP" className="brand-mark" />
          <div className="brand-text">
            <h1>Users</h1>
            <p>Kelola akun pengguna</p>
          </div>
        </div>
      </header>

      <div className="card">
        <h2>Tambah User</h2>
        <form onSubmit={handleCreate}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="field" style={{ minWidth: 180 }}>
              <span className="field-label">Username</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                minLength={3}
                autoComplete="off"
                placeholder="mis. andi"
              />
            </label>

            <label className="field" style={{ minWidth: 180 }}>
              <span className="field-label">Password</span>
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={4}
                autoComplete="new-password"
                placeholder="minimal 4 karakter"
              />
            </label>

            <label className="field" style={{ minWidth: 160 }}>
              <span className="field-label">Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="costing_user">Costing User</option>
                <option value="costing_head">Costing Head</option>
                <option value="super_admin">Super Admin</option>
                <option value="auditor">Auditor</option>
              </select>
            </label>

            <label className="field" style={{ minWidth: 200 }}>
              <span className="field-label">Nama tampilan (opsional)</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="off"
                placeholder="ikut username"
              />
            </label>

            <button type="submit" disabled={busy} className="btn" style={{ marginBottom: 12 }}>
              {busy ? "Menyimpan…" : "Buat User"}
            </button>
          </div>
        </form>

        <p className="hint" style={{ marginTop: 0 }}>
          Password yang diisi di sini langsung berlaku — user bisa login dengan itu tanpa diminta ganti password.
        </p>

        {created && (
          <p className="pill success" role="status" style={{ display: "inline-block" }}>
            User <strong>{created.username}</strong> dibuat. Password: <strong>{created.password}</strong>
          </p>
        )}

        {error && (
          <p className="error-note" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Semua User</h2>
        {nameError && (
          <p className="error-note" role="alert">
            {nameError}
          </p>
        )}
        {resetError && (
          <p className="error-note" role="alert">
            {resetError}
          </p>
        )}
        {resetDone && (
          <p className="pill success" role="status" style={{ display: "inline-block", marginBottom: 12 }}>
            Password direset ke: <strong>{resetDone}</strong>. User akan diminta ganti password saat login berikutnya.
          </p>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Nama</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.userId}>
                  <td className="mono">
                    {u.username}
                    {u.userId === currentUserId && (
                      <span className="pill neutral" style={{ marginLeft: 6 }}>
                        anda
                      </span>
                    )}
                  </td>
                  <td>
                    {nameTargetId === u.userId ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          type="text"
                          value={nameValue}
                          onChange={(e) => setNameValue(e.target.value)}
                          placeholder="nama tampilan"
                          style={{ width: 150 }}
                        />
                        <button
                          onClick={() => handleRenameUser(u.userId)}
                          disabled={nameBusy || nameValue.trim().length === 0}
                          className="btn small"
                        >
                          {nameBusy ? "…" : "Simpan"}
                        </button>
                        <button
                          onClick={() => {
                            setNameTargetId(null);
                            setNameValue("");
                            setNameError(null);
                          }}
                          className="btn secondary small"
                        >
                          Batal
                        </button>
                      </div>
                    ) : (
                      <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                        {u.displayName}
                        <button
                          onClick={() => {
                            setNameTargetId(u.userId);
                            setNameValue(u.displayName);
                            setNameError(null);
                          }}
                          className="link-btn"
                          style={{ fontSize: 12 }}
                        >
                          Edit
                        </button>
                      </span>
                    )}
                  </td>
                  <td>{u.roles.map((r) => ROLE_LABELS[r] ?? r).join(", ") || "—"}</td>
                  <td>
                    {!u.active ? (
                      <span className="pill danger">nonaktif</span>
                    ) : u.mustResetPassword ? (
                      <span className="pill amber">harus ganti password</span>
                    ) : (
                      <span className="pill success">aktif</span>
                    )}
                  </td>
                  <td>
                    {resetTargetId === u.userId ? (
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <input
                          type="text"
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          placeholder="password baru"
                          minLength={4}
                          autoComplete="new-password"
                          style={{ width: 130 }}
                        />
                        <button
                          onClick={() => handleResetPassword(u.userId)}
                          disabled={resetBusy || resetPassword.length < 4}
                          className="btn small"
                        >
                          {resetBusy ? "…" : "Simpan"}
                        </button>
                        <button
                          onClick={() => {
                            setResetTargetId(null);
                            setResetPassword("");
                            setResetError(null);
                          }}
                          className="btn secondary small"
                        >
                          Batal
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => {
                          setResetTargetId(u.userId);
                          setResetPassword("");
                          setResetError(null);
                          setResetDone(null);
                        }}
                        className="link-btn"
                        style={{ fontSize: 12 }}
                      >
                        Reset Password
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-state">
                    Belum ada user.
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
