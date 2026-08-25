import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { pool } from "@/lib/db";

export const GET = apiHandler(async () => {
  await requireUser();

  const { rows } = await pool.query<{ customer_id: string; customer_name: string; customer_code: string | null }>(
    `SELECT customer_id, customer_name, customer_code FROM customers WHERE active = TRUE ORDER BY customer_name`,
  );

  return NextResponse.json({
    customers: rows.map((r) => ({ customerId: r.customer_id, customerName: r.customer_name, customerCode: r.customer_code })),
  });
});
