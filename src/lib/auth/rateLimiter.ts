/**
 * In-memory sliding-window limiter for login attempts, keyed by username+IP.
 * Good enough for a single-instance deployment (matches DEC-014's local-dev-now
 * scope); a multi-instance deployment would need a shared store (e.g. Redis)
 * instead since this Map is per-process.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

type Bucket = { failures: number; windowStart: number };

const buckets = new Map<string, Bucket>();

// Bound memory: drop stale buckets occasionally rather than growing forever.
let lastSweep = Date.now();
function sweepIfDue() {
  const now = Date.now();
  if (now - lastSweep < WINDOW_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > WINDOW_MS) buckets.delete(key);
  }
}

export function isLoginRateLimited(key: string): boolean {
  sweepIfDue();
  const bucket = buckets.get(key);
  if (!bucket) return false;
  if (Date.now() - bucket.windowStart > WINDOW_MS) {
    buckets.delete(key);
    return false;
  }
  return bucket.failures >= MAX_ATTEMPTS;
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart > WINDOW_MS) {
    buckets.set(key, { failures: 1, windowStart: now });
    return;
  }
  bucket.failures += 1;
}

export function clearLoginFailures(key: string): void {
  buckets.delete(key);
}

export function loginRateLimitKey(username: string, ip: string): string {
  return `${ip}:${username.toLowerCase()}`;
}
