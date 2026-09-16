export type CostingHeaderRow = {
  costing_id: string;
  quotation_no: string | null;
  customer_id: string | null;
  customer_name_snapshot: string;
  customer_code_snapshot: string | null;
  owner_user_id: string;
  status: string;
  guide_version_id: string | null;
  revision_no: number;
  parent_costing_id: string | null;
  currency: string;
  tax_output_mode: string;
  validity_days: number;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  finalized_at: Date | null;
  voided_at: Date | null;
  deleted_at: Date | null;
  payment_terms_override: string | null;
  signed_by_name: string | null;
  signed_by_title: string | null;
  is_po: boolean;
  po_number: string | null;
  total_discount_type: "PERCENT" | "AMOUNT" | null;
  total_discount_value: string | null;
};

/**
 * `accountPaymentTerms` is the customer account default, resolved server-side
 * because the client would otherwise have to name-match against a customer
 * list it does not always have loaded.
 */
export function serializeCosting(
  row: CostingHeaderRow & { account_payment_terms?: string | null; account_markup_percent?: string | null },
  currentUserId: string,
) {
  const editableStatus = row.status === "draft" || row.status === "calculated";
  return {
    costingId: row.costing_id,
    quotationNo: row.quotation_no,
    customerId: row.customer_id,
    customerName: row.customer_name_snapshot,
    customerCode: row.customer_code_snapshot,
    ownerUserId: row.owner_user_id,
    status: row.status,
    guideVersionId: row.guide_version_id,
    revisionNo: row.revision_no,
    parentCostingId: row.parent_costing_id,
    currency: row.currency,
    taxOutputMode: row.tax_output_mode,
    validityDays: row.validity_days,
    paymentTermsOverride: row.payment_terms_override,
    signedByName: row.signed_by_name,
    signedByTitle: row.signed_by_title,
    accountPaymentTerms: row.account_payment_terms ?? null,
    /** The customer account's segment markup — read-only here (edited on the Customer record, not per-quotation). */
    accountMarkupPercent: row.account_markup_percent !== undefined && row.account_markup_percent !== null
      ? Number(row.account_markup_percent)
      : null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
    voidedAt: row.voided_at,
    deletedAt: row.deleted_at,
    isPo: row.is_po,
    poNumber: row.po_number,
    totalDiscountType: row.total_discount_type,
    totalDiscountValue: row.total_discount_value !== null ? Number(row.total_discount_value) : null,
    canEdit: editableStatus && row.owner_user_id === currentUserId,
    /** Only unissued work can be deleted; a finalized quotation is voided instead. */
    canDelete: editableStatus && row.owner_user_id === currentUserId,
  };
}
