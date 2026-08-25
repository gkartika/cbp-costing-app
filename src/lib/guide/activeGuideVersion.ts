import { pool } from "@/lib/db";

/** The single currently-Published guide version, or null if none has been published yet. */
export async function getActivePublishedGuideVersionId(): Promise<string | null> {
  const { rows } = await pool.query<{ guide_version_id: string }>(
    `SELECT guide_version_id FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  return rows[0]?.guide_version_id ?? null;
}
