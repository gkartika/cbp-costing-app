-- Up Migration
-- CBP wants the grade shown to costing users to be the fuller standard
-- designation (e.g. "A194-2H" instead of the bare "2H") while the underlying
-- grade_or_spec stays the short code everywhere it's a matching key (material
-- grade map, price guide, calc engine resolvers). Adding an optional label
-- column here, rather than renaming grade_or_spec, keeps every join and the
-- whole calc engine untouched. NULL means "no detailed label -- show the
-- short code as-is", so this is purely additive.
ALTER TABLE grade_profile_rules ADD COLUMN display_label TEXT;

-- Down Migration

ALTER TABLE grade_profile_rules DROP COLUMN IF EXISTS display_label;
