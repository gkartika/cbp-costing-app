import { describe, it, expect, beforeEach } from "vitest";
import { pool } from "../src/lib/db";
import { seedGuideVersion } from "./fixtures/seedGuideVersion";
import { createUser, login, apiFetch } from "./helpers";

const PASSWORD = "correct horse battery staple";

beforeEach(async () => {
  await seedGuideVersion(`SETS-TEST-${Date.now()}`);
});

async function newCosting(cookie: string, name = "PT Set Test") {
  const created = await apiFetch("/api/costings", { method: "POST", cookie, body: { customerName: name } });
  return created.json.costingId as string;
}

const BOLT = {
  route: "CUSTOM",
  productFamily: "Bolt",
  gradeInput: "A325",
  sizeLabel: "M14",
  diameterMm: 14,
  lengthMm: 80,
  leadTimeDays: 28,
  description: "Bolt A325 M14x80",
};

const NUT = {
  route: "CUSTOM",
  productFamily: "Nut",
  gradeInput: "2H",
  sizeLabel: "M20",
  diameterMm: 20,
  leadTimeDays: 28,
  description: "Nut 2H M20",
};

async function addSet(cookie: string, costingId: string, description: string, qty: number) {
  const res = await apiFetch(`/api/costings/${costingId}/lines`, {
    method: "POST",
    cookie,
    body: { lineKind: "set", description, qty },
  });
  return res;
}

async function addComponent(
  cookie: string,
  costingId: string,
  parentLineId: string,
  spec: Record<string, unknown>,
  qtyPerSet: number,
) {
  return apiFetch(`/api/costings/${costingId}/lines`, {
    method: "POST",
    cookie,
    body: { lineKind: "component", parentLineId, qtyPerSet, ...spec },
  });
}

