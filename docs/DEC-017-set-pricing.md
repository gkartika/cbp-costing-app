# DEC-017 — Set pricing

**Decided:** 2026-08-27
**Driver:** [docs/LEGACY-DATA-STUDY.md](LEGACY-DATA-STUDY.md) — 5,105 of 9,480
historical quoted lines (54%) are assemblies the app could not represent.

## What CBP actually quotes

More than half of real quoting volume is a set, not an item:

```
Stud Bolt c/w 2 Heavy Hex Nut, Washer      2-1/2" x 1100 -8UN   qty 36
```

One quotation line, one price, several manufactured parts. The team's
spreadsheet prices each component separately, multiplies by how many go in one
set, and sums to a **price per set** — then multiplies by the quantity ordered.

Before this change a user had to enter three lines and add them up by hand,
which is the manual step the app exists to remove and the step where a wrong
multiplier silently produces a wrong quote.

## The model

Three kinds of line, in one table:

| `line_kind` | What it is | Carries |
|---|---|---|
| `item` | A standalone product — everything that existed before | family, grade, size, `qty` |
| `set` | A customer-facing assembly | description, `qty` (number of sets) |
| `component` | One part inside a set | family, grade, size, `parent_line_id`, `qty_per_set` |

Components live in `costing_lines` rather than a separate table. A component is
structurally identical to a standalone line, so the calculation pipeline prices
one unchanged — and, more importantly, **each component gets its own row in
`line_calculation_snapshots`**. "Every price must be explainable" only holds for
a set if each component keeps its own resolved rules; a separate table would
have meant a parallel snapshot mechanism with a parallel set of guarantees.

`customPipeline` never learns that sets exist.

## Three decisions inside this

**A component's quantity is what actually gets manufactured**, not the number of
sets. 100 sets of "Stud Bolt c/w 2 Heavy Hex Nut" means making 200 nuts, and
both quantity-driven parts of the pipeline depend on knowing that:

- the quantity break card resolves on pieces produced — 300 sets × 2 nuts
  reaches the 401–700 band that 300 sets alone would not;
- **dies cost is amortised across the run** — spreading a nut die over 100
  instead of 200 pieces would overcharge every set by half the tooling.

**Components are rounded individually, then summed.** This is how the
spreadsheet has always done it: every component price in the legacy history is
a round number and Price/Set is their exact total. Summing first and rounding
once would quote a different number than the team's own records for the same
set. It also means the set price is already on the rounding grid, so there is
no second rounding step.

**The minimum price floor applies per component**, which falls out of pricing
each one as an item. Each component is a manufactured part and clears the floor
on its own merits.

## Counting once

The set line gets its own snapshot, so the dashboard, reports, quotation and
finalize checks read it through the latest-snapshot join they already used. The
cost of that is that a set's value exists twice in the table — once on the
components, once on the set — so every **aggregating** query is restricted to
`parent_line_id IS NULL`:

- `src/app/dashboard/page.tsx` — total per costing
- `src/lib/reports/buildReport.ts` — summary totals **and** the line sheet
- `src/lib/costings/quotationDocument.ts` — quoted lines

Queries that *list* lines (the workspace, the detail route) keep every row;
nesting is rebuilt from `parent_line_id`, not from ordering.

The staleness rule needed the same care in reverse. Staleness is judged per line
(`snapshot.created_at >= line.updated_at`), which only looks at the line itself
— so adding, editing or deleting a component **touches its parent's
`updated_at`**. Without that, an edited component would leave the set looking
current and finalize would issue a quotation at the old set price.

## What the customer sees

A set is one quoted line at one price. Its components print underneath as a
breakdown inside the same description cell, so the customer can see what the
assembly contains without the document implying the parts are priced
separately:

```
1   Hex Bolt c/w 2 Hex Nut, Washer          50   55,500   2,775,000
      • Bolt, A325, HT M20x80
      • 2x Nut, A194-2H, M20
```

Top-level lines are renumbered 1..N for the customer, because components share
the costing's `line_no` sequence and leave gaps.

## Still open

**Minimum total order per line item** (qty × price) remains a human check, as
decided 2026-08-25. One quotation can carry several lines of the same or
similar size, and the floor has to consider them together — sets make that
aggregation harder, not easier, since the same nut can appear inside two
different assemblies.

## Tests

`tests/setPricing.test.ts` — AT-SET-001 through AT-SET-004: set arithmetic,
per-component explainability, manufactured-quantity effects on dies and
quantity bands, single-counting in quotation and reports, cascade delete,
parent staleness, and the two rejection paths (component on a non-set,
component on another user's costing).
