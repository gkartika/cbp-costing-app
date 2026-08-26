import { pool } from "@/lib/db";

export type ReportFilters = {
  /** Matches customer_name_snapshot case-insensitively; blank means all customers. */
  customer?: string;
  /** Inclusive ISO dates (yyyy-mm-dd) against created_at, interpreted in Asia/Jakarta. */
  dateFrom?: string;
  dateTo?: string;
  /** Empty means every status except deleted. */
  statuses?: string[];
  /** Matches the effective salesperson — the tagged name, else the owner. */
  salesperson?: string;
  poFilter?: "all" | "po" | "no_po";
};

export type ReportSummaryRow = {
  costingId: string;
  createdAt: string;
  customerName: string;
  quotationNo: string | null;
  status: string;
  ownerName: string;
  /** Who the quotation is credited to, resolved the same way the document prints it. */
  salesperson: string;
  totalNominal: number | null;
  isPo: boolean;
  poNumber: string | null;
};

export type ReportLineRow = {
  costingId: string;
  quotationNo: string | null;
  customerName: string;
  lineNo: number;
  description: string | null;
  productFamily: string | null;
  gradeInput: string | null;
  sizeLabel: string | null;
  qty: number | null;
  unitSellingPrice: number | null;
  orderTotal: number | null;
};

export type ReportResult = {
  summary: ReportSummaryRow[];
  lines: ReportLineRow[];
  totals: { costingCount: number; poCount: number; grandTotal: number; poTotal: number };
};

export const REPORTABLE_STATUSES = ["draft", "calculated", "finalized", "revised", "voided"] as const;

/**
 * Builds the WHERE clause shared by both sheets so the summary and the line
 * detail can never disagree about which costings are in scope.
 *
 * Dates are compared in Asia/Jakarta (04_DATA_MODEL's display zone): a user
 * asking for "August" means Jakarta-August, and comparing a UTC timestamp
 * directly would pull in or drop the boundary evening depending on offset.
 */
function buildWhere(filters: ReportFilters): { clause: string; params: unknown[] } {
  const conditions = ["ch.deleted_at IS NULL"];
  const params: unknown[] = [];

  if (filters.customer?.trim()) {
    params.push(`%${filters.customer.trim()}%`);
    conditions.push(`ch.customer_name_snapshot ILIKE $${params.length}`);
  }
  if (filters.dateFrom) {
    params.push(filters.dateFrom);
    conditions.push(`(ch.created_at AT TIME ZONE 'Asia/Jakarta')::date >= $${params.length}::date`);
  }
  if (filters.dateTo) {
    params.push(filters.dateTo);
    conditions.push(`(ch.created_at AT TIME ZONE 'Asia/Jakarta')::date <= $${params.length}::date`);
  }
  if (filters.statuses && filters.statuses.length > 0) {
    params.push(filters.statuses);
    conditions.push(`ch.status = ANY($${params.length}::text[])`);
  }
  if (filters.salesperson?.trim()) {
    params.push(`%${filters.salesperson.trim()}%`);
    // Matches whatever the quotation actually prints: the tagged salesperson
    // when set, otherwise the owner the document falls back to.
    conditions.push(`COALESCE(ch.signed_by_name, u.display_name) ILIKE $${params.length}`);
  }
  if (filters.poFilter === "po") conditions.push("ch.is_po = TRUE");
  else if (filters.poFilter === "no_po") conditions.push("ch.is_po = FALSE");

  return { clause: conditions.join(" AND "), params };
}

