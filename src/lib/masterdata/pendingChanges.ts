import { pool, withTransaction } from "@/lib/db";
import { generateId } from "@/lib/ids";
import { Errors } from "@/lib/errors";
import { writeAuditEvent } from "@/lib/audit/writeAuditEvent";
import { getActivePublishedGuideVersionId } from "@/lib/guide/activeGuideVersion";
import { validateGuideVersion, type ValidationReport } from "@/lib/guide/validateGuide";
import { publishGuideVersion } from "@/lib/guide/publishGuide";
import { cloneForwardWithPatches, type PendingPatch } from "@/lib/guide/cloneForward";
import { TAB_SPECS } from "@/lib/guide/importSchema";

export type PendingChangeRow = {
  pendingChangeId: string;
  tableName: string;
  operation: "create" | "update" | "deactivate";
  sourceKey: string;
  fields: Record<string, unknown> | null;
  reason: string | null;
  status: "pending" | "published" | "discarded";
  createdBy: string;
  createdAt: Date;
};

// Simulation_Cases isn't in TAB_SPECS (JSONB input/expected, not flat
// columns) but is still staged/published through this same pending-changes
// mechanism — see cloneForward.ts's cloneAppConfigAndSimulationCases.
const EXTRA_KNOWN_TABLES = new Set(["simulation_cases"]);

export function assertKnownTable(tableName: string): void {
  if (EXTRA_KNOWN_TABLES.has(tableName)) return;
  if (!TAB_SPECS.some((s) => s.table === tableName)) {
    throw Errors.validation(`Tabel master data tidak dikenal: ${tableName}`);
  }
}

export async function stagePendingChange(params: {
  tableName: string;
  operation: "create" | "update" | "deactivate";
  sourceKey: string;
  fields: Record<string, unknown> | null;
  reason: string | null;
  actorUserId: string;
  actorRole: string;
  requestId: string;
}): Promise<PendingChangeRow> {
  assertKnownTable(params.tableName);
  const id = generateId("pmc");
  const { rows } = await pool.query<{
    pending_change_id: string;
    table_name: string;
    operation: "create" | "update" | "deactivate";
    source_key: string;
    fields_json: Record<string, unknown> | null;
    reason: string | null;
    status: "pending" | "published" | "discarded";
    created_by: string;
    created_at: Date;
  }>(
    `INSERT INTO pending_master_changes (pending_change_id, table_name, operation, source_key, fields_json, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [id, params.tableName, params.operation, params.sourceKey, params.fields ? JSON.stringify(params.fields) : null, params.reason, params.actorUserId],
  );

  await writeAuditEvent({
    action: "MASTER_DATA_CHANGE_STAGED",
    entityType: "pending_master_changes",
    entityId: id,
    actorUserId: params.actorUserId,
    actorRole: params.actorRole,
    requestId: params.requestId,
    afterJson: { tableName: params.tableName, operation: params.operation, sourceKey: params.sourceKey, fields: params.fields },
    reason: params.reason ?? undefined,
  });

  const row = rows[0];
  return {
    pendingChangeId: row.pending_change_id,
    tableName: row.table_name,
    operation: row.operation,
    sourceKey: row.source_key,
    fields: row.fields_json,
    reason: row.reason,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function listPendingChanges(tableName: string): Promise<PendingChangeRow[]> {
  assertKnownTable(tableName);
  const { rows } = await pool.query<{
    pending_change_id: string;
    table_name: string;
    operation: "create" | "update" | "deactivate";
    source_key: string;
    fields_json: Record<string, unknown> | null;
    reason: string | null;
    status: "pending" | "published" | "discarded";
    created_by: string;
    created_at: Date;
  }>(
    `SELECT * FROM pending_master_changes WHERE table_name = $1 AND status = 'pending' ORDER BY created_at`,
    [tableName],
  );
  return rows.map((row) => ({
    pendingChangeId: row.pending_change_id,
    tableName: row.table_name,
    operation: row.operation,
    sourceKey: row.source_key,
    fields: row.fields_json,
    reason: row.reason,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));
}

export async function discardPendingChange(
  pendingChangeId: string,
  actorUserId: string,
  actorRole: string,
  requestId: string,
): Promise<void> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM pending_master_changes WHERE pending_change_id = $1`,
    [pendingChangeId],
  );
  if (rows.length === 0) throw Errors.notFound("Perubahan tertunda");
  if (rows[0].status !== "pending") throw Errors.validation("Perubahan ini sudah tidak dalam status pending.");

  await pool.query(`UPDATE pending_master_changes SET status = 'discarded' WHERE pending_change_id = $1`, [pendingChangeId]);
  await writeAuditEvent({
    action: "MASTER_DATA_CHANGE_DISCARDED",
    entityType: "pending_master_changes",
    entityId: pendingChangeId,
    actorUserId,
    actorRole,
    requestId,
  });
}

