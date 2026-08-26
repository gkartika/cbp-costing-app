# Legacy quotation history — "New Costing CBP 2026"

Study of the spreadsheet the team quotes from today, read on 2026-08-27 from
`1KquH3FCRP_j8vHdikDn6MghmBHsq7FVNGdJEKuoEvRM`.

The point of reading it was to answer two questions: what would it take to
import this history into the app, and does the app's pricing model actually
match how the team prices. The first has a straightforward answer. The second
turned up a structural mismatch that matters more than the import does.

---

## What the workbook contains

Eleven tabs; two carry data that matters.

**`Main Sheet` — the source of truth.** 10,619 rows, 38 columns, one row per
quoted line. Every field the app needs is here: grade, quantity, coating,
thread condition, and the full per-component price working.

**`All` — a derived rollup.** 9,570 rows, 8 columns
(`Date, No SO, Customer, Quote, Inquiry No, Item, Size, Price_Set, Total Price`).
It drops grade, quantity, coating and the component breakdown. All 2,144 of its
inquiry numbers appear in Main Sheet, so it is a view, not a second record.
**Import from Main Sheet; ignore `All`.**

The rest (`List Customer`, `Sheet9`, `FORM INQ SIPPP`, `SIP`, `Sheet25`,
`Sheet27`, three `0…` drawing tabs) are working scratch, a customer roster, and
per-inquiry form templates. Nothing to import.

### Scale

| | |
|---|---|
| Quoted lines | 10,619 |
| Quotations (`No. Quote`) | 2,149 |
| Customers | 159 |
| Salespeople (`Quote` column) | 10 — Dhana, David, Tirto, Youngki, Dita, Yohana, Indriyanto, Maula, Linghot, Yudo |
| Date range | 2026-01-05 → 2026-08-26 (153 working days) |
| Quote number format | `NNN/ROMAN-MONTH/YYYY` — e.g. `001/I/2026`, sequential per month |

`NO SO` is empty in all 10,619 rows — the column was never adopted. PO tracking
in the app is not duplicating anything.

---

## The structural finding: the team quotes sets, the app quotes items

Column 22 in Main Sheet is `Price/Set`, and column H in `All` is `Price_Set`.
That naming is not incidental. **5,105 of 9,480 lines (54%) are assemblies**,
written with the `c/w` ("complete with") convention:

```
Stud Bolt c/w 2 Heavy Hex Nut, Washer      624 lines
Stud Bolt c/w 2 Hex Nut, 2 Washer          538 lines
Heavy Hex Bolt c/w Heavy Hex Nut           505 lines
Hex Bolt c/w Hex Nut                       499 lines
```

Main Sheet prices these with five component blocks, each repeating the same
four columns:

| Component | Price/Unit | Weight/Unit | Harga/Kg | Price/Unit(Berat) |
|---|---|---|---|---|
| Bolt | 14 | 15 | 16 | 17 |
| Nut | 18 | 19 | 20 | 21 |
| Washer | 23 | 24 | 25 | 26 |
| Square Washer | 28 | 29 | 30 | 31 |
| Anchor Plat | 32 | 33 | 34 | 35 |

summed into `Price/Set` (36), then `× Qty` → `Total Price` (37).

The component multiplier is parsed out of the specification text. Worked
example from row 1 of the sample:

```
Stud Bolt c/w 2 Heavy Hex Nut, Washer   2-1/2" x 1100 -8UN   qty 36
  bolt                            1,101,100
  nut     296,900 × 2 (the "2")  =  593,800
  washer                             65,800
  Price/Set                       1,760,700   ✓ matches col 36
  × 36                           63,385,200   ✓ matches col 37
```

`Price/Set × Qty = Total Price` reconciles on **8,739 of 8,797** rows where all
three are present (99.3%). The arithmetic is sound and the model is consistent.

**The app cannot express this.** It prices one product family per line. A user
quoting `Hex Bolt c/w Hex Nut, Washer` today has to enter three lines and add
them up by hand — which is precisely the manual step the app exists to remove,
and the step where a wrong multiplier silently produces a wrong quote.

Coverage against what the app prices today (families `Bolt`, `Nut`,
`Stud / Anchor`, `Washer`):

| Specification bucket | Lines | Share |
|---|---|---|
| `Hex Bolt` alone | 987 | 9% |
| `Hex Nut` alone | 335 | 3% |
| `Hex Bolt c/w …` kits | 1,078 | 10% |
| Anything `Heavy Hex …` | 3,788 | 36% |
| `Stud Bolt` / `Double Ended` | 1,136 | 11% |
| Everything else | 3,295 | 31% |

Single-family Hex Bolt and Hex Nut — the two cases every golden simulation case
covers — are **12% of real quoting volume**.

---

## The second finding: half of history is a manual override

`Price/Unit(Berat)` is the weight formula (`Weight/Unit × Harga/Kg`).
`Price/Unit` is what was actually quoted. Comparing them across 6,888 bolt rows
where both exist:

| | Rows | Share |
|---|---|---|
| Quoted = weight formula (within 1%) | 3,085 | 45% |
| Quoted **above** formula | 3,769 | 55% |
| Quoted below formula | 34 | 0.5% |

Markup distribution on the overridden rows: median **1.11×**, p75 **1.88×**,
p90 **3.12×**.

