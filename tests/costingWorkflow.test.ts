import { describe, it, expect, beforeEach } from "vitest";
import { pool } from "../src/lib/db";
import { seedGuideVersion } from "./fixtures/seedGuideVersion";
import { createUser, login, apiFetch, BASE_URL } from "./helpers";

const PASSWORD = "correct horse battery staple";

// Must be beforeEach, not beforeAll: the global setup's per-test TRUNCATE of
// `users` cascades through import_batches.uploaded_by -> guide_versions.
// import_batch_id -> every master table, so a guide seeded once before all
// tests is gone again after the very first test's truncate runs.
beforeEach(async () => {
  await seedGuideVersion(`PHASE3-TEST-${Date.now()}`);
});

async function createCostingWithBoltLine(cookie: string, overrides: Record<string, unknown> = {}) {
  const created = await apiFetch("/api/costings", {
    method: "POST",
    cookie,
    body: { customerName: "PT Workflow Test" },
  });
  const costingId = created.json.costingId as string;

  const line = await apiFetch(`/api/costings/${costingId}/lines`, {
    method: "POST",
    cookie,
    body: {
      route: "CUSTOM",
      productFamily: "Bolt",
      gradeInput: "A325",
      description: "Bolt A325 M14x80",
      diameterMm: 14,
      lengthMm: 80,
      leadTimeDays: 14,
      qty: 30,
      ...overrides,
    },
  });
  return { costingId, lineId: line.json.costingLineId as string };
}

describe("AT-UX-001: route selector lives inside the Workspace, not a separate page", () => {
  it("a line can be created without a route, but Calculate rejects it until one is chosen", async () => {
    await createUser({ username: "ux_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("ux_user_001", PASSWORD);

    const created = await apiFetch("/api/costings", { method: "POST", cookie, body: { customerName: "PT UX" } });
    const costingId = created.json.costingId as string;

    const line = await apiFetch(`/api/costings/${costingId}/lines`, {
      method: "POST",
      cookie,
      body: { description: "no route yet" },
    });
    expect(line.status).toBe(201);
    expect(line.json.route).toBeNull();

    const calc = await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    expect(calc.status).toBe(422);
    expect(calc.json.error).toBeTruthy();
  });
});

describe("AT-STATE-001/002: editing a calculated line invalidates it and blocks finalize", () => {
  it("changing qty after Calculate flips the costing back to draft and requires recalculation before finalize", async () => {
    await createUser({ username: "state_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("state_user_001", PASSWORD);
    const { costingId, lineId } = await createCostingWithBoltLine(cookie);

    const calc1 = await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    expect(calc1.status).toBe(200);
    const afterCalc = await apiFetch(`/api/costings/${costingId}`, { cookie });
    expect(afterCalc.json.status).toBe("calculated");

    const line = await apiFetch(`/api/costings/${costingId}/lines`, { cookie });
    const targetLine = (line.json.lines as { costingLineId: string; updatedAt: string }[]).find(
      (l) => l.costingLineId === lineId,
    )!;
    const patch = await apiFetch(`/api/costings/${costingId}/lines/${lineId}`, {
      method: "PATCH",
      cookie,
      body: { expectedUpdatedAt: targetLine.updatedAt, qty: 31 },
    });
    expect(patch.status).toBe(200);

    const afterPatch = await apiFetch(`/api/costings/${costingId}`, { cookie });
    expect(afterPatch.json.status).toBe("draft"); // AT-STATE-001: Needs Recalculation

    const finalizeAttempt = await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: afterPatch.json.updatedAt },
    });
    expect(finalizeAttempt.status).toBe(409); // AT-STATE-002
    expect((finalizeAttempt.json.error as { code: string }).code).toBe("RECALCULATION_REQUIRED");
  });
});

describe("AT-STATE-003: a finalized costing is locked; Create Revision stays available", () => {
  it("PATCH on a finalized line/costing is rejected, but /revisions succeeds for the owner", async () => {
    await createUser({ username: "state_user_003", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("state_user_003", PASSWORD);
    const { costingId, lineId } = await createCostingWithBoltLine(cookie);

    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    const finalized = await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });
    expect(finalized.status).toBe(200);
    expect(finalized.json.quotationNo).toMatch(/^CBP-Q-\d{4}-\d{5}$/);

    const lineNow = await apiFetch(`/api/costings/${costingId}/lines`, { cookie });
    const targetLine = (lineNow.json.lines as { costingLineId: string; updatedAt: string }[]).find(
      (l) => l.costingLineId === lineId,
    )!;
    const blockedPatch = await apiFetch(`/api/costings/${costingId}/lines/${lineId}`, {
      method: "PATCH",
      cookie,
      body: { expectedUpdatedAt: targetLine.updatedAt, qty: 99 },
    });
    expect(blockedPatch.status).toBe(409);
    expect((blockedPatch.json.error as { code: string }).code).toBe("COSTING_LOCKED");

    const revision = await apiFetch(`/api/costings/${costingId}/revisions`, { method: "POST", cookie });
    expect(revision.status).toBe(201);
    expect(revision.json.costingId).not.toBe(costingId);
    expect(revision.json.revisionNo).toBe(1);
    expect(revision.json.status).toBe("draft");

    const revisionLines = await apiFetch(`/api/costings/${revision.json.costingId}/lines`, { cookie });
    expect(revisionLines.json.lines).toHaveLength(1);

    const parentAfter = await apiFetch(`/api/costings/${costingId}`, { cookie });
    expect(parentAfter.json.status).toBe("revised");
  });
});

describe("Creating a revision preserves thread_condition (HT/FT) on copied Bolt lines", () => {
  it("a revision of a finalized Bolt/HT line keeps threadCondition 'HT', not null", async () => {
    await createUser({ username: "thread_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("thread_user_001", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(cookie, {
      diameterMm: 25.4,
      sizeLabel: "1",
      threadCondition: "HT",
    });

    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    const finalized = await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });
    expect(finalized.status).toBe(200);

    const revision = await apiFetch(`/api/costings/${costingId}/revisions`, { method: "POST", cookie });
    expect(revision.status).toBe(201);

    const revisionLines = await apiFetch(`/api/costings/${revision.json.costingId}/lines`, { cookie });
    const revisionLine = (revisionLines.json.lines as { threadCondition: string | null }[])[0];
    expect(revisionLine.threadCondition).toBe("HT");
  });
});

