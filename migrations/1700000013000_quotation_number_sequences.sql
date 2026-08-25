-- Up Migration
-- DEC-012 recommended default: CBP-Q-YYYY-##### using an atomic annual
-- sequence, assigned once at Finalize and never reused. One row per
-- calendar year; the UPSERT below serializes concurrent finalizations
-- through Postgres's normal row-level locking, so two requests can never be
-- handed the same number.

CREATE TABLE quotation_number_sequences (
  year            INTEGER PRIMARY KEY,
  last_sequence   INTEGER NOT NULL DEFAULT 0
);

-- Down Migration

DROP TABLE IF EXISTS quotation_number_sequences;