Two things follow.

**The 3,085 unmodified rows are a free backtest.** They are pure formula output
on real inputs. Running them through the app's calculator and diffing against
the recorded price would test the engine against eight months of production
data — far broader than 54 hand-written golden cases, and it costs nothing to
generate.

**The 3,769 overridden rows are the real business logic, and it is undocumented.**
A 3.12× markup at p90 is not rounding; it is a pricing decision someone made
and did not write down. The app's adjustment rules (length ratio, quantity
band, lead time) are meant to capture exactly this. Whether they reproduce the
overrides is unknown and worth measuring before go-live — if they don't, the
app will quote low against the team's own recent history.

---

## Import mapping

Direct, no transformation needed:

| Main Sheet | App |
|---|---|
| `Date` (0) | `costing_headers.created_at` |
| `Customer` (4) | `customers.name` — 159 to seed |
| `Quote` (5) | `costing_headers.signed_by_name` (salesperson) |
| `No. Quote` (6) | quotation number |
| `Qty` (13) | `costing_lines.quantity` |
| `SIZE` (10) | `costing_lines.size_label` |
| `Remarks` (7) | line notes — 3,367 rows populated |

Needs work:

**`GRADE` (11) is composite, per component**, semicolon-separated in
bolt;nut;washer order: `B7; 2H; F436` = B7 stud, 2H nuts, F436 washers.
`8.8; F436` = 8.8 bolt, F436 washer. This has to be split alongside the
specification parse, and the two must agree on component count.

**Grade vocabulary needs aliases.** Of 14,348 grade tokens, 8,807 (61%) match
the published guide. Row-level: 4,852 rows fully known, 2,480 partially, 1,936
none, 1,351 blank. The unknowns are mostly spelling variants, not new
materials:

| Token | Count | Resolution |
|---|---|---|
| `F436` | 2,299 | **washer grade — genuinely missing from the guide** |
| `A563A` | 631 | alias → `A563` |
| `B8M` | 541 | alias → `A193-B8M` |
| `8M` | 363 | alias → `A194-8M` |
| `B8` | 305 | alias → `A193-B8` |
| `A194-Gr8`, `A194-Gr.8`, `Gr.8`, `8` | 157 | alias → `A194-8` |
| `A325M`, `SS400`, `ST41`, `S45C`, `A307A`, `A563DH`, `L7`, `S10T`, `SCM440`, `B7M`, `2HM`, `4.8`, `SS310` | ~800 | new grades, need rate cards |

`grade_price_aliases` already exists (12 rows) and is the right home for the
first group. Roughly 15 alias rows plus 10 new grades would take token coverage
past 95%.

`F436` alone is 16% of all grade tokens and has no price. The `Washer` family
has 30 price rows against 313 washer-only lines and thousands more inside kits —
washers are effectively unpriced in the app.

**`SIZE` (10) has a regular grammar with a long tail.** 483 distinct shapes
across 9,489 values; the top 15 cover ~76%:

```
M12 x 40 P1.75        4,589   metric: dia × length, pitch
1/2" x 50 -13UNC        494   inch: dia × length, TPI
M16 P2.0                476   nut: dia, pitch (no length)
M20                     321   nut/plain
ID18 OD34 t4             66   washer: inner/outer dia, thickness
M20 x 250 (Drat 40)     102   partial thread — "Drat" = threaded length, mm
```

`(Drat NN)` is the partial-thread case and must map to the app's `HT` thread
condition with a thread length, not be discarded.

**Columns that look usable but are not:**

- `Coating` (8) — only 1,161 of 10,619 filled, and polluted with free text
  (`"harga bapak, sudah dengan tack weld"`, `"rev jadi round washer"`) and
  stray digits. Real vocabulary is `HDG` (525), `Zinc` (141), `PTFE` (78),
  `Plain` (8) — which matches the app's four options. Whitelist those, route
  the rest to notes.
- `LEAD TIME` (2) — 17 rows filled. Abandoned column; ignore.
- `Thread` (12) — `FT` 3,627 / `HT` 1,305 map cleanly, but the column is reused
  on anchor and U-bolt lines to hold leg dimensions (`100 x 100`, `65 x 65`).
  Accept `FT`/`HT` only.

---

## What this changes

1. **Set pricing is the gap that matters.** 54% of lines are assemblies and the
   app cannot represent one. Everything else here is import plumbing; this is a
   product decision. Recommend specifying it before importing anything, because
   the import schema depends on how sets are modelled.
2. **Heavy Hex is 36% of volume** and, like Hex, is a distinct product family in
   the guide. Confirm the rate cards cover it as thoroughly as Hex.
3. **Washers are unpriced** — 30 rate rows and no `F436`. They appear in
   thousands of kits.
4. **The 3,085 clean formula rows should become a backtest** before go-live.
   This is the cheapest large-scale validation available.
5. Import order once the above is settled: 159 customers → 10 salespeople →
   grade aliases → 2,149 quotations → 10,619 lines.

## Reproducing this

The sheet is readable as CSV through the authenticated browser session:

```
https://docs.google.com/spreadsheets/d/<id>/gviz/tq?tqx=out:csv&sheet=Main%20Sheet
```

Cell-by-cell reads through the Sheets UI are unreliable at this size; the
`gviz` endpoint returns the whole tab in one request.
