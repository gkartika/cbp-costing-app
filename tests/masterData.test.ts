import { describe, it, expect, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import { pool, withTransaction } from "../src/lib/db";
import { generateId } from "../src/lib/ids";
import { hashPassword } from "../src/lib/auth/password";
import { AppError } from "../src/lib/errors";
import { seedGuideVersion } from "./fixtures/seedGuideVersion";
import { cloneForwardWithPatches, type PendingPatch } from "../src/lib/guide/cloneForward";
import {
  stagePendingChange,
  listPendingChanges,
  discardPendingChange,
  publishPendingChangesForTable,
} from "../src/lib/masterdata/pendingChanges";
import { listActiveRows } from "../src/lib/masterdata/browse";
import { parseAndStageBulkImport } from "../src/lib/masterdata/bulkImport";

let adminUserId: string;

beforeEach(async () => {
  adminUserId = generateId("usr");
  await pool.query(
    `INSERT INTO users (user_id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)`,
    [adminUserId, `md_admin_${Date.now()}_${Math.random().toString(36).slice(2)}`, await hashPassword("irrelevant-not-logged-in-via-http"), "Master Data Admin"],
  );
  // This table isn't in setup.ts's shared TRUNCATE list (calc-engine fixtures
  // rely on guide/master tables persisting across tests in the same file), so
  // it's cleared here instead — otherwise a pending change left over from one
  // test would silently get swept into the next test's publish.
  await pool.query(`DELETE FROM pending_master_changes`);
});

async function insertDraftVersion(previousVersionId: string): Promise<string> {
  const id = generateId("gv");
  await pool.query(
    `INSERT INTO guide_versions (guide_version_id, version_code, status, previous_version_id) VALUES ($1, $2, 'draft', $3)`,
    [id, `V-${Date.now()}-${Math.random().toString(36).slice(2)}`, previousVersionId],
  );
  return id;
}

async function seedGoldenBoltSimCase(guideVersionId: string): Promise<void> {
  // Mirrors the confirmed SIM-BOLT-QTY-30 golden case (tests/fixtures/buildGuidePackageXlsx.ts),
  // reproducible from seedGuideVersion's Bolt/A325/M14 data.
  await pool.query(
    `INSERT INTO simulation_cases (simulation_id, guide_version_id, source_key, route, product_family, input_json, expected_json, notes, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
    [
      generateId("sim"),
      guideVersionId,
      "SIM-BOLT-QTY-30",
      "Custom Production",
      "Bolt",
      JSON.stringify({
        productFamily: "Bolt",
        gradeOrSpec: "A325",
        sizeLabel: "M14",
        diameterMm: 14,
        qty: 30,
        leadTimeDays: 14,
        lengthMm: 80,
        developedCutLengthMm: null,
        coatingCode: null,
        diesAvailable: null,
        diesTotalCost: null,
      }),
      JSON.stringify({ resultStatus: "PASS", rawWeightPerItemKg: 0.2128278645, unitSellingPrice: 28000, orderTotal: 840000, tolerance: 0.001 }),
      "golden case reused for master-data regression tests",
    ],
  );
}

async function buildPriceXlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Price_Per_Kg");
  ws.addRow([
    "price_id", "product_family", "product_type", "thread_condition", "grade_or_spec",
    "material", "unit_system", "size_label", "diameter_mm", "selling_price_per_kg", "currency", "active",
  ]);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("cloneForwardWithPatches", () => {
  it("clones every table's rows forward with fresh ids, leaving unpatched tables byte-identical", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-cf1`);
    const v2 = await insertDraftVersion(v1);
    await withTransaction((client) => cloneForwardWithPatches(client, v1, v2, []));

    const v1Materials = await pool.query(
      `SELECT source_key, material_name, density_kg_m3 FROM materials WHERE guide_version_id = $1 ORDER BY source_key`,
      [v1],
    );
    const v2Materials = await pool.query(
      `SELECT source_key, material_name, density_kg_m3 FROM materials WHERE guide_version_id = $1 ORDER BY source_key`,
      [v2],
    );
    expect(v2Materials.rows).toEqual(v1Materials.rows);

    const v1Ids = (await pool.query(`SELECT material_id FROM materials WHERE guide_version_id = $1`, [v1])).rows.map(
      (r) => r.material_id,
    );
    const v2Ids = (await pool.query(`SELECT material_id FROM materials WHERE guide_version_id = $1`, [v2])).rows.map(
      (r) => r.material_id,
    );
    expect(v2Ids.some((id) => v1Ids.includes(id))).toBe(false);
  });

  it("remaps a reference column (Material_Grade_Map.material_id) to the new version's cloned row via source_key", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-ref1`);
    const v2 = await insertDraftVersion(v1);
    await withTransaction((client) => cloneForwardWithPatches(client, v1, v2, []));

    const v2Map = await pool.query(
      `SELECT material_id FROM material_grade_map WHERE guide_version_id = $1 AND source_key = 'MGM-Bolt-A325'`,
      [v2],
    );
    const v2Mat = await pool.query(
      `SELECT material_id FROM materials WHERE guide_version_id = $1 AND source_key = 'MAT-SCM440'`,
      [v2],
    );
    const v1Map = await pool.query(
      `SELECT material_id FROM material_grade_map WHERE guide_version_id = $1 AND source_key = 'MGM-Bolt-A325'`,
      [v1],
    );
    expect(v2Map.rows[0].material_id).toBe(v2Mat.rows[0].material_id);
    expect(v2Map.rows[0].material_id).not.toBe(v1Map.rows[0].material_id);
  });

  it("remaps a reference column (Trading_Price_Tiers.trading_item_id) to the new version's cloned row via source_key", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-ref2`);
    const v2 = await insertDraftVersion(v1);
    await withTransaction((client) => cloneForwardWithPatches(client, v1, v2, []));

    const v2Item = await pool.query(
      `SELECT trading_item_id FROM trading_items WHERE guide_version_id = $1 AND source_key = 'TR-NUT-F10T-M12'`,
      [v2],
    );
    const v2Tiers = await pool.query(
      `SELECT trading_item_id FROM trading_price_tiers WHERE guide_version_id = $1 AND source_key LIKE 'TIER-TR-NUT-F10T-M12-%'`,
      [v2],
    );
    expect(v2Tiers.rows.length).toBeGreaterThan(0);
    for (const row of v2Tiers.rows) {
      expect(row.trading_item_id).toBe(v2Item.rows[0].trading_item_id);
    }
  });

  it("applies a create patch to only the targeted table, leaving every other table's row count unchanged", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-cr1`);
    const v2 = await insertDraftVersion(v1);
    const patches: PendingPatch[] = [
      {
        tableName: "materials",
        operation: "create",
        sourceKey: "MAT-TITANIUM",
        fields: { material_name: "Titanium", density_kg_m3: 4500, active: true },
      },
    ];
    await withTransaction((client) => cloneForwardWithPatches(client, v1, v2, patches));

    const newRow = await pool.query(
      `SELECT material_name, density_kg_m3 FROM materials WHERE guide_version_id = $1 AND source_key = 'MAT-TITANIUM'`,
      [v2],
    );
    expect(newRow.rows).toHaveLength(1);
    expect(Number(newRow.rows[0].density_kg_m3)).toBe(4500);

    const v1CoatingCount = await pool.query(`SELECT count(*)::int AS n FROM coating_price_guides WHERE guide_version_id = $1`, [v1]);
    const v2CoatingCount = await pool.query(`SELECT count(*)::int AS n FROM coating_price_guides WHERE guide_version_id = $1`, [v2]);
    expect(v2CoatingCount.rows[0].n).toBe(v1CoatingCount.rows[0].n);
  });

  it("applies an update patch to only the matching row, leaving sibling rows of the same table untouched", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-up1`);
    const v2 = await insertDraftVersion(v1);
    const patches: PendingPatch[] = [
      { tableName: "price_per_kg", operation: "update", sourceKey: "PRICE-Bolt-A325-M14", fields: { selling_price_per_kg: 72500 } },
    ];
    await withTransaction((client) => cloneForwardWithPatches(client, v1, v2, patches));

    const patched = await pool.query(
      `SELECT selling_price_per_kg FROM price_per_kg WHERE guide_version_id = $1 AND source_key = 'PRICE-Bolt-A325-M14'`,
      [v2],
    );
    expect(Number(patched.rows[0].selling_price_per_kg)).toBe(72500);

    const sibling = await pool.query(
      `SELECT selling_price_per_kg FROM price_per_kg WHERE guide_version_id = $1 AND source_key = 'PRICE-Nut-2H-M20'`,
      [v2],
    );
    expect(Number(sibling.rows[0].selling_price_per_kg)).toBe(64000);

    // The source (still-Published) version must remain completely unchanged.
    const v1Price = await pool.query(
      `SELECT selling_price_per_kg FROM price_per_kg WHERE guide_version_id = $1 AND source_key = 'PRICE-Bolt-A325-M14'`,
      [v1],
    );
    expect(Number(v1Price.rows[0].selling_price_per_kg)).toBe(70000);
  });

  it("applies a deactivate patch by flipping active=false while preserving every other field", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-deact1`);
    const v2 = await insertDraftVersion(v1);
    const patches: PendingPatch[] = [
      { tableName: "materials", operation: "deactivate", sourceKey: "MAT-CARBON-STEEL", fields: null },
    ];
    await withTransaction((client) => cloneForwardWithPatches(client, v1, v2, patches));

    const row = await pool.query(
      `SELECT material_name, density_kg_m3, active FROM materials WHERE guide_version_id = $1 AND source_key = 'MAT-CARBON-STEEL'`,
      [v2],
    );
    expect(row.rows[0].active).toBe(false);
    expect(row.rows[0].material_name).toBe("Carbon Steel");
    expect(Number(row.rows[0].density_kg_m3)).toBe(7850);
  });

  it("rejects a create patch whose source_key already exists in the source table", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-dup1`);
    const v2 = await insertDraftVersion(v1);
    const patches: PendingPatch[] = [
      { tableName: "materials", operation: "create", sourceKey: "MAT-SCM440", fields: { material_name: "Dup", density_kg_m3: 1, active: true } },
    ];
    await expect(withTransaction((client) => cloneForwardWithPatches(client, v1, v2, patches))).rejects.toThrow(/already exists/);
  });
});

