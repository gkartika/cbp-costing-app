import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { resolveOrCreateCustomer } from "@/lib/costings/customers";
import { serializeCosting, type CostingHeaderRow } from "@/lib/costings/types";
import { Errors } from "@/lib/errors";

// All costing users can see all current and historical costings (DEC-018); read is never owner-scoped.
export const GET = apiHandler(async () => {
  const user = await requireUser();
  policy.canViewCosting(user);

  const { rows } = await pool.query<CostingHeaderRow>(
    `SELECT * FROM costing_headers ORDER BY created_at DESC LIMIT 200`,
  );
  return NextResponse.json({ costings: rows.map((r) => serializeCosting(r, user.userId)) });
});

// Customer is required before Finalize (field dictionary: "required" fields
// need not be set at initial Draft creation, only before the state
// transition that depends on them — see finalize/route.ts).
const CreateCostingSchema = z.object({
  customerName: z.string().max(200).optional(),
  customerCode: z.string().max(64).optional(),
});

export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  policy.assertCanCreateCosting(user);
  const requestId = getRequestId(req);

  const body = CreateCostingSchema.safeParse(await req.json());
  if (!body.success) {
    throw Errors.validation("Data customer tidak valid.");
  }
  const customerName = body.data.customerName?.trim() ?? "";

  const costing = await withTransaction(async (client) => {
    const customer = customerName
      ? await resolveOrCreateCustomer(client, {
          customerName,
          customerCode: body.data.customerCode ?? null,
          actorUserId: user.userId,
          actorRole: primaryAuditRole(user),
          requestId,
        })
      : { customerId: null, customerName: "", customerCode: null };

    const costingId = generateId("cst");
    const { rows } = await client.query<CostingHeaderRow>(
      `INSERT INTO costing_headers
         (costing_id, customer_id, customer_name_snapshot, customer_code_snapshot,
          owner_user_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING *`,
      [costingId, customer.customerId, customer.customerName, customer.customerCode, user.userId],
    );

    await writeAuditEvent(
      {
        action: "COSTING_CREATED",
        entityType: "costing_headers",
        entityId: costingId,
        actorUserId: user.userId,
        actorRole: primaryAuditRole(user),
        requestId,
        afterJson: { customerId: customer.customerId, customerName: customer.customerName, ownerUserId: user.userId },
      },
      client,
    );

    return rows[0];
  });

  return NextResponse.json(serializeCosting(costing, user.userId), { status: 201 });
});
