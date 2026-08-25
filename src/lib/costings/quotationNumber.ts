import type { PoolClient } from "pg";

/**
 * DEC-012: CBP-Q-YYYY-##### via an atomic annual sequence. Must be called
 * inside the same transaction that finalizes the costing so the number and
 * the state transition commit or roll back together.
 */
export async function nextQuotationNumber(client: Pick<PoolClient, "query">, year: number): Promise<string> {
  const { rows } = await client.query<{ last_sequence: number }>(
    `INSERT INTO quotation_number_sequences (year, last_sequence) VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_sequence = quotation_number_sequences.last_sequence + 1
     RETURNING last_sequence`,
    [year],
  );
  const seq = rows[0].last_sequence;
  return `CBP-Q-${year}-${String(seq).padStart(5, "0")}`;
}
