# Backtest against CBP's own quoting history

First run: 2026-08-27, against guide `AUTO-quotation-terms-1787701195255`.
Reproduce with `npm run backtest:legacy`.

## What is being tested

The legacy sheet records both the price quoted (`Bolt Price/Unit`) and the
weight-formula price behind it (`Price/Unit(Berat)` = `Weight/Unit` ×
`Harga / Kg`). Where those agree, the quote was pure formula output with no
human markup — real inputs with a known-correct answer.

The recorded number is weight × rate and nothing more: no quantity break, no
lead-time surcharge, no length-ratio uplift, no minimum floor, no coating.
Comparing it to the app's final `unitSellingPrice` would compare two different
quantities. So the comparison happens one layer down, on the two inputs that
produce it — **weight** (geometry formulas and size guide) and **price per kg**
(rate card and grade resolution) — which means a disagreement points at a
specific card rather than at "the price is wrong".

## Results

Of 10,610 sheet rows, **1,687** are backtestable. The rest are excluded for
reasons that are themselves informative:

| Excluded | Rows | Why |
|---|---|---|
| Human markup over formula | 3,918 | Quoted above the weight calc — the pricing judgement this app is trying to encode |
| No weight-formula price | 3,534 | Weight or rate blank |
| Composite grade | 1,264 | `B7; 2H; F436` — no way to tell which grade the bolt column used |
| Unsupported product family | 206 | Anchor, U-bolt, Socket Head, etc. |
| Unparseable size | 12 | Long-tail formats |

| Check | Result |
|---|---|
| Priced without error | **1,330 / 1,687 — 78.8%** |
| Weight agrees (±2%) | **628 / 1,330 — 47.2%** |
| Price per kg agrees (±2%) | 489 / 1,330 — 36.8% |
| **Both agree — line fully reproduced** | **257 / 1,687 — 15.3%** |

The sheet's `Weight/Unit` matches the app's *costing* weight (raw + 2%
tolerance) far better than the raw weight — 47.2% against 27.2% — so the
spreadsheet's stored weight already includes the tolerance.

## Finding 1 — raw bar diameter is missing on 18 metric sizes

**This is the main result, and it is actionable.**

Holding everything else constant on Heavy Hex Bolt, grade B7, M20:

| Length (mm) | App (costing kg) | Sheet (kg) | Ratio |
|---|---|---|---|
| 40 | 0.231 | 0.25 | 0.922 |
| 95 | 0.369 | 0.42 | 0.878 |
| 170 | 0.558 | 0.65 | 0.858 |
| 350 | 1.010 | 1.20 | 0.842 |

The ratio *drifts with length* rather than sitting at a constant, which means
the shank term is short, not the head. Fitting the two slopes gives
0.00251 kg/mm against the sheet's 0.00306 — an area ratio of 0.820, so an
implied raw bar of **22.1mm where the app uses 20mm**.

The size guide confirms it. Every Heavy Hex metric size is upsized to the next
stocked bar — M12→14, M14→16, M16→19, M22→25, M24→25, M27→30, M33→35, M36→38
— **except M20 and M30, which sit at nominal**. And the Regular Hex row for the
same M20 says `raw_diameter_mm = 22`, which is exactly the figure CBP's own
weights imply.

18 metric sizes have `raw_diameter_mm = diameter_mm`:

- Heavy Hex: **M20**, **M30**, M45, M60, M70, M80, M85, M90, M100
- Regular Hex: **M30**, M45, M60, M70, M80, M85, M90, M100, M110

No inch size has this problem — all 0 of them.

M20 is the single most-quoted size in CBP's history and accounts for 199 of the
weight disagreements; M22, M16 and M36 follow. **Any bolt at these sizes is
quoted roughly 15–18% underweight**, and since price is weight × rate, that is
15–18% under-priced.

This needs a business decision, not a code change — raw bar diameter is a
pricing input, and changing it moves every price at those sizes. The evidence
says these rows were never filled in and fell back to nominal. Confirming the
right bar for each is a Master Data edit, which re-runs validation and the
golden cases on publish.

## Finding 2 — 21% of history cannot be priced at all

| Reason | Rows | What it means |
|---|---|---|
| `PROFILE_NOT_FOUND` | 180 | Grade has no `grade_profile_rules` entry — B8, A325M, SS316, SS316L |
| `PRICE_GUIDE_NOT_FOUND` | 108 | No rate for that grade+size — M26 recurs |
| `RAW_SIZE_INVALID` | 69 | Size guide has no row, or no bar stock reaches it |

These are the alias and coverage gaps [the study](LEGACY-DATA-STUDY.md) predicted
from vocabulary alone, now confirmed against real lines. `B8` and `B8M` already
have alias rows; `A325M`, `SS316`, `SS316L` and `SS304` do not, and M26 is
absent from the rate card.

## Finding 3 — the rate card is not expected to match, and does not

Price per kg agrees on only 36.8%, with the app's rate running below the
sheet's (median ratio 0.91, p10 0.71). This is **not** obviously a defect. The
study already found `Harga / Kg` varies enormously *within* a single grade — 8.8
ranges from 5,000 to 128,575 — because the spreadsheet's rate is a per-deal
number carrying material cost, process and negotiation, not a fixed card
lookup. A single published rate card cannot reproduce a per-deal number, and
arguably should not try.

What this measurement is good for is direction: the app is systematically
*below* what CBP historically charged per kg. Combined with Finding 1, the two
errors compound in the same direction.

## Caveat on the harness

The first run had a bug worth recording. Sizes are written with mixed units in
the same quotation — `1/2" x 40` means 40 **millimetres**, while `1" x 4"` means
4 **inches** — and the parser read both as millimetres, turning a 100mm bolt
into a 4mm one. Fixed; the length is now only inches when it carries an inch
mark. It moved the weight agreement from 45.4% to 47.2% and removed the worst
outliers.

Two things this harness deliberately does not do: it passes no coating, lead
time or dies option, and it infers product family from the leading noun of
`SPECIFICATION`. Product *profile* is left to the engine, which derives it from
grade — checked and sound: A325/B7/A307B/B8M are almost exclusively Heavy Hex in
the history, and 8.8/10.9/12.9/SS304/SS316 almost exclusively regular Hex.

## Next

1. Confirm the raw bar diameter for the 18 sizes above (Finding 1) — highest
   value, and it moves real prices.
2. Add the missing grade aliases and the M26 rate rows (Finding 2).
3. Re-run this backtest after each, and watch the "fully reproduced" number.
