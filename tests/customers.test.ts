import { describe, it, expect, beforeEach } from "vitest";
import { pool } from "../src/lib/db";
import { seedGuideVersion } from "./fixtures/seedGuideVersion";
import { createUser, login, apiFetch } from "./helpers";

const PASSWORD = "correct horse battery staple";

beforeEach(async () => {
  await seedGuideVersion(`CUST-TEST-${Date.now()}`);
});

describe("AT-CUST-001: any authenticated user can create a customer, only Super Admin can edit one", () => {
  it("a plain costing_user can create a customer", async () => {
    await createUser({ username: "cust_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("cust_001", PASSWORD);

    const res = await apiFetch("/api/customers", {
      method: "POST",
      cookie,
      body: { customerName: "PT Segment Test", customerCode: "SEG-001" },
    });
    expect(res.status).toBe(201);
    expect(res.json.customerName).toBe("PT Segment Test");
    expect(res.json.segment).toBeNull();
    expect(res.json.markupPercent).toBeNull();
  });

  it("a plain costing_user cannot edit an existing customer", async () => {
    await createUser({ username: "cust_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("cust_002", PASSWORD);

    const created = await apiFetch("/api/customers", { method: "POST", cookie, body: { customerName: "PT Edit Guard" } });
    const res = await apiFetch(`/api/customers/${created.json.customerId}`, {
      method: "PATCH",
      cookie,
      body: { segment: "Distributor" },
    });
    expect(res.status).toBe(403);
  });

  it("Super Admin can edit segment, markup, payment terms and code", async () => {
    await createUser({ username: "cust_003", password: PASSWORD, roles: ["costing_user"] });
    await createUser({ username: "cust_003_admin", password: PASSWORD, roles: ["super_admin"] });
    const user = await login("cust_003", PASSWORD);
    const admin = await login("cust_003_admin", PASSWORD);

    const created = await apiFetch("/api/customers", { method: "POST", cookie: user.cookie, body: { customerName: "PT Full Edit" } });
    const res = await apiFetch(`/api/customers/${created.json.customerId}`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { segment: "Fabricator", markupPercent: 0.05, paymentTerms: "NET 30", customerCode: "FAB-01" },
    });
    expect(res.status).toBe(200);
    expect(res.json.segment).toBe("Fabricator");
    expect(res.json.markupPercent).toBe(0.05);
    expect(res.json.paymentTerms).toBe("NET 30");
    expect(res.json.customerCode).toBe("FAB-01");
  });

  it("rejects an invalid segment and a markup at or below -100%", async () => {
    await createUser({ username: "cust_004_admin", password: PASSWORD, roles: ["super_admin"] });
    const { cookie } = await login("cust_004_admin", PASSWORD);
    const created = await apiFetch("/api/customers", { method: "POST", cookie, body: { customerName: "PT Bad Input" } });

    const badSegment = await apiFetch(`/api/customers/${created.json.customerId}`, {
      method: "PATCH",
      cookie,
      body: { segment: "Reseller" },
    });
    expect(badSegment.status).toBe(400);

    const badMarkup = await apiFetch(`/api/customers/${created.json.customerId}`, {
      method: "PATCH",
      cookie,
      body: { markupPercent: -1 },
    });
    expect(badMarkup.status).toBe(400);
  });

  it("rejects a duplicate customer name on create", async () => {
    await createUser({ username: "cust_005", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("cust_005", PASSWORD);
    const first = await apiFetch("/api/customers", { method: "POST", cookie, body: { customerName: "PT Duplicate" } });
    expect(first.status).toBe(201);
    const dup = await apiFetch("/api/customers", { method: "POST", cookie, body: { customerName: "PT Duplicate" } });
    expect(dup.status).toBe(400);
  });
});

describe("AT-CUST-002: a customer's markup applies to every line item quoted for them", () => {
  async function costingForCustomer(cookie: string, markupPercent: number | null) {
    const admin = await login("markup_admin", PASSWORD);
    const cust = await apiFetch("/api/customers", {
      method: "POST",
      cookie,
      body: { customerName: `PT Markup ${Date.now()}-${Math.random()}` },
    });
    if (markupPercent !== null) {
      await apiFetch(`/api/customers/${cust.json.customerId}`, {
        method: "PATCH",
        cookie: admin.cookie,
        body: { markupPercent },
      });
    }
    const costing = await apiFetch("/api/costings", { method: "POST", cookie, body: { customerName: cust.json.customerName } });
    return costing.json.costingId as string;
  }

  beforeEach(async () => {
    await createUser({ username: "markup_admin", password: PASSWORD, roles: ["super_admin"] }).catch(() => {});
  });

  it("a +10% customer markup raises the unit price and is visible in Explain", async () => {
    await createUser({ username: "markup_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("markup_001", PASSWORD);

    const plainCostingId = await costingForCustomer(cookie, null);
    const markedUpCostingId = await costingForCustomer(cookie, 0.1);

    const BOLT = {
      route: "CUSTOM",
      productFamily: "Bolt",
      gradeInput: "A325",
      sizeLabel: "M14",
      diameterMm: 14,
      lengthMm: 80,
      leadTimeDays: 14,
      qty: 30,
    };

    const plainLine = await apiFetch(`/api/costings/${plainCostingId}/lines`, { method: "POST", cookie, body: BOLT });
    const markedUpLine = await apiFetch(`/api/costings/${markedUpCostingId}/lines`, { method: "POST", cookie, body: BOLT });

    await apiFetch(`/api/costings/${plainCostingId}/calculate`, { method: "POST", cookie });
    await apiFetch(`/api/costings/${markedUpCostingId}/calculate`, { method: "POST", cookie });

    const plainSnap = await pool.query<{ unit_selling_price: string }>(
      `SELECT unit_selling_price FROM line_calculation_snapshots WHERE costing_line_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [plainLine.json.costingLineId],
    );
    const markedUpSnap = await pool.query<{ unit_selling_price: string }>(
      `SELECT unit_selling_price FROM line_calculation_snapshots WHERE costing_line_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [markedUpLine.json.costingLineId],
    );
    const plainPrice = Number(plainSnap.rows[0].unit_selling_price);
    const markedUpPrice = Number(markedUpSnap.rows[0].unit_selling_price);

    // Not an exact x1.10 because both sides independently round to the
    // nearest increment — but the marked-up price must be higher, and close
    // to the expected ratio.
    expect(markedUpPrice).toBeGreaterThan(plainPrice);
    expect(markedUpPrice / plainPrice).toBeGreaterThan(1.05);
    expect(markedUpPrice / plainPrice).toBeLessThan(1.15);

    const explain = await apiFetch(`/api/costings/${markedUpCostingId}/lines/${markedUpLine.json.costingLineId}/explanation`, {
      cookie,
    });
    const customerRef = (explain.json.explainedRules as { table: string; note?: string }[]).find(
      (r) => r.table === "customers",
    );
    expect(customerRef?.note).toMatch(/10/);
  });

  it("a customer with no markup set behaves exactly as before (no customers ref in Explain)", async () => {
    await createUser({ username: "markup_002", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("markup_002", PASSWORD);
    const costingId = await costingForCustomer(cookie, null);

    const line = await apiFetch(`/api/costings/${costingId}/lines`, {
      method: "POST",
      cookie,
      body: { route: "CUSTOM", productFamily: "Nut", gradeInput: "2H", sizeLabel: "M20", diameterMm: 20, qty: 400 },
    });
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });

    const explain = await apiFetch(`/api/costings/${costingId}/lines/${line.json.costingLineId}/explanation`, { cookie });
    const customerRef = (explain.json.explainedRules as { table: string }[]).find((r) => r.table === "customers");
    expect(customerRef).toBeUndefined();
  });

  it("a set's total already reflects the customer markup transitively — not applied a second time on the set", async () => {
    await createUser({ username: "markup_003", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("markup_003", PASSWORD);
    const costingId = await costingForCustomer(cookie, 0.2);

    const set = await apiFetch(`/api/costings/${costingId}/lines`, {
      method: "POST",
      cookie,
      body: { lineKind: "set", description: "Bolt c/w Nut", qty: 10 },
    });
    const setId = set.json.costingLineId as string;
    const bolt = await apiFetch(`/api/costings/${costingId}/lines`, {
      method: "POST",
      cookie,
      body: {
        lineKind: "component",
        parentLineId: setId,
        qtyPerSet: 1,
        route: "CUSTOM",
        productFamily: "Bolt",
        gradeInput: "A325",
        sizeLabel: "M14",
        diameterMm: 14,
        lengthMm: 80,
        leadTimeDays: 14,
      },
    });
    await apiFetch(`/api/costings/${costingId}/calculate`, { method: "POST", cookie });

    const boltSnap = await pool.query<{ unit_selling_price: string }>(
      `SELECT unit_selling_price FROM line_calculation_snapshots WHERE costing_line_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [bolt.json.costingLineId],
    );
    const setSnap = await pool.query<{ unit_selling_price: string }>(
      `SELECT unit_selling_price FROM line_calculation_snapshots WHERE costing_line_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [setId],
    );
    // The set's unit price is exactly the (already marked-up) component
    // price summed — no second multiplication on top.
    expect(Number(setSnap.rows[0].unit_selling_price)).toBe(Number(boltSnap.rows[0].unit_selling_price));
  });
});
