import { NextRequest, NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { getRequestId, requireUser } from "@/lib/http/requestContext";
import { policy } from "@/lib/authz/policy";
import { importGuidePackage } from "@/lib/guide/importGuide";
import { Errors } from "@/lib/errors";

// A legitimate CBP guide package (a few dozen master-data tabs) is a few MB at
// most; this bounds worst-case memory use from an oversized/malicious upload.
const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;

export const POST = apiHandler(async (req: NextRequest) => {
  const user = await requireUser();
  policy.assertIsSuperAdmin(user);
  const requestId = getRequestId(req);

  const formData = await req.formData();
  const file = formData.get("file");
  const versionCode = formData.get("versionCode");
  if (!(file instanceof File) || typeof versionCode !== "string" || versionCode.trim() === "") {
    throw Errors.validation("File .xlsx dan version code wajib diisi.");
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw Errors.guideSchemaInvalid("File harus berformat .xlsx");
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw Errors.validation(
      `File terlalu besar (maksimum ${MAX_IMPORT_FILE_BYTES / (1024 * 1024)} MB).`,
    );
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const result = await importGuidePackage({
    fileBuffer,
    originalFilename: file.name,
    versionCode: versionCode.trim(),
    uploadedBy: user.userId,
    requestId,
  });

  return NextResponse.json(
    { guideVersionId: result.guideVersionId, importBatchId: result.importBatchId, checksum: result.checksum },
    { status: 201 },
  );
});
