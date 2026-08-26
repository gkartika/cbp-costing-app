import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { serializeCostingLine, type CostingLineRow } from "@/lib/costings/lines";
import { AppError, Errors } from "@/lib/errors";

/** Records AUD-017 (blocked mutation attempt) whenever an authorization check throws, then re-throws unchanged. */
async function assertAuthorized(
  check: () => void,
  ctx: { entityId: string; actorUserId: string; actorRole: string; requestId: string; action: string },
): Promise<void> {
  try {
    check();
  } catch (err) {
    if (err instanceof AppError) {
      await writeAuditEvent({
        action: "AUTHORIZATION_BLOCKED",
        entityType: "costing_headers",
        entityId: ctx.entityId,
        actorUserId: ctx.actorUserId,
        actorRole: ctx.actorRole,
        requestId: ctx.requestId,
        reason: `${ctx.action} blocked: ${err.code}`,
      });
    }
    throw err;
  }
}

async function loadCosting(costingId: string): Promise<CostingHeaderRow> {
  const { rows } = await pool.query<CostingHeaderRow & { account_payment_terms: string | null }>(
    `SELECT ch.*, c.payment_terms AS account_payment_terms
     FROM costing_headers ch LEFT JOIN customers c ON c.customer_id = ch.customer_id
     WHERE ch.costing_id = $1 AND ch.deleted_at IS NULL`,
    [costingId],
  );
  if (rows.length === 0) throw Errors.notFound("Costing");
  return rows[0];
}

export const GET = apiHandler(async (_req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.canViewCosting(user);
  const { id } = await ctx.params;
  const costing = await loadCosting(id);

  const { rows: lineRows } = await pool.query<
    CostingLineRow & {
      has_current_snapshot: boolean;
      unit_selling_price: string | null;
      order_total: string | null;
    }
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

  const lines = lineRows.map((r) => ({
    ...serializeCostingLine(r, r.has_current_snapshot ?? false),
    latestUnitSellingPrice: r.unit_selling_price !== null ? Number(r.unit_selling_price) : null,
    latestOrderTotal: r.order_total !== null ? Number(r.order_total) : null,
  }));

  return NextResponse.json({ ...serializeCosting(costing, user.userId), lines });
});

const PatchCostingSchema = z.object({
  expectedUpdatedAt: z.string(),
  customerName: z.string().min(1).max(200).optional(),
  validityDays: z.number().int().positive().optional(),
  /** Overrides the customer account default for this quotation only; null clears it. */
  paymentTermsOverride: z.string().max(300).nullable().optional(),
  /** Who signs the quotation; null falls back to the owner's display name. */
  signedByName: z.string().max(200).nullable().optional(),
  signedByTitle: z.string().max(200).nullable().optional(),
});

export const PATCH = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const body = PatchCostingSchema.safeParse(await req.json());
  if (!body.success) {
    throw Errors.validation("Data perubahan tidak valid.");
  }

  const before = await loadCosting(id);
  // Ownership/state check runs before the concurrency check: an unauthorized caller
  // must always see COSTING_READ_ONLY / COSTING_LOCKED, never a concurrency error
  // that would leak whether their guessed expectedUpdatedAt was stale.
  await assertAuthorized(
    () => policy.assertCanEditCosting(user, { ownerUserId: before.owner_user_id, status: before.status }),
    { entityId: id, actorUserId: user.userId, actorRole: primaryAuditRole(user), requestId, action: "COSTING_PATCH" },
  );

  if (new Date(body.data.expectedUpdatedAt).getTime() !== before.updated_at.getTime()) {
    throw Errors.staleUpdate();
  }

  const nextCustomerName = body.data.customerName ?? before.customer_name_snapshot;
  const nextValidityDays = body.data.validityDays ?? before.validity_days;
  const nextPaymentOverride =
    "paymentTermsOverride" in body.data ? (body.data.paymentTermsOverride?.trim() || null) : before.payment_terms_override;
  const nextSignedName =
    "signedByName" in body.data ? (body.data.signedByName?.trim() || null) : before.signed_by_name;
  const nextSignedTitle =
    "signedByTitle" in body.data ? (body.data.signedByTitle?.trim() || null) : before.signed_by_title;
  const changedFields: string[] = [];
  if (nextCustomerName !== before.customer_name_snapshot) changedFields.push("customerName");
  if (nextValidityDays !== before.validity_days) changedFields.push("validityDays");
  if (nextPaymentOverride !== before.payment_terms_override) changedFields.push("paymentTermsOverride");
  if (nextSignedName !== before.signed_by_name) changedFields.push("signedByName");
  if (nextSignedTitle !== before.signed_by_title) changedFields.push("signedByTitle");

  const after = await withTransaction(async (client) => {
    const { rows, rowCount } = await client.query<CostingHeaderRow>(
      `UPDATE costing_headers
         SET customer_name_snapshot = $1,
             validity_days = $2,
             payment_terms_override = $3,
             signed_by_name = $4,
             signed_by_title = $5,
             updated_at = now()
       WHERE costing_id = $6 AND updated_at = $7
       RETURNING *`,
      [nextCustomerName, nextValidityDays, nextPaymentOverride, nextSignedName, nextSignedTitle, id, before.updated_at],
    );
    if (rowCount === 0) {
      // Lost the race between our read and this write — another update committed first.
      throw Errors.staleUpdate();
    }

    if (changedFields.length > 0) {
      await writeAuditEvent(
        {
          action: "COSTING_UPDATED",
          entityType: "costing_headers",
          entityId: id,
          actorUserId: user.userId,
          actorRole: primaryAuditRole(user),
          requestId,
          beforeJson: { customerName: before.customer_name_snapshot, validityDays: before.validity_days },
          afterJson: { customerName: nextCustomerName, validityDays: nextValidityDays },
          changedFields,
        },
        client,
      );
    }

    return rows[0];
  });

  return NextResponse.json(serializeCosting(after, user.userId));
});

/**
 * Soft-deletes a Draft/Calculated costing so it leaves the dashboard without
 * leaving the audit trail: audit_events and snapshots keep referencing this id,
 * and DEC-004's reconstructable-history guarantee depends on the row surviving.
 * Finalized/Revised costings are never deletable — those are Voided instead.
 */
export const DELETE = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const before = await loadCosting(id);
  await assertAuthorized(
    () => policy.assertCanDeleteCosting(user, { ownerUserId: before.owner_user_id, status: before.status }),
    { entityId: id, actorUserId: user.userId, actorRole: primaryAuditRole(user), requestId, action: "COSTING_DELETE" },
  );

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE costing_headers SET deleted_at = now(), deleted_by = $1, updated_at = now()
       WHERE costing_id = $2 AND deleted_at IS NULL`,
      [user.userId, id],
    );
    await writeAuditEvent(
      {
        action: "COSTING_DELETED",
        entityType: "costing_headers",
        entityId: id,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        beforeJson: { status: before.status, quotationNo: before.quotation_no },
      },
      client,
    );
  });

  return NextResponse.json({ ok: true });
});