describe("publishPendingChangesForTable: full stage -> review -> publish pipeline", () => {
  it("stages a create, publishes it, and the new row appears in the active Price Book while the old Published version retires", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-pub1`);
    await stagePendingChange({
      tableName: "materials",
      operation: "create",
      sourceKey: "MAT-TITANIUM",
      fields: { material_name: "Titanium", density_kg_m3: 4500, active: true },
      reason: "test",
      actorUserId: adminUserId,
      actorRole: "super_admin",
      requestId: "req-pub-1",
    });

    const pendingBefore = await listPendingChanges("materials");
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0].operation).toBe("create");

    const { guideVersionId } = await publishPendingChangesForTable("materials", adminUserId, "req-pub-2");

    const v1After = await pool.query(`SELECT status FROM guide_versions WHERE guide_version_id = $1`, [v1]);
    expect(v1After.rows[0].status).toBe("retired");

    const { rows } = await listActiveRows("materials");
    expect(rows.some((r) => r.source_key === "MAT-TITANIUM")).toBe(true);

    const pendingAfter = await pool.query(
      `SELECT status, published_guide_version_id FROM pending_master_changes WHERE table_name = 'materials' AND source_key = 'MAT-TITANIUM'`,
    );
    expect(pendingAfter.rows[0].status).toBe("published");
    expect(pendingAfter.rows[0].published_guide_version_id).toBe(guideVersionId);
  });

  it("a discarded pending change is excluded from the next publish", async () => {
    await seedGuideVersion(`V-${Date.now()}-disc1`);
    const staged = await stagePendingChange({
      tableName: "materials",
      operation: "create",
      sourceKey: "MAT-DISCARD-ME",
      fields: { material_name: "Discard Me", density_kg_m3: 1, active: true },
      reason: null,
      actorUserId: adminUserId,
      actorRole: "super_admin",
      requestId: "req-disc-1",
    });
    await discardPendingChange(staged.pendingChangeId, adminUserId, "super_admin", "req-disc-2");

    expect(await listPendingChanges("materials")).toHaveLength(0);
    await expect(publishPendingChangesForTable("materials", adminUserId, "req-disc-3")).rejects.toThrow(AppError);

    const { rows } = await listActiveRows("materials");
    expect(rows.some((r) => r.source_key === "MAT-DISCARD-ME")).toBe(false);
  });

  it("a price change that breaks the golden Simulation_Cases regression is blocked — old Published version, its data, and the pending change all stay untouched", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-reg1`);
    await seedGoldenBoltSimCase(v1);

    await stagePendingChange({
      tableName: "price_per_kg",
      operation: "update",
      sourceKey: "PRICE-Bolt-A325-M14",
      fields: { selling_price_per_kg: 99000 },
      reason: "test price bump that breaks the golden case",
      actorUserId: adminUserId,
      actorRole: "super_admin",
      requestId: "req-reg-1",
    });

    let error: unknown;
    try {
      await publishPendingChangesForTable("price_per_kg", adminUserId, "req-reg-2");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_REGRESSION_FAILED");

    const v1After = await pool.query(`SELECT status FROM guide_versions WHERE guide_version_id = $1`, [v1]);
    expect(v1After.rows[0].status).toBe("published");

    const v1Price = await pool.query(
      `SELECT selling_price_per_kg FROM price_per_kg WHERE guide_version_id = $1 AND source_key = 'PRICE-Bolt-A325-M14'`,
      [v1],
    );
    expect(Number(v1Price.rows[0].selling_price_per_kg)).toBe(70000);

    const pending = await listPendingChanges("price_per_kg");
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
  });

  it("a create-patch that collides with an existing row's business key is blocked — even though clone-forward has no fresh-import-style duplicate check of its own", async () => {
    const v1 = await seedGuideVersion(`V-${Date.now()}-dup1`);

    // seedGuideVersion already has (Nut, 2H) -> MAT-SCM440 as MGM-Nut-2H;
    // this stages a second, differently-keyed row for the same business key.
    await stagePendingChange({
      tableName: "material_grade_map",
      operation: "create",
      sourceKey: "MGM-DUPLICATE-TEST",
      fields: { material_id: "MAT-SCM440", product_family: "Nut", grade_or_spec: "2H", active: true },
      reason: "test duplicate business key",
      actorUserId: adminUserId,
      actorRole: "super_admin",
      requestId: "req-dup-1",
    });

    let error: unknown;
    try {
      await publishPendingChangesForTable("material_grade_map", adminUserId, "req-dup-2");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("GUIDE_DUPLICATE_KEY");

    const v1After = await pool.query(`SELECT status FROM guide_versions WHERE guide_version_id = $1`, [v1]);
    expect(v1After.rows[0].status).toBe("published");
  });
});

