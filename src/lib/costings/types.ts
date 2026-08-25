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
};

export function serializeCosting(row: CostingHeaderRow, currentUserId: string) {
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
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finalizedAt: row.finalized_at,
    voidedAt: row.voided_at,
    canEdit: editableStatus && row.owner_user_id === currentUserId,
  };
}
