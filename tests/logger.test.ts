import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger } from "../src/lib/observability/logger";

/**
 * The logger writes to stdout/stderr directly (not console), so these capture
 * the real sink rather than a console spy.
 */
let stdout: string[];
let stderr: string[];
let restore: (() => void)[];
const originalLogLevel = process.env.LOG_LEVEL;

beforeEach(() => {
  stdout = [];
  stderr = [];
  // The default level under NODE_ENV=test is "warn"; these tests assert on
  // info lines too, so lower it explicitly.
  process.env.LOG_LEVEL = "debug";
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  restore = [() => outSpy.mockRestore(), () => errSpy.mockRestore()];
});

afterEach(() => {
  restore.forEach((r) => r());
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

describe("AT-LOG-001: structured output", () => {
  it("emits one parseable JSON line per call, with level/time/message", () => {
    logger.info("request.completed", { path: "/api/costings", status: 200 });

    expect(stdout).toHaveLength(1);
    expect(stdout[0].endsWith("\n")).toBe(true);
    const parsed = JSON.parse(stdout[0]);
    expect(parsed.level).toBe("info");
    expect(parsed.message).toBe("request.completed");
    expect(parsed.path).toBe("/api/costings");
    expect(parsed.status).toBe(200);
    expect(Number.isNaN(Date.parse(parsed.time))).toBe(false);
  });

  it("routes warn/error to stderr and info/debug to stdout", () => {
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");

    expect(stdout.map((l) => JSON.parse(l).message)).toEqual(["d", "i"]);
    expect(stderr.map((l) => JSON.parse(l).message)).toEqual(["w", "e"]);
  });

  it("suppresses lines below the configured LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "error";
    logger.info("dropped");
    logger.warn("also dropped");
    logger.error("kept");

    expect(stdout).toHaveLength(0);
    expect(stderr).toHaveLength(1);
    expect(JSON.parse(stderr[0]).message).toBe("kept");
  });
});

describe("AT-LOG-002: secrets never reach the log sink", () => {
  it("redacts secret-ish keys at any nesting depth, case-insensitively", () => {
    logger.info("login.attempt", {
      username: "tirto",
      password: "hunter2",
      password_hash: "$argon2id$v=19$...",
      sessionToken: "abc123",
      AUTHORIZATION: "Bearer xyz",
      nested: { DATABASE_URL: "postgresql://user:pw@host/db", safe: "keep me" },
    });

    const parsed = JSON.parse(stdout[0]);
    expect(parsed.password).toBe("[redacted]");
    expect(parsed.password_hash).toBe("[redacted]");
    expect(parsed.sessionToken).toBe("[redacted]");
    expect(parsed.AUTHORIZATION).toBe("[redacted]");
    expect(parsed.nested.DATABASE_URL).toBe("[redacted]");

    // Non-secret fields must survive, or the logs lose their diagnostic value.
    expect(parsed.username).toBe("tirto");
    expect(parsed.nested.safe).toBe("keep me");

    // Belt and braces: the raw line must not contain the secret values at all.
    expect(stdout[0]).not.toContain("hunter2");
    expect(stdout[0]).not.toContain("argon2id");
    expect(stdout[0]).not.toContain("postgresql://");
  });

  it("does not blow up on deeply nested or self-referential-looking input", () => {
    let deep: Record<string, unknown> = { value: "bottom" };
    for (let i = 0; i < 10; i++) deep = { nested: deep };

    expect(() => logger.info("deep", deep)).not.toThrow();
    expect(() => JSON.parse(stdout[0])).not.toThrow();
  });
});
