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
  const { rows } = await pool.query<
    CostingHeaderRow & { account_payment_terms: string | null; account_markup_percent: string | null }
  >(
    `SELECT ch.*, c.payment_terms AS account_payment_terms, c.markup_percent AS account_markup_percent
     FROM costing_headers ch LEFT JOIN customers c ON c.customer_id = ch.customer_id
     WHERE ch.costing_id = $1 AND ch.deleted_at IS NULL`,
    [id],
  );
  if (rows.length === 0) notFound();
  const costing = serializeCosting(rows[0], user.userId);

  const { rows: lineRows } = await pool.query<
    CostingLineRow & {
      chosen_has_current_snapshot: boolean;
      chosen_unit_selling_price: string | null;
      chosen_order_total: string | null;
      production_unit_selling_price: string | null;
      production_order_total: string | null;
      trading_unit_selling_price: string | null;
      trading_order_total: string | null;
    }
  >(
    `SELECT cl.*,
            (cl.unit_price_override IS NOT NULL OR chosen.has_current_snapshot) AS chosen_has_current_snapshot,
            COALESCE(cl.unit_price_override, chosen.unit_selling_price) AS chosen_unit_selling_price,
            CASE WHEN cl.unit_price_override IS NOT NULL THEN cl.unit_price_override * cl.qty ELSE chosen.order_total END
              AS chosen_order_total,
            production.unit_selling_price AS production_unit_selling_price,
            production.order_total AS production_order_total,
            trading.unit_selling_price AS trading_unit_selling_price,
            trading.order_total AS trading_order_total
     FROM costing_lines cl
     LEFT JOIN LATERAL (
       SELECT (s.created_at >= cl.updated_at) AS has_current_snapshot, s.unit_selling_price, s.order_total
       FROM line_calculation_snapshots s
       WHERE s.costing_line_id = cl.costing_line_id AND s.price_kind = COALESCE(cl.chosen_price_kind, 'PRODUCTION')
       ORDER BY s.created_at DESC LIMIT 1
     ) chosen ON true
     LEFT JOIN LATERAL (
       SELECT s.unit_selling_price, s.order_total FROM line_calculation_snapshots s
       WHERE s.costing_line_id = cl.costing_line_id AND s.price_kind = 'PRODUCTION'
       ORDER BY s.created_at DESC LIMIT 1
     ) production ON true
     LEFT JOIN LATERAL (
       SELECT s.unit_selling_price, s.order_total FROM line_calculation_snapshots s
       WHERE s.costing_line_id = cl.costing_line_id AND s.price_kind = 'TRADING'
       ORDER BY s.created_at DESC LIMIT 1
     ) trading ON true
     WHERE cl.costing_id = $1 AND cl.deleted_at IS NULL
     ORDER BY cl.line_no`,
    [id],
  );
  const lines = lineRows.map((r) => {
    const line = serializeCostingLine(r, r.chosen_has_current_snapshot ?? false);
    return {
      ...line,
      updatedAt: line.updatedAt.toISOString(),
      createdAt: line.createdAt.toISOString(),
      deletedAt: line.deletedAt?.toISOString() ?? null,
      latestUnitSellingPrice: r.chosen_unit_selling_price !== null ? Number(r.chosen_unit_selling_price) : null,
      latestOrderTotal: r.chosen_order_total !== null ? Number(r.chosen_order_total) : null,
      productionUnitSellingPrice:
        r.production_unit_selling_price !== null ? Number(r.production_unit_selling_price) : null,
      productionOrderTotal: r.production_order_total !== null ? Number(r.production_order_total) : null,
      tradingUnitSellingPrice: r.trading_unit_selling_price !== null ? Number(r.trading_unit_selling_price) : null,
      tradingOrderTotal: r.trading_order_total !== null ? Number(r.trading_order_total) : null,
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
