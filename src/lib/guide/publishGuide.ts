import { withTransaction } from "@/lib/db";
import { Errors } from "@/lib/errors";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";

/**
 * Validated -> Published (VER-006), atomically retiring whatever version was
 * previously Published (VER-007) — this guide runs a single-active-version
 * model, so "publish" and "retire the old one" are one transaction, never
 * two separate steps that could leave two versions simultaneously active.
 * Published rows are immutable by convention from this point on: no
 * UPDATE/DELETE endpoint exists for master tables — only a new import.
 */
export async function publishGuideVersion(
  guideVersionId: string,
  actorUserId: string,
  requestId: string,
  effectiveFrom?: Date,
): Promise<void> {
  await withTransaction(async (client) => {
    const { rows } = await client.query<{ status: string; version_code: string }>(
      `SELECT status, version_code FROM guide_versions WHERE guide_version_id = $1 FOR UPDATE`,
      [guideVersionId],
    );
    if (rows.length === 0) throw Errors.notFound("Guide version");
    if (rows[0].status !== "validated") {
      throw Errors.validation("Hanya versi Validated yang dapat dipublikasikan.");
    }

    const previouslyPublished = await client.query<{ guide_version_id: string }>(
      `SELECT guide_version_id FROM guide_versions WHERE status = 'published'`,
    );

    for (const prev of previouslyPublished.rows) {
      await client.query(`UPDATE guide_versions SET status = 'retired' WHERE guide_version_id = $1`, [
        prev.guide_version_id,
      ]);
      await writeAuditEvent(
        {
          action: "GUIDE_RETIRED",
          entityType: "guide_versions",
          entityId: prev.guide_version_id,
          actorUserId,
          actorRole: "super_admin",
          requestId,
          reason: `Superseded by ${guideVersionId}`,
        },
        client,
      );
    }

    await client.query(
      `UPDATE guide_versions
         SET status = 'published', previous_version_id = $1, effective_from = COALESCE($2, now())
       WHERE guide_version_id = $3`,
      [previouslyPublished.rows[0]?.guide_version_id ?? null, effectiveFrom ?? null, guideVersionId],
    );

    await writeAuditEvent(
      {
        action: "GUIDE_PUBLISHED",
        entityType: "guide_versions",
        entityId: guideVersionId,
        actorUserId,
        actorRole: "super_admin",
        requestId,
        afterJson: { versionCode: rows[0].version_code },
      },
      client,
    );
  });
}
