import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { listActiveRows } from "@/lib/masterdata/browse";

/** Browse the currently-Published, currently-active rows of one master table — the "Price Book" view. Read-only for any authenticated user (needed to explain a calculation), not just Super Admin. */
export const GET = apiHandler(async (_req: NextRequest, ctx) => {
  await requireUser();
  const { table } = await ctx.params;
  const data = await listActiveRows(table);
  return NextResponse.json(data);
});
