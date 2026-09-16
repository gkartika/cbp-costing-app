import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { pool } from "@/lib/db";

/**
 * A minimal, any-authenticated-user directory (id + display name only) for
 * populating pickers like the Reports salesperson filter — unlike
 * /api/admin/users, this carries no roles/status and isn't Super Admin gated,
 * matching the "everyone reads everything" read model already used for
 * costings and customers.
 */
export const GET = apiHandler(async () => {
  await requireUser();

  const { rows } = await pool.query<{ user_id: string; display_name: string }>(
    `SELECT user_id, display_name FROM users WHERE active = TRUE ORDER BY display_name`,
  );

  return NextResponse.json({ users: rows.map((r) => ({ userId: r.user_id, displayName: r.display_name })) });
});
