import { Pool, type PoolClient } from "pg";

declare global {
  var __cbpPgPool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({ connectionString });
}

// Reuse a single pool across hot reloads in dev and across route invocations.
export const pool: Pool = globalThis.__cbpPgPool ?? createPool();
if (process.env.NODE_ENV !== "production") {
  globalThis.__cbpPgPool = pool;
}

/**
 * Runs `fn` inside a single transaction, committing on success and rolling
 * back on any thrown error. All multi-statement mutations (especially ones
 * that pair a domain write with an audit_events insert) must go through this
 * so the audit trail can never observe a partially-applied change.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
