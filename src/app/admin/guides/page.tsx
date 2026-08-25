import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { pool } from "@/lib/db";
import { GuideAdmin } from "./GuideAdmin";

export default async function AdminGuidesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.roles.includes("super_admin")) notFound();

  const { rows } = await pool.query<{
    guide_version_id: string;
    version_code: string;
    status: string;
    created_at: Date;
  }>(`SELECT guide_version_id, version_code, status, created_at FROM guide_versions ORDER BY created_at DESC LIMIT 100`);

  const guides = rows.map((r) => ({
    guideVersionId: r.guide_version_id,
    versionCode: r.version_code,
    status: r.status,
    createdAt: r.created_at.toISOString(),
  }));

  return <GuideAdmin initialGuides={guides} />;
}
