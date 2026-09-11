import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { bulkImportCustomers, CUSTOMER_SEGMENTS } from "@/lib/costings/customers";
import { Errors } from "@/lib/errors";

/**
 * Loads a customer masterlist (parsed client-side from a pasted CSV) in one
 * request. Super Admin only, same bar as single-record editing, since a row
 * can carry segment/markup/payment terms — the fields that action gates.
 */
const BulkImportRowSchema = z.object({
  customerName: z.string().min(1).max(200),
  customerCode: z.string().max(50).nullable().optional(),
  segment: z.enum(CUSTOMER_SEGMENTS).nullable().optional(),
  markupPercent: z.number().gt(-1).max(10).nullable().optional(),
  paymentTerms: z.string().max(500).nullable().optional(),
});

const BulkImportSchema = z.object({
  rows: z.array(BulkImportRowSchema).min(1).max(2000),
});

export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  policy.assertCanEditCustomer(user);
  const requestId = getRequestId(req);

  const body = BulkImportSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Data import tidak valid.");

  const results = await bulkImportCustomers(body.data.rows, {
    actorUserId: user.userId,
    actorRole: primaryAuditRole(user),
    requestId,
  });

  return NextResponse.json({
    results,
    summary: {
      created: results.filter((r) => r.outcome === "created").length,
      updated: results.filter((r) => r.outcome === "updated").length,
      errors: results.filter((r) => r.outcome === "error").length,
    },
  });
});