/**
 * Applies every pending change for one table: clones the currently Published
 * guide version forward (every other table copies through unchanged), runs
 * it through the existing validate + publish pipeline untouched, and marks
 * the applied changes as published. Other tables' pending changes are left
 * exactly as they were — this is the mechanism that lets Price_Per_Kg go
 * live without Coating_Price_Guides (or anything else) being touched.
 */
export async function publishPendingChangesForTable(
  tableName: string,
  actorUserId: string,
  requestId: string,
): Promise<{ guideVersionId: string; report: ValidationReport }> {
  assertKnownTable(tableName);

  const pending = await listPendingChanges(tableName);
  if (pending.length === 0) {
    throw Errors.validation("Tidak ada perubahan tertunda untuk dipublikasikan.");
  }

  const sourceGuideVersionId = await getActivePublishedGuideVersionId();
  if (!sourceGuideVersionId) {
    throw Errors.validation("Belum ada guide version yang Published untuk dijadikan dasar perubahan.");
  }

  const patches: PendingPatch[] = pending.map((p) => ({
    tableName: p.tableName,
    operation: p.operation,
    sourceKey: p.sourceKey,
    fields: p.fields,
  }));

  const newGuideVersionId = await withTransaction(async (client) => {
    const newVersionId = generateId("gv");
    const versionCode = `AUTO-${tableName}-${Date.now()}`;
    const importBatchId = generateId("batch");

    await client.query(
      `INSERT INTO guide_versions (guide_version_id, version_code, status, previous_version_id)
       VALUES ($1, $2, 'draft', $3)`,
      [newVersionId, versionCode, sourceGuideVersionId],
    );
    await client.query(
      `INSERT INTO import_batches (import_batch_id, guide_version_id, uploaded_by, original_filename, file_checksum)
       VALUES ($1, $2, $3, $4, $5)`,
      [importBatchId, newVersionId, actorUserId, `master-data-edit:${tableName}`, "n/a"],
    );
    await client.query(`UPDATE guide_versions SET import_batch_id = $1 WHERE guide_version_id = $2`, [importBatchId, newVersionId]);

    await cloneForwardWithPatches(client, sourceGuideVersionId, newVersionId, patches);

    await writeAuditEvent(
      {
        action: "MASTER_DATA_VERSION_CLONED",
        entityType: "guide_versions",
        entityId: newVersionId,
        actorUserId,
        actorRole: "super_admin",
        requestId,
        afterJson: { sourceGuideVersionId, tableName, changeCount: patches.length },
      },
      client,
    );

    return newVersionId;
  });

  // validateGuideVersion/publishGuideVersion manage their own transactions
  // and already throw AppError with a rich report on failure — reused as-is.
  const report = await validateGuideVersion(newGuideVersionId, actorUserId, requestId);
  await publishGuideVersion(newGuideVersionId, actorUserId, requestId);

  const pendingIds = pending.map((p) => p.pendingChangeId);
  await pool.query(
    `UPDATE pending_master_changes
       SET status = 'published', published_guide_version_id = $1, published_at = now()
     WHERE pending_change_id = ANY($2::text[])`,
    [newGuideVersionId, pendingIds],
  );

  return { guideVersionId: newGuideVersionId, report };
}
