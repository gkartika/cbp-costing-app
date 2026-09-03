import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { createCustomer, serializeCustomer, type CustomerRow } from "@/lib/costings/customers";
import { pool } from "@/lib/db";
import { Errors } from "@/lib/errors";

export const GET = apiHandler(async () => {
  await requireUser();

  const { rows } = await pool.query<CustomerRow>(`SELECT * FROM customers WHERE active = TRUE ORDER BY customer_name`);

  return NextResponse.json({ customers: rows.map(serializeCustomer) });
});

const CreateCustomerSchema = z.object({
  customerName: z.string().min(1).max(200),
  customerCode: z.string().max(50).optional(),
});

export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  policy.assertCanCreateCustomer(user);
  const requestId = getRequestId(req);

  const body = CreateCustomerSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Data customer tidak valid.");

  const row = await createCustomer({
    customerName: body.data.customerName,
    customerCode: body.data.customerCode,
    actorUserId: user.userId,
    actorRole: primaryAuditRole(user),
    requestId,
  });

  return NextResponse.json(serializeCustomer(row), { status: 201 });
});