export async function buildReport(filters: ReportFilters): Promise<ReportResult> {
  const { clause, params } = buildWhere(filters);

  // Same latest-snapshot-per-line join the dashboard and detail route use, so
  // a reported total always equals what those screens show.
  const { rows: summaryRows } = await pool.query<{
    costing_id: string;
    created_at: Date;
    customer_name_snapshot: string;
    quotation_no: string | null;
    status: string;
    owner_name: string | null;
    owner_user_id: string;
    salesperson: string;
    total_nominal: string | null;
    is_po: boolean;
    po_number: string | null;
  }>(
    `SELECT ch.costing_id, ch.created_at, ch.customer_name_snapshot, ch.quotation_no, ch.status,
            u.display_name AS owner_name, ch.owner_user_id, ch.is_po, ch.po_number,
            COALESCE(ch.signed_by_name, u.display_name, ch.owner_user_id) AS salesperson,
            totals.total_nominal
     FROM costing_headers ch
     LEFT JOIN users u ON u.user_id = ch.owner_user_id
     LEFT JOIN LATERAL (
       SELECT SUM(latest.order_total) AS total_nominal
       FROM costing_lines cl
       JOIN LATERAL (
         SELECT s.order_total FROM line_calculation_snapshots s
         WHERE s.costing_line_id = cl.costing_line_id
         ORDER BY s.created_at DESC LIMIT 1
       ) latest ON true
       WHERE cl.costing_id = ch.costing_id AND cl.deleted_at IS NULL
     ) totals ON true
     WHERE ${clause}
     ORDER BY ch.created_at DESC`,
    params,
  );

  const { rows: lineRows } = await pool.query<{
    costing_id: string;
    quotation_no: string | null;
    customer_name_snapshot: string;
    line_no: number;
    description: string | null;
    product_family: string | null;
    grade_input: string | null;
    size_label: string | null;
    qty: number | null;
    unit_selling_price: string | null;
    order_total: string | null;
  }>(
    `SELECT ch.costing_id, ch.quotation_no, ch.customer_name_snapshot,
            cl.line_no, cl.description, cl.product_family, cl.grade_input, cl.size_label, cl.qty,
            latest.unit_selling_price, latest.order_total
     FROM costing_headers ch
     LEFT JOIN users u ON u.user_id = ch.owner_user_id
     JOIN costing_lines cl ON cl.costing_id = ch.costing_id AND cl.deleted_at IS NULL
     LEFT JOIN LATERAL (
       SELECT s.unit_selling_price, s.order_total FROM line_calculation_snapshots s
       WHERE s.costing_line_id = cl.costing_line_id
       ORDER BY s.created_at DESC LIMIT 1
     ) latest ON true
     WHERE ${clause}
     ORDER BY ch.created_at DESC, cl.line_no`,
    params,
  );

  const summary: ReportSummaryRow[] = summaryRows.map((r) => ({
    costingId: r.costing_id,
    createdAt: r.created_at.toISOString(),
    customerName: r.customer_name_snapshot,
    quotationNo: r.quotation_no,
    status: r.status,
    ownerName: r.owner_name ?? r.owner_user_id,
    salesperson: r.salesperson,
    totalNominal: r.total_nominal !== null ? Number(r.total_nominal) : null,
    isPo: r.is_po,
    poNumber: r.po_number,
  }));

  const lines: ReportLineRow[] = lineRows.map((r) => ({
    costingId: r.costing_id,
    quotationNo: r.quotation_no,
    customerName: r.customer_name_snapshot,
    lineNo: r.line_no,
    description: r.description,
    productFamily: r.product_family,
    gradeInput: r.grade_input,
    sizeLabel: r.size_label,
    qty: r.qty,
    unitSellingPrice: r.unit_selling_price !== null ? Number(r.unit_selling_price) : null,
    orderTotal: r.order_total !== null ? Number(r.order_total) : null,
  }));

  return {
    summary,
    lines,
    totals: {
      costingCount: summary.length,
      poCount: summary.filter((s) => s.isPo).length,
      grandTotal: summary.reduce((sum, s) => sum + (s.totalNominal ?? 0), 0),
      poTotal: summary.filter((s) => s.isPo).reduce((sum, s) => sum + (s.totalNominal ?? 0), 0),
    },
  };
}
