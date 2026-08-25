import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { publishPendingChangesForTable } from "@/lib/masterdata/pendingChanges";
import { AppError } from "@/lib/errors";
import type { ValidationReport } from "@/lib/guide/validateGuide";

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);
  const { table } = await ctx.params;

  try {
    const result = await publishPendingChangesForTable(table, user.userId, requestId);
    return NextResponse.json({ published: true, ...result });
  } catch (err) {
    // A failed golden-simulation/formula/range check is expected admin
    // feedback (the pending changes stay queued, untouched) — surface the
    // itemized report instead of a generic error, same as guide validate.
    if (err instanceof AppError && (err as AppError & { report?: ValidationReport }).report) {
      return NextResponse.json(
        { published: false, report: (err as AppError & { report?: ValidationReport }).report },
        { status: 422 },
      );
    }
    throw err;
  }
});
