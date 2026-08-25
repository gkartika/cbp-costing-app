import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { publishGuideVersion } from "@/lib/guide/publishGuide";

const PublishSchema = z.object({ effectiveFrom: z.string().datetime().optional() });

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);
  const { id } = await ctx.params;

  const body = PublishSchema.safeParse(await req.json().catch(() => ({})));
  const effectiveFrom = body.success && body.data.effectiveFrom ? new Date(body.data.effectiveFrom) : undefined;

  await publishGuideVersion(id, user.userId, requestId, effectiveFrom);
  return NextResponse.json({ ok: true });
});
