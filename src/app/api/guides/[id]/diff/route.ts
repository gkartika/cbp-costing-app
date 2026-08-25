import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { diffGuideVersions } from "@/lib/guide/diffGuide";
import { Errors } from "@/lib/errors";

export const GET = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertCanViewGuideDiff(user);
  const { id } = await ctx.params;
  const compareTo = req.nextUrl.searchParams.get("compareTo");
  if (!compareTo) throw Errors.validation("Parameter compareTo wajib diisi.");

  const diff = await diffGuideVersions(compareTo, id);
  return NextResponse.json({ baseVersionId: compareTo, targetVersionId: id, tabs: diff });
});
