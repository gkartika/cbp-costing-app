import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { pool } from "@/lib/db";

/**
 * Names of active users, for the Salesperson picker on a quotation.
 *
 * Deliberately separate from /api/admin/users (Super Admin only): that route
 * manages accounts and exposes roles and reset state, while this one returns
 * nothing but a display name. Every authenticated user can already see who
 * owns each costing, so a name list adds no visibility they lack.
 */
export const GET = apiHandler(async () => {
  await requireUser();

  const { rows } = await pool.query<{ user_id: string; display_name: string }>(
    `SELECT user_id, display_name FROM users WHERE active = TRUE ORDER BY display_name`,
  );

  return NextResponse.json({
    users: rows.map((r) => ({ userId: r.user_id, displayName: r.display_name })),
  });
});
