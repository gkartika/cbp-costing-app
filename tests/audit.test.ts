import { describe, it, expect } from "vitest";
import { pool } from "../src/lib/db";
import { generateId } from "../src/lib/ids";
import { createUser, login, apiFetch } from "./helpers";

const PASSWORD = "correct horse battery staple";

describe("AT-AUDIT-003: audit_events is append-only at the database level", () => {
  it("rejects UPDATE regardless of which role issues it", async () => {
    const eventId = generateId("evt");
    await pool.query(
      `INSERT INTO audit_events (audit_event_id, action, entity_type, entity_id, actor_role, request_id)
       VALUES ($1, 'TEST_EVENT', 'x', 'x', 'system', 'req-audit-test')`,
      [eventId],
    );

    await expect(
      pool.query(`UPDATE audit_events SET action = 'HACKED' WHERE audit_event_id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/i);
  });

  it("rejects DELETE regardless of which role issues it", async () => {
    const eventId = generateId("evt");
    await pool.query(
      `INSERT INTO audit_events (audit_event_id, action, entity_type, entity_id, actor_role, request_id)
       VALUES ($1, 'TEST_EVENT', 'x', 'x', 'system', 'req-audit-test-2')`,
      [eventId],
    );

    await expect(
      pool.query(`DELETE FROM audit_events WHERE audit_event_id = $1`, [eventId]),
    ).rejects.toThrow(/append-only/i);
  });
});

describe("AT-AUDIT-001 (Phase 1 scope): a costing change is fully evidenced", () => {
  it("records actor, role, before/after values, changed fields and request_id", async () => {
    await createUser({ username: "owner_audit_001", password: PASSWORD, roles: ["costing_user"] });
    const { cookie } = await login("owner_audit_001", PASSWORD);

    const created = await apiFetch("/api/costings", {
      method: "POST",
      cookie,
      body: { customerName: "PT Before Name" },
    });
    const costingId = created.json.costingId as string;
    const updatedAt = created.json.updatedAt as string;

    const requestId = "req-audit-explicit-001";
    const patched = await fetch(`http://localhost:3100/api/costings/${costingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", cookie, "x-request-id": requestId },
      body: JSON.stringify({ expectedUpdatedAt: updatedAt, customerName: "PT After Name" }),
    });
    expect(patched.status).toBe(200);

    const { rows } = await pool.query(
      `SELECT action, actor_user_id, actor_role, before_json, after_json, changed_fields, request_id, occurred_at
       FROM audit_events WHERE entity_id = $1 AND action = 'COSTING_UPDATED'`,
      [costingId],
    );
    expect(rows).toHaveLength(1);
    const event = rows[0];
    expect(event.actor_user_id).toBeTruthy();
    expect(event.actor_role).toBe("costing_user");
    expect(event.before_json.customerName).toBe("PT Before Name");
    expect(event.after_json.customerName).toBe("PT After Name");
    expect(event.changed_fields).toContain("customerName");
    expect(event.request_id).toBe(requestId);
    expect(event.occurred_at).toBeTruthy();
  });
});
