import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { listPendingChanges, stagePendingChange } from "@/lib/masterdata/pendingChanges";
import { Errors } from "@/lib/errors";

export const GET = apiHandler(async (_req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const { table } = await ctx.params;
  const changes = await listPendingChanges(table);
  return NextResponse.json({ changes });
});

const StageChangeSchema = z.object({
  operation: z.enum(["create", "update", "deactivate"]),
  sourceKey: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).nullable().optional(),
  reason: z.string().max(500).optional(),
});

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);
  const { table } = await ctx.params;

  const body = StageChangeSchema.safeParse(await req.json());
  if (!body.success) throw Errors.validation("Data perubahan tidak valid.");

  if (body.data.operation !== "deactivate" && !body.data.fields) {
    throw Errors.validation("Field yang diubah wajib diisi.");
  }

  const change = await stagePendingChange({
    tableName: table,
    operation: body.data.operation,
    sourceKey: body.data.sourceKey,
    fields: body.data.fields ?? null,
    reason: body.data.reason ?? null,
    actorUserId: user.userId,
    actorRole: primaryAuditRole(user),
    requestId,
  });

  return NextResponse.json(change, { status: 201 });
});
