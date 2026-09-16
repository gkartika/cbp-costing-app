-- Up Migration
-- New quotation numbers move from an annual sequence to a monthly one
-- (CBP-Q-YY-MMXXX instead of CBP-Q-YYYY-#####), so the sequence key grows a
-- month column. The one existing row per year becomes a dead sentinel
-- (month = 0) rather than being deleted — nothing reads it once the app only
-- ever inserts/updates real months (1-12), and preserving history costs
-- nothing here (this table has no dependents).

ALTER TABLE quotation_number_sequences DROP CONSTRAINT quotation_number_sequences_pkey;
ALTER TABLE quotation_number_sequences ADD COLUMN month INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotation_number_sequences ADD PRIMARY KEY (year, month);

-- Down Migration

ALTER TABLE quotation_number_sequences DROP CONSTRAINT quotation_number_sequences_pkey;
ALTER TABLE quotation_number_sequences DROP COLUMN month;
ALTER TABLE quotation_number_sequences ADD PRIMARY KEY (year);
