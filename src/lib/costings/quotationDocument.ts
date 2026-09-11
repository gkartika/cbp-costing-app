import { pool } from "@/lib/db";
import type { CostingHeaderRow } from "./types";
import { DEFAULT_PAYMENT_TERMS } from "./paymentTerms";

export type QuotationComponent = {
  description: string | null;
  qtyPerSet: number;
};

export type QuotationLine = {
  lineNo: number;
  description: string | null;
  qty: number;
  unitSellingPrice: number;
  orderTotal: number;
  /** Non-empty only for a set line — what the assembly is made of (DEC-017). */
  components: QuotationComponent[];
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
  /** CBP's standard terms, in published order (DEC-016). */
  terms: string[];
  /** Negotiated per account; the costing's own override wins when set. */
  /** Never actually null — falls back to DEFAULT_PAYMENT_TERMS when nothing more specific is set. */
  paymentTerms: string;
  /** Who signs the letter: the costing's own signatory when set, else the owner. */
  preparedBy: string | null;
  preparedByTitle: string | null;
};

/**
 * Builds the quotation document from current data. Used for both the
 * in-Workspace Preview (any status, read-only, never audited — AUD-016
 * explicitly says not to log ordinary screen views) and as the source data
 * for the real XLSX export (Finalized/Revised only, always audited).
 */
export async function buildQuotationDocument(header: CostingHeaderRow): Promise<QuotationDocument> {
  // A set is quoted as one line at its set price; the components below it are
  // printed as a breakdown of what the customer gets, not as priced lines
  // (DEC-017). Selecting only top-level rows is what keeps the document total
  // equal to the dashboard and report totals.
  const { rows } = await pool.query<{
    costing_line_id: string;
    line_no: number;
    description: string | null;
    qty: number | null;
    unit_selling_price: string | null;
    order_total: string | null;
  }>(
    `SELECT cl.costing_line_id, cl.line_no, cl.description, cl.qty, s.unit_selling_price, s.order_total
     FROM costing_lines cl
     LEFT JOIN LATERAL (
       SELECT unit_selling_price, order_total FROM line_calculation_snapshots
       WHERE costing_line_id = cl.costing_line_id ORDER BY created_at DESC LIMIT 1
     ) s ON true
     WHERE cl.costing_id = $1 AND cl.deleted_at IS NULL AND cl.parent_line_id IS NULL
     ORDER BY cl.line_no`,
    [header.costing_id],
  );

  // A component with no description falls back to family/grade/size rather
  // than printing an empty bullet — the breakdown exists to tell the customer
  // what is in the assembly, and "—" tells them nothing.
  const { rows: componentRows } = await pool.query<{
    parent_line_id: string;
    description: string | null;
    qty_per_set: number | null;
  }>(
    `SELECT cl.parent_line_id,
            COALESCE(
              NULLIF(cl.description, ''),
              NULLIF(TRIM(CONCAT_WS(' ', cl.product_family, cl.grade_input, cl.size_label)), '')
            ) AS description,
            cl.qty_per_set
     FROM costing_lines cl
     JOIN costing_lines parent ON parent.costing_line_id = cl.parent_line_id
     WHERE parent.costing_id = $1 AND cl.deleted_at IS NULL AND cl.parent_line_id IS NOT NULL
     ORDER BY cl.line_no`,
    [header.costing_id],
  );
  const componentsByParent = new Map<string, QuotationComponent[]>();
  for (const c of componentRows) {
    const entry = { description: c.description, qtyPerSet: c.qty_per_set ?? 1 };
    const existing = componentsByParent.get(c.parent_line_id);
    if (existing) existing.push(entry);
    else componentsByParent.set(c.parent_line_id, [entry]);
  }

  // Components share the costing's line_no sequence, so top-level numbers have
  // gaps once a set is added. The customer sees a clean 1..N.
  const lines: QuotationLine[] = rows.map((l, i) => ({
    lineNo: i + 1,
    description: l.description,
    qty: l.qty ?? 0,
    unitSellingPrice: l.unit_selling_price !== null ? Number(l.unit_selling_price) : 0,
    orderTotal: l.order_total !== null ? Number(l.order_total) : 0,
    components: componentsByParent.get(l.costing_line_id) ?? [],
  }));

  // Terms come from the guide version this costing was priced against, so a
  // reprinted past quotation shows the wording that was in force at the time.
  //
  // Two cases fall back to the active version: a costing not yet calculated
  // (Preview on a fresh draft has no pinned version), and a costing pinned to
  // a version published before quotation_terms existed. Without the second
  // fallback every pre-existing quotation would reprint with an empty terms
  // block — worse than showing current wording, since terms are boilerplate
  // and carry none of the priced values that pinning exists to protect.
  const { rows: termRows } = await pool.query<{ term_text: string }>(
    `WITH pinned AS (
       SELECT term_text, sort_order FROM quotation_terms
       WHERE guide_version_id = $1 AND active
     ), fallback AS (
       SELECT term_text, sort_order FROM quotation_terms
       WHERE guide_version_id = (SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1)
         AND active
     )
     SELECT term_text FROM (
       SELECT * FROM pinned
       UNION ALL
       SELECT * FROM fallback WHERE NOT EXISTS (SELECT 1 FROM pinned)
     ) t
     ORDER BY sort_order`,
    [header.guide_version_id],
  );

  const { rows: paymentRows } = await pool.query<{ payment_terms: string | null }>(
    `SELECT payment_terms FROM customers WHERE customer_id = $1`,
    [header.customer_id],
  );

  const { rows: ownerRows } = await pool.query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE user_id = $1`,
    [header.owner_user_id],
  );

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
    terms: termRows.map((t) => t.term_text),
    paymentTerms: header.payment_terms_override ?? paymentRows[0]?.payment_terms ?? DEFAULT_PAYMENT_TERMS,
    preparedBy: header.signed_by_name ?? ownerRows[0]?.display_name ?? null,
    preparedByTitle: header.signed_by_title ?? null,
  };
}
