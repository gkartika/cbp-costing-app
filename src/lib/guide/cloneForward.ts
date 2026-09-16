import type { PoolClient } from "pg";
import { generateId } from "@/lib/ids";
import { Errors } from "@/lib/errors";
import { TAB_SPECS, type TabSpec } from "./importSchema";

export type PendingPatch = {
  tableName: string;
  operation: "create" | "update" | "deactivate";
  sourceKey: string;
  /**
   * dbColumn -> value. For "reference"-type columns the value must be the
   * REFERENCED table's source_key (e.g. a Trading_Items item_id), never a
   * raw row id — same convention the XLSX importer already uses, so an admin
   * editing a row never needs to know an internal ULID.
   */
  fields: Record<string, unknown> | null;
};

const TAB_NAME_TO_TABLE = new Map(TAB_SPECS.map((s) => [s.tabName, s.table]));

/**
 * Clones every master table's currently-Published rows into a new Draft
 * guide_version, applying `patches` on top. This is the mechanism that
 * replaces "re-upload the whole 14-tab package to change one price": only
 * the table(s) named in `patches` actually change; everything else carries
 * through byte-for-byte (with fresh row ids, since every guide_version's
 * rows are physically its own copies).
 *
 * Table order matters: TAB_SPECS lists referenced tables (e.g. Materials)
 * before tables that reference them (e.g. Material_Grade_Map), the same
 * invariant importGuide.ts relies on — so a two-pass id-remapping build-up
 * works in a single top-to-bottom loop.
 */
export async function cloneForwardWithPatches(
  client: Pick<PoolClient, "query">,
  sourceGuideVersionId: string,
  newGuideVersionId: string,
  patches: PendingPatch[],
): Promise<void> {
  const oldIdToSourceKeyByTable = new Map<string, Map<string, string>>();
  const sourceKeyToNewIdByTable = new Map<string, Map<string, string>>();

  for (const spec of TAB_SPECS) {
    const tablePatches = patches.filter((p) => p.tableName === spec.table);
    const patchBySourceKey = new Map(
      tablePatches.filter((p) => p.operation !== "create").map((p) => [p.sourceKey, p]),
    );

    const { rows } = await client.query<Record<string, unknown>>(
      `SELECT * FROM ${spec.table} WHERE guide_version_id = $1`,
      [sourceGuideVersionId],
    );

    const oldIdToSourceKey = new Map<string, string>();
    const newIdBySourceKey = new Map<string, string>();
    const seenSourceKeys = new Set<string>();

    for (const row of rows) {
      const sourceKey = row.source_key as string;
      const oldId = row[spec.idColumn] as string;
      oldIdToSourceKey.set(oldId, sourceKey);
      seenSourceKeys.add(sourceKey);

      const patch = patchBySourceKey.get(sourceKey);
      const fieldValues = resolveFieldValues(spec, row, patch, oldIdToSourceKeyByTable, sourceKeyToNewIdByTable);
      const newId = await insertClonedRow(client, spec, newGuideVersionId, sourceKey, fieldValues);
      newIdBySourceKey.set(sourceKey, newId);
    }

    for (const patch of tablePatches) {
      if (patch.operation !== "create") continue;
      if (seenSourceKeys.has(patch.sourceKey)) {
        throw Errors.guideDuplicateKey(`${spec.tabName}: "${patch.sourceKey}" already exists — use update, not create`);
      }
      const fieldValues = resolveFieldValues(spec, null, patch, oldIdToSourceKeyByTable, sourceKeyToNewIdByTable);
      const newId = await insertClonedRow(client, spec, newGuideVersionId, patch.sourceKey, fieldValues);
      newIdBySourceKey.set(patch.sourceKey, newId);
    }

    oldIdToSourceKeyByTable.set(spec.table, oldIdToSourceKey);
    sourceKeyToNewIdByTable.set(spec.table, newIdBySourceKey);
  }

  await cloneAppConfigAndSimulationCases(client, sourceGuideVersionId, newGuideVersionId, patches);
}

function resolveFieldValues(
  spec: TabSpec,
  existingRow: Record<string, unknown> | null,
  patch: PendingPatch | undefined,
  oldIdToSourceKeyByTable: Map<string, Map<string, string>>,
  sourceKeyToNewIdByTable: Map<string, Map<string, string>>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const col of spec.columns) {
    const hasPatchValue = patch?.fields && Object.prototype.hasOwnProperty.call(patch.fields, col.dbColumn);

    if (col.type === "reference") {
      const refTable = TAB_NAME_TO_TABLE.get(col.refTab);
      if (!refTable) throw new Error(`Unknown reference tab "${col.refTab}"`);

      if (hasPatchValue) {
        const refSourceKey = String(patch!.fields![col.dbColumn]);
        const resolved = sourceKeyToNewIdByTable.get(refTable)?.get(refSourceKey);
        if (!resolved) throw new Error(`${spec.tabName}.${col.header}: "${refSourceKey}" not found in ${col.refTab}`);
        values[col.dbColumn] = resolved;
      } else if (existingRow) {
        const oldRefId = existingRow[col.dbColumn] as string | null;
        if (oldRefId === null) {
          values[col.dbColumn] = null;
        } else {
          const refSourceKey = oldIdToSourceKeyByTable.get(refTable)?.get(oldRefId);
          const resolved = refSourceKey ? sourceKeyToNewIdByTable.get(refTable)?.get(refSourceKey) : undefined;
          if (!resolved) throw new Error(`${spec.tabName}.${col.header}: could not remap reference for cloned row`);
          values[col.dbColumn] = resolved;
        }
      } else {
        values[col.dbColumn] = null;
      }
      continue;
    }

    if (hasPatchValue) {
      values[col.dbColumn] = patch!.fields![col.dbColumn];
    } else if (existingRow) {
      values[col.dbColumn] = existingRow[col.dbColumn];
    } else {
      values[col.dbColumn] = null;
    }
  }

  // "active" isn't in spec.columns for every table consistently — it is,
  // via activeCol, but a deactivate operation must win regardless of what
  // was patched in fields.
  if (patch?.operation === "deactivate") {
    values.active = false;
  }

  return values;
}

