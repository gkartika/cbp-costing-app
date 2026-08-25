import { NextResponse } from "next/server";
import { apiHandler } from "@/lib/http/apiHandler";
import { requireUser } from "@/lib/http/requestContext";
import { pool } from "@/lib/db";

export const GET = apiHandler(async () => {
  // Costing User sees published versions (needed to explain a calculation);
  // Super Admin/Auditor see the full lifecycle (09_API_CONTRACTS).
  await requireUser();

  const { rows } = await pool.query<{
    guide_version_id: string;
    version_code: string;
    status: string;
    previous_version_id: string | null;
    effective_from: Date | null;
    package_checksum: string | null;
    created_at: Date;
  }>(
    `SELECT guide_version_id, version_code, status, previous_version_id, effective_from, package_checksum, created_at
     FROM guide_versions ORDER BY created_at DESC LIMIT 100`,
  );

  return NextResponse.json({
    guides: rows.map((r) => ({
      guideVersionId: r.guide_version_id,
      versionCode: r.version_code,
      status: r.status,
      previousVersionId: r.previous_version_id,
      effectiveFrom: r.effective_from,
      packageChecksum: r.package_checksum,
      createdAt: r.created_at,
    })),
  });
});
