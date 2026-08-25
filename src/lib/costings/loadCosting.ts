import { pool } from "@/lib/db";
import { Errors } from "@/lib/errors";
import type { CostingHeaderRow } from "./types";

/**
 * A soft-deleted costing is treated as gone for every normal read and mutation
 * path — the row survives only so audit_events and snapshots keep resolving,
 * not so the record stays reachable.
 */
export async function loadCostingHeader(costingId: string): Promise<CostingHeaderRow> {
  const { rows } = await pool.query<CostingHeaderRow>(
    `SELECT * FROM costing_headers WHERE costing_id = $1 AND deleted_at IS NULL`,
    [costingId],
  );
  if (rows.length === 0) throw Errors.notFound("Costing");
  return rows[0];
}