async function latestSnapshot(lineId: string) {
  const { rows } = await pool.query<{
    base_price_per_item: string;
    dies_price_per_item: string;
    unit_selling_price: string;
    order_total: string;
    input_snapshot_json: Record<string, unknown>;
  }>(
    `SELECT base_price_per_item, dies_price_per_item, unit_selling_price, order_total, input_snapshot_json
     FROM line_calculation_snapshots WHERE costing_line_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [lineId],
  );
  return rows[0] ?? null;
}

describe("AT-SET-001: a set is priced as the sum of its components", () => {
  it("set price = sum(component unit price x qty per set), and order total = set price x sets", async () => {
    await createUser({ username: "set_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_001", PASSWORD);
    const costingId = await newCosting(cookie);

    const set = await addSet(cookie, costingId, "Hex Bolt c/w 2 Hex Nut", 50);
    expect(set.status).toBe(201);
    const setId = set.json.costingLineId as string;

    const bolt = await addComponent(cookie, costingId, setId, BOLT, 1);
    const nut = await addComponent(cookie, costingId, setId, NUT, 2);
    expect(bolt.status).toBe(201);
    expect(nut.status).toBe(201);

    const calc = await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    expect(calc.status).toBe(200);

    const boltSnap = await latestSnapshot(bolt.json.costingLineId as string);
    const nutSnap = await latestSnapshot(nut.json.costingLineId as string);
    const setSnap = await latestSnapshot(setId);

    const expectedPerSet = Number(boltSnap.unit_selling_price) * 1 + Number(nutSnap.unit_selling_price) * 2;
    expect(Number(setSnap.unit_selling_price)).toBe(expectedPerSet);
    expect(Number(setSnap.order_total)).toBe(expectedPerSet * 50);
  });

  it("every component keeps its own snapshot, so a set price stays explainable", async () => {
    await createUser({ username: "set_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_002", PASSWORD);
    const costingId = await newCosting(cookie);

    const setId = (await addSet(cookie, costingId, "Bolt c/w Nut", 10)).json.costingLineId as string;
    const bolt = await addComponent(cookie, costingId, setId, BOLT, 1);
    await addComponent(cookie, costingId, setId, NUT, 1);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });

    const explain = await apiFetch(`/api/costings/${costingId}/lines/${bolt.json.costingLineId}/explanation`, {
      cookie,
    });
    expect(explain.status).toBe(200);
    expect((explain.json.explainedRules as unknown[]).length).toBeGreaterThan(0);

    // The set's own explanation carries the union of its components' rules and
    // names what it is made of.
    const setExplain = await apiFetch(`/api/costings/${costingId}/lines/${setId}/explanation`, { cookie });
    expect(setExplain.status).toBe(200);
    const input = setExplain.json.inputSnapshot as { lineKind: string; components: unknown[] };
    expect(input.lineKind).toBe("set");
    expect(input.components).toHaveLength(2);
  });
});

describe("AT-SET-002: a component's quantity is what actually gets manufactured", () => {
  it("dies cost amortises over qtyPerSet x sets, not over the number of sets", async () => {
    await createUser({ username: "set_003", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_003", PASSWORD);
    const costingId = await newCosting(cookie);

    // 100 sets with 2 nuts each = 200 nuts made, so a 1,000,000 die is
    // 5,000/nut. Amortising over the 100 sets instead would charge 10,000 and
    // overprice every set by the difference.
    const setId = (await addSet(cookie, costingId, "Bolt c/w 2 Nut", 100)).json.costingLineId as string;
    const nut = await addComponent(
      cookie,
      costingId,
      setId,
      { ...NUT, diesOption: "manual", diesTotalCost: 1_000_000 },
      2,
    );
    await addComponent(cookie, costingId, setId, BOLT, 1);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });

    const nutSnap = await latestSnapshot(nut.json.costingLineId as string);
    expect(Number(nutSnap.dies_price_per_item)).toBe(5_000);
  });

  it("the quantity break resolves on the produced total, so a component can reach a band its set count would not", async () => {
    await createUser({ username: "set_004", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_004", PASSWORD);

    // Nut quantity card: 1-400 is 0%, 401-700 is -5%. 300 sets x 2 nuts = 600
    // nuts, which discounts; a standalone line of 300 nuts does not.
    const setCostingId = await newCosting(cookie, "PT Set Band");
    const setId = (await addSet(cookie, setCostingId, "Bolt c/w 2 Nut", 300)).json.costingLineId as string;
    const nutInSet = await addComponent(cookie, setCostingId, setId, NUT, 2);
    await apiFetch(`/api/costings/${setCostingId}/calculate`, { method: "POST", cookie });

    const soloCostingId = await newCosting(cookie, "PT Solo Band");
    const solo = await apiFetch(`/api/costings/${soloCostingId}/lines`, {
      method: "POST",
      cookie,
      body: { ...NUT, qty: 300 },
    });
    await apiFetch(`/api/costings/${soloCostingId}/calculate`, { method: "POST", cookie });

    const inSet = await latestSnapshot(nutInSet.json.costingLineId as string);
    const standalone = await latestSnapshot(solo.json.costingLineId as string);

    // Both land on the minimum-price floor for a cheap Nut, so the discount is
    // not visible in the price — but the resolved rule is the one that proves
    // which band was used, and that is what this pins.
    const bandOf = async (lineId: string) => {
      const snap = await pool.query<{ resolved_rule_ids: { table: string; id: string }[] }>(
        `SELECT resolved_rule_ids FROM line_calculation_snapshots
         WHERE costing_line_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [lineId],
      );
      const ids = snap.rows[0].resolved_rule_ids.filter((r) => r.table === "adjustment_rules").map((r) => r.id);
      const { rows } = await pool.query<{ threshold_min: string; adjustment_value: string }>(
        `SELECT threshold_min, adjustment_value FROM adjustment_rules
         WHERE adjustment_rule_id = ANY($1::text[]) AND rule_group = 'Quantity'`,
        [ids],
      );
      return rows[0];
    };

    const setBand = await bandOf(nutInSet.json.costingLineId as string);
    const soloBand = await bandOf(solo.json.costingLineId as string);
    expect(Number(setBand.threshold_min)).toBe(401);
    expect(Number(setBand.adjustment_value)).toBe(-0.05);
    expect(Number(soloBand.threshold_min)).toBe(1);
    expect(Number(soloBand.adjustment_value)).toBe(0);
    expect(Number(inSet.base_price_per_item)).toBeLessThanOrEqual(Number(standalone.base_price_per_item));
  });
});

describe("AT-SET-003: set totals are counted once", () => {
  it("the quotation lists the set only, and its total equals the set line's own total", async () => {
    await createUser({ username: "set_005", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_005", PASSWORD);
    const costingId = await newCosting(cookie);

    const setId = (await addSet(cookie, costingId, "Bolt c/w 2 Nut", 20)).json.costingLineId as string;
    await addComponent(cookie, costingId, setId, BOLT, 1);
    await addComponent(cookie, costingId, setId, NUT, 2);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });

    const summary = await apiFetch(`/api/costings/${costingId}/quotation-summary`, { cookie });
    expect(summary.status).toBe(200);
    const doc = summary.json.document as {
      lines: { description: string; components: unknown[] }[];
      totalExPpn: number;
    };
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0].components).toHaveLength(2);

    const setSnap = await latestSnapshot(setId);
    expect(doc.totalExPpn).toBe(Number(setSnap.order_total));
  });

  it("a report total counts the set once, not the set plus its components", async () => {
    await createUser({ username: "set_006", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_006", PASSWORD);
    const costingId = await newCosting(cookie, "PT Report Double Count");

    const setId = (await addSet(cookie, costingId, "Bolt c/w 2 Nut", 20)).json.costingLineId as string;
    await addComponent(cookie, costingId, setId, BOLT, 1);
    await addComponent(cookie, costingId, setId, NUT, 2);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });

    const setSnap = await latestSnapshot(setId);
    const report = await apiFetch(`/api/reports?customer=PT Report Double Count`, { cookie });
    expect(report.status).toBe(200);
    const summary = report.json.summary as { costingId: string; totalNominal: number }[];
    const row = summary.find((s) => s.costingId === costingId)!;
    expect(row.totalNominal).toBe(Number(setSnap.order_total));

    const reportLines = report.json.lines as { costingId: string }[];
    expect(reportLines.filter((l) => l.costingId === costingId)).toHaveLength(1);
  });
});

