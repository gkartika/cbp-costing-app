-- Up Migration
--
-- Set pricing (DEC-017). More than half of CBP's real quoting volume is
-- assemblies — "Hex Bolt c/w Hex Nut, Washer", "Stud Bolt c/w 2 Heavy Hex
-- Nut" — priced as a set: each component is costed on its own, multiplied by
-- how many of it go in one set, and summed to a price per set. See
-- docs/LEGACY-DATA-STUDY.md, which found 5,105 of 9,480 historical lines in
-- this shape.
--
-- Components live in costing_lines rather than a separate table. A component
-- is a manufactured item with a family, grade, size, coating and dies option —
-- structurally identical to a standalone line — so reusing the table means the
-- calculation pipeline prices one unchanged, and every component gets its own
-- row in line_calculation_snapshots. That last part is the reason for the
-- choice: "every price must be explainable" only holds for a set if each
-- component keeps its own resolved rules, and a separate table would have
-- meant a parallel snapshot mechanism with a parallel set of guarantees.
--
-- line_no stays NOT NULL and unique per costing, so components consume numbers
-- in the same sequence. Presentation renumbers top-level lines 1..N; nesting is
-- rebuilt from parent_line_id rather than encoded in the ordering.

ALTER TABLE costing_lines
  ADD COLUMN line_kind TEXT NOT NULL DEFAULT 'item'
    CHECK (line_kind IN ('item', 'set', 'component')),
  ADD COLUMN parent_line_id TEXT REFERENCES costing_lines(costing_line_id),
  ADD COLUMN qty_per_set INTEGER CHECK (qty_per_set IS NULL OR qty_per_set >= 1);

-- A component is exactly a line with a parent, and nothing else has one. Both
-- directions matter: an orphaned component would be invisible in every
-- top-level query, and a parented 'item' would be counted twice.
ALTER TABLE costing_lines
  ADD CONSTRAINT costing_lines_component_has_parent
    CHECK ((line_kind = 'component') = (parent_line_id IS NOT NULL));

-- qty_per_set is what makes a component a component; on anything else it would
-- be a silently ignored value.
ALTER TABLE costing_lines
  ADD CONSTRAINT costing_lines_qty_per_set_scope
    CHECK ((line_kind = 'component') = (qty_per_set IS NOT NULL));

CREATE INDEX costing_lines_parent_idx ON costing_lines (parent_line_id)
  WHERE parent_line_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS costing_lines_parent_idx;
ALTER TABLE costing_lines DROP CONSTRAINT IF EXISTS costing_lines_qty_per_set_scope;
ALTER TABLE costing_lines DROP CONSTRAINT IF EXISTS costing_lines_component_has_parent;
ALTER TABLE costing_lines
  DROP COLUMN IF EXISTS qty_per_set,
  DROP COLUMN IF EXISTS parent_line_id,
  DROP COLUMN IF EXISTS line_kind;
