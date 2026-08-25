import { pool } from "@/lib/db";
import { Errors } from "@/lib/errors";
import type { CostingHeaderRow } from "./types";

export async function loadCostingHeader(costingId: string): Promise<CostingHeaderRow> {
  const { rows } = await pool.query<CostingHeaderRow>(
    `SELECT * FROM costing_headers WHERE costing_id = $1`,
    [costingId],
  );
  if (rows.length === 0) throw Errors.notFound("Costing");
  return rows[0];
}