describe("AT-SET-004: a set and its components stay consistent", () => {
  it("a set with no components fails calculation instead of quoting zero", async () => {
    await createUser({ username: "set_007", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_007", PASSWORD);
    const costingId = await newCosting(cookie);

    await addSet(cookie, costingId, "Empty set", 10);
    const calc = await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    expect(calc.status).toBe(422);
    expect(JSON.stringify(calc.json)).toContain("komponen");
  });

  it("deleting a set deletes its components with it", async () => {
    await createUser({ username: "set_008", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_008", PASSWORD);
    const costingId = await newCosting(cookie);

    const setId = (await addSet(cookie, costingId, "Bolt c/w Nut", 10)).json.costingLineId as string;
    await addComponent(cookie, costingId, setId, BOLT, 1);
    await addComponent(cookie, costingId, setId, NUT, 1);

    await apiFetch(`/api/costings/${costingId}/lines/${setId}`, { method: "DELETE", cookie });

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM costing_lines WHERE costing_id = $1 AND deleted_at IS NULL`,
      [costingId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("editing a component makes the set stale, so finalize demands a recalculation", async () => {
    await createUser({ username: "set_009", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_009", PASSWORD);
    const costingId = await newCosting(cookie);

    const setId = (await addSet(cookie, costingId, "Bolt c/w Nut", 10)).json.costingLineId as string;
    const nut = await addComponent(cookie, costingId, setId, NUT, 1);
    await addComponent(cookie, costingId, setId, BOLT, 1);
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });

    const before = await latestSnapshot(setId);

    const listed = await apiFetch(`/api/costings/${costingId}/lines`, { cookie });
    const nutLine = (listed.json.lines as { costingLineId: string; updatedAt: string }[]).find(
      (l) => l.costingLineId === nut.json.costingLineId,
    )!;
    const patch = await apiFetch(`/api/costings/${costingId}/lines/${nut.json.costingLineId}`, {
      method: "PATCH",
      cookie,
      body: { expectedUpdatedAt: nutLine.updatedAt, qtyPerSet: 4 },
    });
    expect(patch.status).toBe(200);

    const costing = await apiFetch(`/api/costings/${costingId}`, { cookie });
    const finalize = await apiFetch(`/api/costings/${costingId}/finalize`, {
      method: "POST",
      cookie,
      body: { expectedUpdatedAt: costing.json.updatedAt },
    });
    expect(finalize.status).toBe(409);
    expect((finalize.json.error as { code: string }).code).toBe("RECALCULATION_REQUIRED");

    // And once recalculated the set reflects the new component count.
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });
    const after = await latestSnapshot(setId);
    expect(Number(after.unit_selling_price)).toBeGreaterThan(Number(before.unit_selling_price));
  });

  it("a component cannot be attached to an ordinary item, only to a set", async () => {
    await createUser({ username: "set_010", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("set_010", PASSWORD);
    const costingId = await newCosting(cookie);

    const item = await apiFetch(`/api/costings/${costingId}/lines`, {
      method: "POST",
      cookie,
      body: { ...BOLT, qty: 10 },
    });
    const res = await addComponent(cookie, costingId, item.json.costingLineId as string, NUT, 1);
    expect(res.status).toBe(400);
  });

  it("a component cannot be attached to a set in someone else's costing", async () => {
    await createUser({ username: "set_011a", password: PASSWORD, roles: ["costing_user"] });
    await createUser({ username: "set_011b", password: PASSWORD, roles: ["costing_user"] });
    const a = await login("set_011a", PASSWORD);
    const b = await login("set_011b", PASSWORD);

    const theirCosting = await newCosting(a.cookie, "PT Theirs");
    const theirSet = (await addSet(a.cookie, theirCosting, "Their set", 5)).json.costingLineId as string;

    const myCosting = await newCosting(b.cookie, "PT Mine");
    const res = await addComponent(b.cookie, myCosting, theirSet, NUT, 1);
    expect(res.status).toBe(404);
  });
});
