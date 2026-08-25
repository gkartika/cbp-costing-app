import { pool } from "@/lib/db";
import type { CostingHeaderRow } from "./types";

export type QuotationLine = {
  lineNo: number;
  description: string | null;
  qty: number;
  unitSellingPrice: number;
  orderTotal: number;
};

export type QuotationDocument = {
  quotationNo: string | null;
  customerName: string;
  currency: string;
  taxOutputMode: string;
  validityDays: number;
  revisionNo: number;
  finalizedAt: Date | null;
  lines: QuotationLine[];
  totalExPpn: number;
};

/**
 * Builds the quotation document from current data. Used for both the
 * in-Workspace Preview (any status, read-only, never audited — AUD-016
 * explicitly says not to log ordinary screen views) and as the source data
 * for the real XLSX export (Finalized/Revised only, always audited).
 */
export async function buildQuotationDocument(header: CostingHeaderRow): Promise<QuotationDocument> {
  const { rows } = await pool.query<{
    line_no: number;
    description: string | null;
    qty: number | null;
    unit_selling_price: string | null;
    order_total: string | null;
  }>(
    `SELECT cl.line_no, cl.description, cl.qty, s.unit_selling_price, s.order_total
     FROM costing_lines cl
     LEFT JOIN LATERAL (
       SELECT unit_selling_price, order_total FROM line_calculation_snapshots
       WHERE costing_line_id = cl.costing_line_id ORDER BY created_at DESC LIMIT 1
     ) s ON true
     WHERE cl.costing_id = $1 AND cl.deleted_at IS NULL
     ORDER BY cl.line_no`,
    [header.costing_id],
  );

  const lines: QuotationLine[] = rows.map((l) => ({
    lineNo: l.line_no,
    description: l.description,
    qty: l.qty ?? 0,
    unitSellingPrice: l.unit_selling_price !== null ? Number(l.unit_selling_price) : 0,
    orderTotal: l.order_total !== null ? Number(l.order_total) : 0,
  }));

  return {
    quotationNo: header.quotation_no,
    customerName: header.customer_name_snapshot,
    currency: header.currency,
    taxOutputMode: header.tax_output_mode,
    validityDays: header.validity_days,
    revisionNo: header.revision_no,
    finalizedAt: header.finalized_at,
    lines,
    totalExPpn: lines.reduce((sum, l) => sum + l.orderTotal, 0),
  };
}
