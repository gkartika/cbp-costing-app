import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { validateGuideVersion, type ValidationReport } from "@/lib/guide/validateGuide";
import { AppError } from "@/lib/errors";

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  try {
    const report = await validateGuideVersion(id, user.userId, requestId);
    return NextResponse.json({ valid: true, report });
  } catch (err) {
    // A failed validation is expected admin feedback, not a server error —
    // surface the full itemized report (which formulas/ranges/golden cases
    // failed and why) rather than the generic sanitized error message.
    if (err instanceof AppError && (err as AppError & { report?: ValidationReport }).report) {
      return NextResponse.json(
        { valid: false, report: (err as AppError & { report?: ValidationReport }).report },
        { status: 422 },
      );
    }
    throw err;
  }
});