describe("parseAndStageBulkImport: single-table XLSX -> pending changes", () => {
  it("stages an update for an existing source_key and a create for a new one", async () => {
    await seedGuideVersion(`V-${Date.now()}-bi1`);
    const buffer = await buildPriceXlsx([
      ["PRICE-Bolt-A325-M14", "Bolt", "Hex Bolt", "HT", "A325", "SCM440", "Metric", "M14", 14, 70000, "IDR", true],
      ["PRICE-BOLT-NEW-M99", "Bolt", "Hex Bolt", "HT", "A325", "SCM440", "Metric", "M99", 99, 88000, "IDR", true],
    ]);

    const result = await parseAndStageBulkImport({
      tableName: "price_per_kg",
      fileBuffer: buffer,
      actorUserId: adminUserId,
      actorRole: "super_admin",
      requestId: "req-bi-1",
    });
    expect(result.staged).toBe(2);
    expect(result.skipped).toHaveLength(0);

    const pending = await listPendingChanges("price_per_kg");
    const bySourceKey = new Map(pending.map((p) => [p.sourceKey, p]));
    expect(bySourceKey.get("PRICE-Bolt-A325-M14")?.operation).toBe("update");
    expect(bySourceKey.get("PRICE-BOLT-NEW-M99")?.operation).toBe("create");
  });

  it("skips a row missing the key column and a row missing a required field, without staging either", async () => {
    await seedGuideVersion(`V-${Date.now()}-bi2`);
    const buffer = await buildPriceXlsx([
      ["", "Bolt", "Hex Bolt", "HT", "A325", "SCM440", "Metric", "M14", 14, 70000, "IDR", true],
      ["PRICE-BOLT-NOPRICE", "Bolt", "Hex Bolt", "HT", "A325", "SCM440", "Metric", "M50", 50, "", "IDR", true],
    ]);

    const result = await parseAndStageBulkImport({
      tableName: "price_per_kg",
      fileBuffer: buffer,
      actorUserId: adminUserId,
      actorRole: "super_admin",
      requestId: "req-bi-2",
    });
    expect(result.staged).toBe(0);
    expect(result.skipped).toHaveLength(2);
    expect(await listPendingChanges("price_per_kg")).toHaveLength(0);
  });
});
