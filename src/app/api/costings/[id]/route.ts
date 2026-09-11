import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { resolveOrCreateCustomer } from "@/lib/costings/customers";
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
  /** Selecting an existing customer from the picker — precise, no name-matching. */
  customerId: z.string().optional(),
  /** Either the free-text "new customer" path (resolved/created by exact name, same as costing creation), or a display-only rename when it matches customerId's own row. */
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

  const nextValidityDays = body.data.validityDays ?? before.validity_days;
  const nextPaymentOverride =
    "paymentTermsOverride" in body.data ? (body.data.paymentTermsOverride?.trim() || null) : before.payment_terms_override;
  const nextSignedName =
    "signedByName" in body.data ? (body.data.signedByName?.trim() || null) : before.signed_by_name;
  const nextSignedTitle =
    "signedByTitle" in body.data ? (body.data.signedByTitle?.trim() || null) : before.signed_by_title;

  const after = await withTransaction(async (client) => {
    // Resolving to a real customer_id here (not just renaming the display
    // snapshot) was missing entirely before -- the picker could select an
    // existing customer, or type a new name, but this route only ever wrote
    // customer_name_snapshot, so costing_headers.customer_id stayed whatever
    // it was at creation (usually null, since "+ New Costing" starts blank).
    // Everything that keys off customer_id -- the per-customer markup at
    // calculate time chief among them -- silently saw no customer at all.
    // Resolving here also self-heals any older costing the next time its
    // customer is touched, the same as resolveOrCreateCustomer already does
    // for new costings.
    let nextCustomerId = before.customer_id;
    let nextCustomerName = before.customer_name_snapshot;
    let nextCustomerCode = before.customer_code_snapshot;
    if (body.data.customerId) {
      const { rows: custRows } = await client.query<{ customer_id: string; customer_name: string; customer_code: string | null }>(
        `SELECT customer_id, customer_name, customer_code FROM customers WHERE customer_id = $1 AND active = TRUE`,
        [body.data.customerId],
      );
      if (custRows.length === 0) throw Errors.notFound("Customer");
      nextCustomerId = custRows[0].customer_id;
      nextCustomerName = custRows[0].customer_name;
      nextCustomerCode = custRows[0].customer_code;
    } else if (body.data.customerName) {
      const customer = await resolveOrCreateCustomer(client, {
        customerName: body.data.customerName.trim(),
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
      });
      nextCustomerId = customer.customerId;
      nextCustomerName = customer.customerName;
      nextCustomerCode = customer.customerCode;
    }

    const changedFields: string[] = [];
    if (nextCustomerId !== before.customer_id) changedFields.push("customerId");
    if (nextCustomerName !== before.customer_name_snapshot) changedFields.push("customerName");
    if (nextValidityDays !== before.validity_days) changedFields.push("validityDays");
    if (nextPaymentOverride !== before.payment_terms_override) changedFields.push("paymentTermsOverride");
    if (nextSignedName !== before.signed_by_name) changedFields.push("signedByName");
    if (nextSignedTitle !== before.signed_by_title) changedFields.push("signedByTitle");

    const { rows, rowCount } = await client.query<CostingHeaderRow>(
      `UPDATE costing_headers
         SET customer_id = $1,
             customer_name_snapshot = $2,
             customer_code_snapshot = $3,
             validity_days = $4,
             payment_terms_override = $5,
             signed_by_name = $6,
             signed_by_title = $7,
             updated_at = now()
       WHERE costing_id = $8 AND updated_at = $9
       RETURNING *`,
      [
        nextCustomerId,
        nextCustomerName,
        nextCustomerCode,
        nextValidityDays,
        nextPaymentOverride,
        nextSignedName,
        nextSignedTitle,
        id,
        before.updated_at,
      ],
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
          beforeJson: { customerId: before.customer_id, customerName: before.customer_name_snapshot, validityDays: before.validity_days },
          afterJson: { customerId: nextCustomerId, customerName: nextCustomerName, validityDays: nextValidityDays },
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