async function insertClonedRow(
  client: Pick<PoolClient, "query">,
  spec: TabSpec,
  newGuideVersionId: string,
  sourceKey: string,
  fieldValues: Record<string, unknown>,
): Promise<string> {
  const newId = generateId(spec.idPrefix);
  // Columns with no resolved value are omitted from the INSERT entirely
  // (not passed as literal NULL) so the table's own DEFAULT applies —
  // e.g. price_per_kg.currency DEFAULT 'IDR', active DEFAULT TRUE. Passing
  // explicit NULL would bypass those defaults and could violate NOT NULL.
  const optionalEntries = spec.columns
    .map((c) => [c.dbColumn, fieldValues[c.dbColumn]] as const)
    .filter(([, v]) => v !== null && v !== undefined);

  const columns = [spec.idColumn, "guide_version_id", "source_key", ...optionalEntries.map(([col]) => col)];
  const values = [newId, newGuideVersionId, sourceKey, ...optionalEntries.map(([, v]) => v)];
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  await client.query(`INSERT INTO ${spec.table} (${columns.join(", ")}) VALUES (${placeholders})`, values);
  return newId;
}

/**
 * Simulation_Cases doesn't fit the flat-column TAB_SPECS pattern (input_json
 * / expected_json are JSONB blobs shaped per calculation route), so it isn't
 * one of the generic master tables cloned above. It's still edited through
 * the same pending_master_changes staging mechanism though — this just
 * hand-rolls the create/update/deactivate handling that the generic loop
 * gets from spec.columns.
 */
async function cloneAppConfigAndSimulationCases(
  client: Pick<PoolClient, "query">,
  sourceGuideVersionId: string,
  newGuideVersionId: string,
  patches: PendingPatch[],
): Promise<void> {
  const { rows: configRows } = await client.query<{
    config_key: string;
    config_value: string;
    data_type: string;
    unit: string | null;
    editable_by: string | null;
    status: string;
  }>(`SELECT config_key, config_value, data_type, unit, editable_by, status FROM app_config WHERE guide_version_id = $1`, [
    sourceGuideVersionId,
  ]);
  for (const row of configRows) {
    await client.query(
      `INSERT INTO app_config (config_id, guide_version_id, config_key, config_value, data_type, unit, editable_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [generateId("cfg"), newGuideVersionId, row.config_key, row.config_value, row.data_type, row.unit, row.editable_by, row.status],
    );
  }

  const simPatches = patches.filter((p) => p.tableName === "simulation_cases");
  const simPatchBySourceKey = new Map(simPatches.filter((p) => p.operation !== "create").map((p) => [p.sourceKey, p]));

  const { rows: simRows } = await client.query<{
    source_key: string;
    route: string;
    product_family: string | null;
    input_json: unknown;
    expected_json: unknown;
    notes: string | null;
    active: boolean;
  }>(
    `SELECT source_key, route, product_family, input_json, expected_json, notes, active
     FROM simulation_cases WHERE guide_version_id = $1`,
    [sourceGuideVersionId],
  );
  const seenSimSourceKeys = new Set<string>();
  for (const row of simRows) {
    seenSimSourceKeys.add(row.source_key);
    const patch = simPatchBySourceKey.get(row.source_key);
    const fields = (patch?.fields ?? {}) as Record<string, unknown>;
    const active = patch?.operation === "deactivate" ? false : "active" in fields ? Boolean(fields.active) : row.active;
    await client.query(
      `INSERT INTO simulation_cases (simulation_id, guide_version_id, source_key, route, product_family, input_json, expected_json, notes, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        generateId("sim"),
        newGuideVersionId,
        row.source_key,
        (fields.route as string | undefined) ?? row.route,
        "product_family" in fields ? (fields.product_family as string | null) : row.product_family,
        JSON.stringify("input_json" in fields ? fields.input_json : row.input_json),
        JSON.stringify("expected_json" in fields ? fields.expected_json : row.expected_json),
        "notes" in fields ? (fields.notes as string | null) : row.notes,
        active,
      ],
    );
  }

  for (const patch of simPatches) {
    if (patch.operation !== "create") continue;
    if (seenSimSourceKeys.has(patch.sourceKey)) {
      throw Errors.guideDuplicateKey(`Simulation_Cases: "${patch.sourceKey}" already exists — use update, not create`);
    }
    const fields = (patch.fields ?? {}) as Record<string, unknown>;
    await client.query(
      `INSERT INTO simulation_cases (simulation_id, guide_version_id, source_key, route, product_family, input_json, expected_json, notes, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        generateId("sim"),
        newGuideVersionId,
        patch.sourceKey,
        fields.route as string,
        (fields.product_family as string | null) ?? null,
        JSON.stringify(fields.input_json),
        JSON.stringify(fields.expected_json),
        (fields.notes as string | null) ?? null,
        (fields.active as boolean | undefined) ?? true,
      ],
    );
  }
}