describe("Access control across the full workflow", () => {
  it("another user can view a finalized costing but cannot edit or duplicate its lock state away", async () => {
    await createUser({ username: "owner_wf_001", password: PASSWORD, roles: ["costing_user"] });
    await createUser({ username: "other_wf_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie: ownerCookie } = await login("owner_wf_001", PASSWORD);
    const { costingId, lineId } = await createCostingWithBoltLine(ownerCookie);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie: ownerCookie });

    const { cookie: otherCookie } = await login("other_wf_001", PASSWORD);
    const otherView = await apiFetch(`/api/costings/${costingId}`, { cookie: otherCookie });
    expect(otherView.status).toBe(200);
    expect(otherView.json.canEdit).toBe(false);

    const otherLines = otherView.json.lines as { updatedAt: string }[];
    const otherPatch = await apiFetch(`/api/costings/${costingId}/lines/${lineId}`, {
      method: "PATCH",
      cookie: otherCookie,
      body: { expectedUpdatedAt: otherLines[0].updatedAt, qty: 5 },
    });
    expect(otherPatch.status).toBe(403);
    expect((otherPatch.json.error as { code: string }).code).toBe("COSTING_READ_ONLY");

    const otherCalculate = await apiFetch(`/api/costings/${costingId}/calculate`, {
      method: "POST",
      cookie: otherCookie,
    });
    expect(otherCalculate.status).toBe(403);
  });
});

