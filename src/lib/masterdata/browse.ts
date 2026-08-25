import { pool } from "@/lib/db";
import { getActivePublishedGuideVersionId } from "@/lib/guide/activeGuideVersion";
import { assertKnownTable } from "./pendingChanges";

/** Every currently-active row of one master table, from whatever guide version is currently Published — the "Price Book" browse view. */
export async function listActiveRows(tableName: string): Promise<{ guideVersionId: string | null; rows: Record<string, unknown>[] }> {
  assertKnownTable(tableName);
  const guideVersionId = await getActivePublishedGuideVersionId();
  if (!guideVersionId) return { guideVersionId: null, rows: [] };

  const { rows } = await pool.query<Record<string, unknown>>(
    `SELECT * FROM ${tableName} WHERE guide_version_id = $1 AND active = TRUE ORDER BY source_key`,
    [guideVersionId],
  );
  return { guideVersionId, rows };
}
