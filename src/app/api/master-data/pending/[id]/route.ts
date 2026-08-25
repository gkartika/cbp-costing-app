import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { discardPendingChange } from "@/lib/masterdata/pendingChanges";

export const DELETE = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  await discardPendingChange(id, user.userId, primaryAuditRole(user), requestId);
  return NextResponse.json({ ok: true });
});
