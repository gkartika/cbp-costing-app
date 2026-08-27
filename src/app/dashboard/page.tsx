import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { NewCostingForm } from "./NewCostingForm";
import { LogoutButton } from "./LogoutButton";
import { CostingTable, type DashboardCosting } from "./CostingTable";

/**
 * Timestamps are stored UTC and displayed in Asia/Jakarta (04_DATA_MODEL).
 * Pinning both locale and zone here also keeps the string identical between
 * the server render and the browser, which a bare toLocaleDateString() does
 * not — that mismatch is a React hydration error.
 */
const JAKARTA_DATE = new Intl.DateTimeFormat("id-ID", {
  timeZone: "Asia/Jakarta",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // Total Quotation is the sum of each line's most recent snapshot, mirroring
  // the per-line "latest snapshot" join the costing detail route already uses.
  // A costing with no calculated lines yields NULL rather than 0, so "not
  // priced yet" stays visibly different from "priced at zero".
  const { rows } = await pool.query<
    CostingHeaderRow & { owner_name: string | null; total_nominal: string | null }
  >(
    `SELECT ch.*,
            u.display_name AS owner_name,
            totals.total_nominal
     FROM costing_headers ch
     LEFT JOIN users u ON u.user_id = ch.owner_user_id
     LEFT JOIN LATERAL (
       SELECT SUM(latest.order_total) AS total_nominal
       FROM costing_lines cl
       JOIN LATERAL (
         SELECT s.order_total
         FROM line_calculation_snapshots s
         WHERE s.costing_line_id = cl.costing_line_id
         ORDER BY s.created_at DESC
         LIMIT 1
       ) latest ON true
       WHERE cl.costing_id = ch.costing_id AND cl.deleted_at IS NULL
         -- Set components carry their own snapshot so each stays explainable;
         -- their value is already inside the set line's total, so summing them
         -- too would count every assembly twice.
         AND cl.parent_line_id IS NULL
     ) totals ON true
     WHERE ch.deleted_at IS NULL
     ORDER BY ch.created_at DESC
     LIMIT 200`,
  );

  const isSuperAdmin = user.roles.includes("super_admin");
  const costings: DashboardCosting[] = rows.map((r) => {
    const s = serializeCosting(r, user.userId);
    return {
      costingId: s.costingId,
      quotationNo: s.quotationNo,
      customerName: s.customerName,
      status: s.status,
      isPo: s.isPo,
      poNumber: s.poNumber,
      ownerName: r.owner_name ?? r.owner_user_id,
      isOwnedByMe: r.owner_user_id === user.userId,
      createdAtLabel: JAKARTA_DATE.format(r.created_at),
      totalNominal: r.total_nominal !== null ? Number(r.total_nominal) : null,
      canEdit: s.canEdit,
      canDelete: s.canDelete,
      canMarkPo: (r.owner_user_id === user.userId || isSuperAdmin) && r.status !== "voided",
    };
  });

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
          <a href="/reports" className="link-btn">
            Laporan
          </a>
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
        <CostingTable costings={costings} />
      </div>
    </div>
  );
}
