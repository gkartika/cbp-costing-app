import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { NewCostingForm } from "./NewCostingForm";
import { LogoutButton } from "./LogoutButton";
import { StatusPill, AccessPill } from "@/components/Pills";

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { rows } = await pool.query<CostingHeaderRow>(
    `SELECT * FROM costing_headers ORDER BY created_at DESC LIMIT 200`,
  );
  const costings = rows.map((r) => serializeCosting(r, user.userId));

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-mark">CBP</div>
          <div className="brand-text">
            <h1>Dashboard</h1>
            <p>Costing &amp; Quotation</p>
          </div>
        </div>
        <div className="header-actions">
          {user.roles.includes("super_admin") && (
            <>
              <a href="/admin/master-data" className="link-btn">
                Master Data
              </a>
              <a href="/admin/guides" className="link-btn">
                Guide Admin
              </a>
            </>
          )}
          <span style={{ fontSize: 13 }}>{user.displayName}</span>
          <LogoutButton />
        </div>
      </header>

      <div className="card">
        <h2>New Costing</h2>
        <NewCostingForm />
      </div>

      <div className="card">
        <h2>All Costings</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Quotation No</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Updated</th>
                <th>Access</th>
              </tr>
            </thead>
            <tbody>
              {costings.map((c) => (
                <tr key={c.costingId}>
                  <td>
                    <a href={`/costings/${c.costingId}`} style={{ color: "var(--steel)", fontWeight: 600 }}>
                      {c.customerName || <em style={{ color: "var(--ink-soft)", fontWeight: 400 }}>belum ada customer</em>}
                    </a>
                  </td>
                  <td className="mono">{c.quotationNo ?? "—"}</td>
                  <td>
                    <StatusPill status={c.status} />
                  </td>
                  <td>{c.ownerUserId === user.userId ? "You" : c.ownerUserId}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>
                    {new Date(c.updatedAt).toLocaleString()}
                  </td>
                  <td>
                    <AccessPill canEdit={c.canEdit} />
                  </td>
                </tr>
              ))}
              {costings.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-state">
                    No costings yet.
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
