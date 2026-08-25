import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser, primaryAuditRole } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { parseAndStageBulkImport } from "@/lib/masterdata/bulkImport";
import { Errors } from "@/lib/errors";

const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

export const POST = apiHandler(async (req: NextRequest, ctx) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);
  const { table } = await ctx.params;

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw Errors.validation("File .xlsx wajib diisi.");
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw Errors.guideSchemaInvalid("File harus berformat .xlsx");
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw Errors.validation(`File terlalu besar (maksimum ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MB).`);
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const result = await parseAndStageBulkImport({
    tableName: table,
    fileBuffer,
    actorUserId: user.userId,
    actorRole: primaryAuditRole(user),
    requestId,
  });

  return NextResponse.json(result, { status: 201 });
});
