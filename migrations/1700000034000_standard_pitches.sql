-- Up Migration
-- Standard (non-custom) thread pitch per product family + size, for Custom
-- Production as well as Trading — a physical/engineering constant (ISO 261
-- metric coarse series, ASME B1.1 Unified National Coarse for inch), not a
-- guide-versioned business rule, so this table is not tied to
-- guide_version_id and needs no publish/rollback workflow. Bolt and Nut of
-- the same size mate on the same thread, so both families share one map.
-- 1-5/8" and 1-7/8" have no official UNC coarse designation; CBP uses the
-- 8-UN constant-pitch series (8 TPI) for these as the practical "standard",
-- the same convention structural fastener suppliers use for large-diameter
-- inch bolts outside the standard UNC range.
CREATE TABLE standard_pitches (
  product_family   TEXT NOT NULL,
  size_label       TEXT NOT NULL,
  pitch_value      TEXT NOT NULL,
  PRIMARY KEY (product_family, size_label)
);

INSERT INTO standard_pitches (product_family, size_label, pitch_value)
SELECT family, size, pitch
FROM (VALUES
  ('M14', '2.0'), ('M16', '2.0'), ('M18', '2.5'), ('M20', '2.5'), ('M22', '2.5'),
  ('M24', '3.0'), ('M27', '3.0'), ('M30', '3.5'), ('M33', '3.5'), ('M36', '4.0'),
  ('M39', '4.0'), ('M42', '4.5'), ('M45', '4.5'), ('M48', '5.0'), ('M52', '5.0'),
  ('M56', '5.5'), ('M60', '5.5'), ('M64', '6.0'),
  ('1/4', 'T20'), ('5/16', 'T18'), ('3/8', 'T16'), ('7/16', 'T14'), ('1/2', 'T13'),
  ('9/16', 'T12'), ('5/8', 'T11'), ('3/4', 'T10'), ('7/8', 'T9'), ('1', 'T8'),
  ('1-1/8', 'T7'), ('1-1/4', 'T7'), ('1-3/8', 'T6'), ('1-1/2', 'T6'), ('1-5/8', 'T8'),
  ('1-3/4', 'T5'), ('1-7/8', 'T8'), ('2', 'T4.5'), ('2-1/4', 'T4.5'), ('2-1/2', 'T4'),
  ('2-3/4', 'T4'), ('3', 'T4'), ('3-1/4', 'T4'), ('3-1/2', 'T4')
) AS sizes(size, pitch)
CROSS JOIN (VALUES ('Bolt'), ('Nut')) AS families(family);

-- Down Migration

DROP TABLE standard_pitches;
