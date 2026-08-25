/**
 * Structured JSON-line logging for server-side code (Phase 4 observability).
 *
 * Deliberately dependency-free: one JSON object per line on stdout/stderr is
 * what every log aggregator ingests, and this app's failure modes (a wrong
 * price, a rejected publish) need correlation ids and business context far
 * more than they need a logging framework's transports or serializers.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): LogLevel {
  const configured = process.env.LOG_LEVEL as LogLevel | undefined;
  if (configured && configured in LEVEL_ORDER) return configured;
  // Tests are noisy enough without per-request lines; production keeps info.
  return process.env.NODE_ENV === "test" ? "warn" : "info";
}

/**
 * Field names that must never reach the logs in cleartext, matched
 * case-insensitively anywhere in the key (so `password_hash`, `sessionToken`
 * and `DATABASE_URL` are all caught). 10_VALIDATION_RULES already forbids
 * secrets in user-visible output; this extends the same rule to log sinks,
 * which are usually retained longer and read by more people.
 */
const REDACT_PATTERN = /pass|secret|token|cookie|authorization|database_url|checksum_key/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACT_PATTERN.test(key) ? "[redacted]" : sanitize(val, depth + 1);
  }
  return out;
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel()]) return;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    message,
    ...(context ? (sanitize(context) as Record<string, unknown>) : {}),
  });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const logger = {
  debug: (message: string, context?: Record<string, unknown>) => emit("debug", message, context),
  info: (message: string, context?: Record<string, unknown>) => emit("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => emit("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => emit("error", message, context),
};
