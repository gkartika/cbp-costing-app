import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { serializeCostingLine, type CostingLineRow } from "@/lib/costings/lines";
import { Workspace } from "./Workspace";

export default async function CostingWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const { rows } = await pool.query<CostingHeaderRow>(`SELECT * FROM costing_headers WHERE costing_id = $1`, [id]);
  if (rows.length === 0) notFound();
  const costing = serializeCosting(rows[0], user.userId);

  const { rows: lineRows } = await pool.query<
    CostingLineRow & { has_current_snapshot: boolean; unit_selling_price: string | null; order_total: string | null }
  >(
    `SELECT cl.*,
            latest.has_current_snapshot,
            latest.unit_selling_price,
            latest.order_total
     FROM costing_lines cl
     LEFT JOIN LATERAL (
       SELECT (s.created_at >= cl.updated_at) AS has_current_snapshot, s.unit_selling_price, s.order_total
       FROM line_calculation_snapshots s
       WHERE s.costing_line_id = cl.costing_line_id
       ORDER BY s.created_at DESC
       LIMIT 1
     ) latest ON true
     WHERE cl.costing_id = $1 AND cl.deleted_at IS NULL
     ORDER BY cl.line_no`,
    [id],
  );
  const lines = lineRows.map((r) => {
    const line = serializeCostingLine(r, r.has_current_snapshot ?? false);
    return {
      ...line,
      updatedAt: line.updatedAt.toISOString(),
      createdAt: line.createdAt.toISOString(),
      deletedAt: line.deletedAt?.toISOString() ?? null,
      latestUnitSellingPrice: r.unit_selling_price !== null ? Number(r.unit_selling_price) : null,
      latestOrderTotal: r.order_total !== null ? Number(r.order_total) : null,
    };
  });

  const serializedCosting = {
    ...costing,
    updatedAt: costing.updatedAt.toISOString(),
    createdAt: costing.createdAt.toISOString(),
    finalizedAt: costing.finalizedAt?.toISOString() ?? null,
    voidedAt: costing.voidedAt?.toISOString() ?? null,
  };

  return (
    <Workspace
      initialCosting={serializedCosting}
      initialLines={lines}
      currentUserId={user.userId}
      isSuperAdmin={user.roles.includes("super_admin")}
    />
  );
}
