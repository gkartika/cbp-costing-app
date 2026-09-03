import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { updateCustomer, serializeCustomer, CUSTOMER_SEGMENTS } from "@/lib/costings/customers";
import { Errors } from "@/lib/errors";

/**
 * Editing an existing customer — name, code, segment, markup, payment terms —
 * is Super Admin only (business decision 2026-09-04). Creating a new one
 * (POST /api/customers) is a separate, wider-open action.
 */
const PatchCustomerSchema = z.object({
  customerName: z.string().min(1).max(200).optional(),
  customerCode: z.string().max(50).nullable().optional(),
  segment: z.enum(CUSTOMER_SEGMENTS).nullable().optional(),
  // A fraction like the rest of the calc engine's adjustments (0.05 = +5%),
  // not a whole percent — matches marginPercent/weightTolerancePercent.
  markupPercent: z.number().gt(-1).max(10).nullable().optional(),
  paymentTerms: z.string().max(500).nullable().optional(),
});

export const PATCH = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertCanEditCustomer(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const body = PatchCustomerSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Data customer tidak valid.");
  if (Object.keys(body.data).length === 0) throw Errors.validation("Tidak ada perubahan.");

  const row = await updateCustomer(id, body.data, {
    actorUserId: user.userId,
    actorRole: primaryAuditRole(user),
    requestId,
  });

  return NextResponse.json(serializeCustomer(row));
});
