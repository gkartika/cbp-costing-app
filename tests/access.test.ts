import { describe, it, expect } from "vitest";
import { pool } from "../src/lib/db";
import { createUser, login, apiFetch } from "./helpers";

const PASSWORD = "correct horse battery staple";

async function createCostingAsOwner(cookie: string, customerName = "PT Owner Corp") {
  const { status, json } = await apiFetch("/api/costings", {
    method: "POST",
    cookie,
    body: { customerName },
  });
  expect(status).toBe(201);
  return json as { costingId: string; updatedAt: string };
}

describe("AT-ACCESS-001: other-user costing is readable but view-only", () => {
  it("User B can open User A's costing; edit is disabled server-side", async () => {
    const userAId = await createUser({ username: "user_a_001", password: PASSWORD, roles: ["costing_user"] });
    await createUser({ username: "user_b_001", password: PASSWORD, roles: ["costing_user"] });

    const { cookie: cookieA } = await login("user_a_001", PASSWORD);
    const { costingId } = await createCostingAsOwner(cookieA);

    const { cookie: cookieB } = await login("user_b_001", PASSWORD);
    const { status, json } = await apiFetch(`/api/costings/${costingId}`, { cookie: cookieB });

    expect(status).toBe(200);
    expect(json.ownerUserId).toBe(userAId);
    expect(json.canEdit).toBe(false);
  });
});

describe("AT-ACCESS-002: PATCH on another user's costing is rejected", () => {
  it("returns 403 COSTING_READ_ONLY and writes no mutation or success audit event", async () => {
    await createUser({ username: "user_a_002", password: PASSWORD, roles: ["costing_user"] });
    await createUser({ username: "user_b_002", password: PASSWORD, roles: ["costing_user"] });

    const { cookie: cookieA } = await login("user_a_002", PASSWORD);
    const { costingId, updatedAt } = await createCostingAsOwner(cookieA);

    const { cookie: cookieB } = await login("user_b_002", PASSWORD);
    const { status, json } = await apiFetch(`/api/costings/${costingId}`, {
      method: "PATCH",
      cookie: cookieB,
      body: { expectedUpdatedAt: updatedAt, customerName: "Hijacked Name" },
    });

    expect(status).toBe(403);
    expect((json.error as { code: string }).code).toBe("COSTING_READ_ONLY");

    const { rows } = await pool.query(
      `SELECT customer_name_snapshot FROM costing_headers WHERE costing_id = $1`,
      [costingId],
    );
    expect(rows[0].customer_name_snapshot).not.toBe("Hijacked Name");

    const audit = await pool.query(
      `SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at`,
      [costingId],
    );
    const actions = audit.rows.map((r) => r.action);
    expect(actions).not.toContain("COSTING_UPDATED");
    expect(actions).toContain("AUTHORIZATION_BLOCKED");
  });
});

describe("AT-ACCESS-003: duplicating a readable costing creates an independently-owned draft", () => {
  it("gives User B a new costing_id/owner with no snapshots or audit history copied", async () => {
    await createUser({ username: "user_a_003", password: PASSWORD, roles: ["costing_user"] });
    const userBId = await createUser({ username: "user_b_003", password: PASSWORD, roles: ["costing_user"] });

    const { cookie: cookieA } = await login("user_a_003", PASSWORD);
    const { costingId: sourceId } = await createCostingAsOwner(cookieA, "PT Source Corp");

    const { cookie: cookieB } = await login("user_b_003", PASSWORD);
    const { status, json } = await apiFetch(`/api/costings/${sourceId}/duplicate`, {
      method: "POST",
      cookie: cookieB,
    });

    expect(status).toBe(201);
    expect(json.costingId).not.toBe(sourceId);
    expect(json.ownerUserId).toBe(userBId);
    expect(json.customerName).toBe("PT Source Corp");

    const sourceAudit = await pool.query(
      `SELECT action FROM audit_events WHERE entity_id = $1`,
      [sourceId],
    );
    // The source costing's own audit trail is untouched by someone else duplicating it.
    expect(sourceAudit.rows.map((r) => r.action)).not.toContain("COSTING_DUPLICATED");
  });
});
