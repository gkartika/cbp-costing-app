import type { PoolClient } from "pg";

/**
 * CBP-Q-YY-MMXXX via an atomic monthly sequence. Must be called inside the
 * same transaction that finalizes the costing so the number and the state
 * transition commit or roll back together.
 */
export async function nextQuotationNumber(
  client: Pick<PoolClient, "query">,
  year: number,
  month: number,
): Promise<string> {
  const { rows } = await client.query<{ last_sequence: number }>(
    `INSERT INTO quotation_number_sequences (year, month, last_sequence) VALUES ($1, $2, 1)
     ON CONFLICT (year, month) DO UPDATE SET last_sequence = quotation_number_sequences.last_sequence + 1
     RETURNING last_sequence`,
    [year, month],
  );
  const seq = rows[0].last_sequence;
  const yy = String(year).slice(-2);
  const mm = String(month).padStart(2, "0");
  return `CBP-Q-${yy}-${mm}${String(seq).padStart(3, "0")}`;
}

/** `-01`, `-02`, … suffix a revision's quotation number carries once finalized (DEC-012 revision numbering). */
export function revisionSuffix(revisionNo: number): string {
  return String(revisionNo).padStart(2, "0");
}