describe("AT-EXPORT-001: export only works after finalization and excludes PPN", () => {
  it("rejects export of a draft costing and produces an audited, ex-PPN document once finalized", async () => {
    await createUser({ username: "export_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("export_user_001", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(cookie);

    const tooEarly = await apiFetch(`/api/costings/${costingId}/export`, { method: "POST", cookie });
    expect(tooEarly.status).toBe(409);
    expect((tooEarly.json.error as { code: string }).code).toBe("QUOTATION_NOT_FINAL");

    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });

    // The summary endpoint is the read-only, never-audited preview source (AUD-016).
    const summary = await apiFetch(`/api/costings/${costingId}/quotation-summary`, { cookie });
    expect(summary.status).toBe(200);
    const doc = summary.json.document as { taxOutputMode: string; totalExPpn: number };
    expect(doc.taxOutputMode).toBe("EXCLUDE_PPN");
    expect(doc.totalExPpn).toBe(840000);

    // Export itself is a real download: binary XLSX, checksummed, and audited.
    const exportRes = await fetch(`${BASE_URL}/api/costings/${costingId}/export`, { method: "POST", headers: { cookie } });
    expect(exportRes.status).toBe(200);
    expect(exportRes.headers.get("content-type")).toContain("spreadsheetml");
    const checksum = exportRes.headers.get("x-checksum-sha256");
    expect(checksum).toBeTruthy();
    const bodyBytes = await exportRes.arrayBuffer();
    expect(bodyBytes.byteLength).toBeGreaterThan(0);

    const auditRows = await pool.query(
      `SELECT action FROM audit_events WHERE action = 'QUOTATION_EXPORTED' AND after_json->>'checksum' = $1`,
      [checksum],
    );
    expect(auditRows.rows).toHaveLength(1);
  });

  it("the preview summary is never audited as an export, even when the costing is finalized", async () => {
    await createUser({ username: "export_user_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("export_user_002", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(cookie);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });

    await apiFetch(`/api/costings/${costingId}/quotation-summary`, { cookie });
    await apiFetch(`/api/costings/${costingId}/quotation-summary`, { cookie });

    const auditRows = await pool.query(
      `SELECT action FROM audit_events WHERE action = 'QUOTATION_EXPORTED' AND entity_type = 'quotation_exports'
       AND entity_id IN (SELECT export_id FROM quotation_exports WHERE costing_id = $1)`,
      [costingId],
    );
    expect(auditRows.rows).toHaveLength(0);
  });
});

describe("AT-LOOKUP-001: grade display labels", () => {
  it("gradeLabelsByFamily returns the fuller designation for a labeled grade and falls back to the short code otherwise", async () => {
    await createUser({ username: "lookup_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("lookup_user_001", PASSWORD);

    const res = await apiFetch("/api/guides/active/lookups", { cookie });
    expect(res.status).toBe(200);
    const gradeLabelsByFamily = res.json.gradeLabelsByFamily as Record<string, Record<string, string>>;

    // Nut/2H has a confirmed display_label in the fixture (DEC-041).
    expect(gradeLabelsByFamily["Nut"]["2H"]).toBe("A194-2H");
    // Bolt/A325 has no display_label set -> falls back to the short code itself.
    expect(gradeLabelsByFamily["Bolt"]["A325"]).toBe("A325");
    // The matching key (gradeToProfile) is unaffected by labeling.
    const gradeToProfile = res.json.gradeToProfile as Record<string, Record<string, string>>;
    expect(gradeToProfile["Nut"]["2H"]).toBe("Heavy Hex");
  });

  it("defaultWeightTolerancePercent mirrors app_config.CUSTOM_WEIGHT_TOLERANCE (2%)", async () => {
    await createUser({ username: "lookup_user_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("lookup_user_002", PASSWORD);

    const res = await apiFetch("/api/guides/active/lookups", { cookie });
    expect(res.status).toBe(200);
    expect(res.json.defaultWeightTolerancePercent).toBeCloseTo(0.02, 9);
  });
});

describe("AT-SIZE-001: an Inch-size line calculates using its real size_label, not a synthesized 'M<diameter>'", () => {
  it("a Bolt line saved with sizeLabel '1' (Inch, 25.4mm) calculates successfully", async () => {
    await createUser({ username: "size_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("size_user_001", PASSWORD);

    // Deliberately NOT going through createCostingWithBoltLine, which always
    // uses a Metric diameter — this exercises the size_label column this
    // fix added, at a diameter (25.4mm) that would previously synthesize
    // the nonexistent size_label "M25.4" and fail with RAW_SIZE_INVALID.
    const { costingId } = await createCostingWithBoltLine(cookie, {
      diameterMm: 25.4,
      sizeLabel: "1",
      threadCondition: "HT",
    });

    const calc = await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    expect(calc.status).toBe(200);

    const detail = await apiFetch(`/api/costings/${costingId}`, { cookie });
    const line = (detail.json.lines as { sizeLabel: string | null; latestUnitSellingPrice: number }[])[0];
    expect(line.sizeLabel).toBe("1");
    expect(line.latestUnitSellingPrice).toBeGreaterThan(0);
  });
});

describe("AT-DELETE-001/002: dashboard soft delete", () => {
  it("removes a Draft costing from every read path while retaining the row and its audit trail", async () => {
    await createUser({ username: "del_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("del_user_001", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(cookie);

    const del = await apiFetch(`/api/costings/${costingId}`, { method: "DELETE", cookie });
    expect(del.status).toBe(200);

    // Gone from the list and unreachable directly...
    const list = await apiFetch("/api/costings", { cookie });
    expect((list.json.costings as { costingId: string }[]).some((c) => c.costingId === costingId)).toBe(false);
    const direct = await apiFetch(`/api/costings/${costingId}`, { cookie });
    expect(direct.status).toBe(404);

    // ...but the row itself survives, which is the whole point of soft delete:
    // audit_events reference this id and must stay resolvable.
    const row = await pool.query(`SELECT deleted_at FROM costing_headers WHERE costing_id = $1`, [costingId]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].deleted_at).not.toBeNull();

    const audit = await pool.query(
      `SELECT 1 FROM audit_events WHERE action = 'COSTING_DELETED' AND entity_id = $1`,
      [costingId],
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("refuses to delete a finalized costing — that case is Void, not delete", async () => {
    await createUser({ username: "del_user_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("del_user_002", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(cookie);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });

    const del = await apiFetch(`/api/costings/${costingId}`, { method: "DELETE", cookie });
    expect(del.status).toBe(409);
    expect((del.json.error as { code: string }).code).toBe("COSTING_LOCKED");
  });

  it("refuses to delete another user's costing", async () => {
    await createUser({ username: "del_owner_003", password: PASSWORD, roles: ["costing_user"] });
    await createUser({ username: "del_other_003", password: PASSWORD, roles: ["costing_user"] });
    const { cookie: ownerCookie } = await login("del_owner_003", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(ownerCookie);

    const { cookie: otherCookie } = await login("del_other_003", PASSWORD);
    const del = await apiFetch(`/api/costings/${costingId}`, { method: "DELETE", cookie: otherCookie });
    expect(del.status).toBe(403);
    expect((del.json.error as { code: string }).code).toBe("COSTING_READ_ONLY");
  });
});

describe("AT-PO-001/002: PO conversion tracking", () => {
  it("can be marked on a FINALIZED costing — the locked state is exactly when a PO arrives", async () => {
    await createUser({ username: "po_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("po_user_001", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(cookie);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });

    // The customer's PO number is mandatory — it is the confirmation step that
    // stops a stray click recording a win that never happened.
    const noNumber = await apiFetch(`/api/costings/${costingId}/po`, { method: "POST", cookie, body: { isPo: true } });
    expect(noNumber.status).toBe(400);
    expect((noNumber.json.error as { code: string }).code).toBe("PO_NUMBER_REQUIRED");

    const marked = await apiFetch(`/api/costings/${costingId}/po`, {
      method: "POST",
      cookie,
      body: { isPo: true, poNumber: "PO/2026/00123" },
    });
    expect(marked.status).toBe(200);
    expect(marked.json.isPo).toBe(true);
    expect(marked.json.poNumber).toBe("PO/2026/00123");

    // Marking a PO must not disturb the costing's own state or recalculation
    // status — it is commercial tracking, not a calculation input.
    const after = await apiFetch(`/api/costings/${costingId}`, { cookie });
    expect(after.json.status).toBe("finalized");

    // Clearing needs no number, and must also clear the stored one.
    const unmarked = await apiFetch(`/api/costings/${costingId}/po`, { method: "POST", cookie, body: { isPo: false } });
    expect(unmarked.json.isPo).toBe(false);
    expect(unmarked.json.poNumber).toBeNull();

    const audit = await pool.query(
      `SELECT action FROM audit_events WHERE entity_id = $1 AND action IN ('COSTING_MARKED_PO', 'COSTING_UNMARKED_PO') ORDER BY occurred_at`,
      [costingId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["COSTING_MARKED_PO", "COSTING_UNMARKED_PO"]);
  });

  it("refuses a non-owner who is not Super Admin", async () => {
    await createUser({ username: "po_owner_002", password: PASSWORD, roles: ["costing_user"] });
    await createUser({ username: "po_other_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie: ownerCookie } = await login("po_owner_002", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(ownerCookie);

    const { cookie: otherCookie } = await login("po_other_002", PASSWORD);
    const res = await apiFetch(`/api/costings/${costingId}/po`, { method: "POST", cookie: otherCookie, body: { isPo: true } });
    expect(res.status).toBe(403);
  });
});

describe("Super Admin: void and reassign", () => {
  it("only Super Admin can void a finalized costing, and only with a reason", async () => {
    await createUser({ username: "owner_void_001", password: PASSWORD, roles: ["costing_user"] });
    const adminId = await createUser({ username: "admin_void_001", password: PASSWORD, roles: ["super_admin"] });
    const { cookie: ownerCookie } = await login("owner_void_001", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(ownerCookie);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie: ownerCookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie: ownerCookie });
    await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie: ownerCookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });

    const ownerVoidAttempt = await apiFetch(`/api/costings/${costingId}/void`, {
      method: "POST",
      cookie: ownerCookie,
      body: { reason: "test" },
    });
    expect(ownerVoidAttempt.status).toBe(403);

    const { cookie: adminCookie } = await login("admin_void_001", PASSWORD);
    const missingReason = await apiFetch(`/api/costings/${costingId}/void`, { method: "POST", cookie: adminCookie, body: {} });
    expect(missingReason.status).toBe(400);

    const voided = await apiFetch(`/api/costings/${costingId}/void`, {
      method: "POST",
      cookie: adminCookie,
      body: { reason: "Customer cancelled the order" },
    });
    expect(voided.status).toBe(200);
    expect(voided.json.status).toBe("voided");

    const reassignAttempt = await apiFetch(`/api/costings/${costingId}/reassign`, {
      method: "POST",
      cookie: adminCookie,
      body: { newOwnerId: adminId, reason: "ownership transfer" },
    });
    expect(reassignAttempt.status).toBe(200);
    expect(reassignAttempt.json.ownerUserId).toBe(adminId);
  });
});

describe("AT-VERSION-002: a historical costing keeps V1's results after V2 is published", () => {
  it("opening the finalized costing does not silently recalculate it against the new active version", async () => {
    await createUser({ username: "version_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("version_user_001", PASSWORD);
    const { costingId } = await createCostingWithBoltLine(cookie);

    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    const finalized = await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });
    expect(finalized.status).toBe(200);
    const v1GuideVersionId = finalized.json.guideVersionId as string;
    const finalizedDetail = await apiFetch(`/api/costings/${costingId}`, { cookie });
    const v1UnitPrice = (finalizedDetail.json.lines as { latestUnitSellingPrice: number }[])[0].latestUnitSellingPrice;
    expect(v1UnitPrice).toBeGreaterThan(0);

    // Publish V2 (seedGuideVersion retires the previously-published version,
    // mirroring the real publish flow), then change V2's own copy of the same
    // product's price — V1's row is a physically separate copy and must be untouched.
    const v2GuideVersionId = await seedGuideVersion(`PHASE3-TEST-V2-${Date.now()}`);
    await pool.query(
      `UPDATE price_per_kg SET selling_price_per_kg = 999999
       WHERE guide_version_id = $1 AND product_family = 'Bolt' AND grade_or_spec = 'A325' AND size_label = 'M14'`,
      [v2GuideVersionId],
    );
    const v1PriceStill = await pool.query(
      `SELECT selling_price_per_kg FROM price_per_kg
       WHERE guide_version_id = $1 AND product_family = 'Bolt' AND grade_or_spec = 'A325' AND size_label = 'M14'`,
      [v1GuideVersionId],
    );
    expect(Number(v1PriceStill.rows[0].selling_price_per_kg)).toBe(70000);

    // Reopening the historical costing must still show V1's guide version and price.
    const reopened = await apiFetch(`/api/costings/${costingId}`, { cookie });
    expect(reopened.json.guideVersionId).toBe(v1GuideVersionId);
    expect(reopened.json.guideVersionId).not.toBe(v2GuideVersionId);
    const reopenedLines = reopened.json.lines as { latestUnitSellingPrice: number }[];
    expect(reopenedLines[0].latestUnitSellingPrice).toBe(v1UnitPrice);
  });
});

describe("AT-AUDIT-002: a finalized price is reconstructable from the stored explanation evidence", () => {
  it("recomputing base + coating + dies from the explained rules reproduces unit_selling_price exactly", async () => {
    await createUser({ username: "explain_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("explain_user_001", PASSWORD);
    const { costingId, lineId } = await createCostingWithBoltLine(cookie, {
      qty: 31,
      leadTimeDays: 10,
      coatingCode: "HDG",
    });

    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    const lines = calculated.json.lines as { costingLineId: string; latestUnitSellingPrice: number }[];
    const calculatedLine = lines.find((l) => l.costingLineId === lineId)!;

    const explanation = await apiFetch(`/api/costings/${costingId}/lines/${lineId}/explanation`, { cookie });
    expect(explanation.status).toBe(200);
    const doc = explanation.json as {
      basePricePerItem: number;
      coatingPricePerItem: number;
      diesPricePerItem: number;
      unitPriceBeforeRounding: number;
      unitSellingPrice: number;
      explainedRules: { table: string; id: string; row: Record<string, unknown> | null }[];
    };

    // Every resolved rule reference must be a real, dereferenceable master row —
    // "explainable" means an evidence trail, not just opaque IDs.
    expect(doc.explainedRules.length).toBeGreaterThan(0);
    for (const rule of doc.explainedRules) {
      expect(rule.row).not.toBeNull();
    }

    // Reconstruct the price purely from the returned evidence and confirm it
    // reproduces the persisted snapshot exactly — the core AT-AUDIT-002 claim.
    const reconstructed = doc.basePricePerItem + doc.coatingPricePerItem + doc.diesPricePerItem;
    expect(reconstructed).toBeCloseTo(doc.unitPriceBeforeRounding, 6);
    expect(doc.unitSellingPrice).toBe(calculatedLine.latestUnitSellingPrice);
  });
});

describe("Customer is optional at Draft creation but required before Finalize", () => {
  it("POST /api/costings with no body creates a Draft with an empty customer", async () => {
    await createUser({ username: "nocust_user_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("nocust_user_001", PASSWORD);

    const created = await apiFetch("/api/costings", { method: "POST", cookie, body: {} });
    expect(created.status).toBe(201);
    expect(created.json.customerName).toBe("");
    expect(created.json.status).toBe("draft");
  });

  it("Finalize is rejected until a customer is set, then succeeds once one is", async () => {
    await createUser({ username: "nocust_user_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("nocust_user_002", PASSWORD);

    const created = await apiFetch("/api/costings", { method: "POST", cookie, body: {} });
    const costingId = created.json.costingId as string;

    const line = await apiFetch(`/api/costings/${costingId}/lines`, {
      method: "POST",
      cookie,
      body: {
        route: "CUSTOM",
        productFamily: "Bolt",
        gradeInput: "A325",
        diameterMm: 14,
        lengthMm: 80,
        leadTimeDays: 14,
        qty: 30,
      },
    });
    expect(line.status).toBe(201);

    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const calculated = await apiFetch(`/api/costings/${costingId}`, { cookie });
    expect(calculated.json.status).toBe("calculated");

    const blockedFinalize = await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt },
    });
    expect(blockedFinalize.status).toBe(400);

    const withCustomer = await apiFetch(`/api/costings/${costingId}`, {
      method: "PATCH",
      cookie,
      body: { expectedUpdatedAt: calculated.json.updatedAt, customerName: "PT Late Customer" },
    });
    expect(withCustomer.status).toBe(200);
    expect(withCustomer.json.customerName).toBe("PT Late Customer");

    const finalized = await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: withCustomer.json.updatedAt },
    });
    expect(finalized.status).toBe(200);
    expect(finalized.json.status).toBe("finalized");
  });
});
