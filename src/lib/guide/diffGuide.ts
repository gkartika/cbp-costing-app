import { pool } from "@/lib/db";
import { TAB_SPECS } from "./importSchema";

export type RowDiff = {
  sourceKey: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changedColumns?: string[];
};

export type TabDiff = {
  tabName: string;
  added: RowDiff[];
  removed: RowDiff[];
  changed: RowDiff[];
  unchangedCount: number;
};

/**
 * Compares two guide versions table-by-table using each row's source_key
 * (the stable business key from the original import) rather than the
 * server-generated primary key, since a fresh id is minted on every import
 * even for a row whose business content never changed (VER-004).
 *
 * Reference (foreign-key) columns are excluded from the changed-value
 * comparison — they point at a different version's freshly generated id by
 * construction, so comparing them directly would flag every row as changed.
 * A change in the referenced row itself already shows up as its own diff
 * entry on that row's table.
 */
export async function diffGuideVersions(guideVersionIdA: string, guideVersionIdB: string): Promise<TabDiff[]> {
  const results: TabDiff[] = [];

  for (const spec of TAB_SPECS) {
    const compareColumns = spec.columns.filter((c) => c.type !== "reference").map((c) => c.dbColumn);
    const selectCols = ["source_key", ...compareColumns].join(", ");

    const [rowsA, rowsB] = await Promise.all([
      pool.query(`SELECT ${selectCols} FROM ${spec.table} WHERE guide_version_id = $1`, [guideVersionIdA]),
      pool.query(`SELECT ${selectCols} FROM ${spec.table} WHERE guide_version_id = $1`, [guideVersionIdB]),
    ]);

    const mapA = new Map<string, Record<string, unknown>>(rowsA.rows.map((r) => [String(r.source_key), r]));
    const mapB = new Map<string, Record<string, unknown>>(rowsB.rows.map((r) => [String(r.source_key), r]));

    const added: RowDiff[] = [];
    const removed: RowDiff[] = [];
    const changed: RowDiff[] = [];
    let unchangedCount = 0;

    for (const [key, rowB] of mapB) {
      const rowA = mapA.get(key);
      if (!rowA) {
        added.push({ sourceKey: key, after: rowB });
        continue;
      }
      const changedColumns = compareColumns.filter((c) => String(rowA[c] ?? "") !== String(rowB[c] ?? ""));
      if (changedColumns.length > 0) {
        changed.push({ sourceKey: key, before: rowA, after: rowB, changedColumns });
      } else {
        unchangedCount++;
      }
    }
    for (const [key, rowA] of mapA) {
      if (!mapB.has(key)) removed.push({ sourceKey: key, before: rowA });
    }

    results.push({ tabName: spec.tabName, added, removed, changed, unchangedCount });
  }

  return results;
}
