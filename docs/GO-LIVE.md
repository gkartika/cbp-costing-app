# Go-live runbook

Cutover procedure for putting the CBP Costing App in front of real users, and
how to get back if pricing looks wrong on day one.

The thing this app must never do is quote a wrong price and be unable to
explain why. Every step below exists to protect that: the guide package goes
in through validation rather than a database copy, the first real quotation is
checked by hand against a known-good number, and a rollback restores a whole
guide version rather than editing rows.

---

## Before the day

**1. Confirm the production database is reachable and empty.**

```bash
DATABASE_URL=postgres://…  npm run provision -- --username=admin --password='<long password>' --displayName='CBP Admin'
```

This applies migrations, creates the first Super Admin, and reports whether a
guide version is published. It **refuses to run** against a database that
already has users or costings — if you see that refusal on production, stop and
find out what is already there rather than passing `--force`.

The password must be at least 12 characters. This account can change every
price in the system.

**2. Export the guide package from the environment where the rate cards were built.**

```bash
npm run export:guide -- guide-package.xlsx
```

Exports the currently published version — materials, raw bar stock, dies
costs, price per kg, minimums, adjustment rules, coating, quotation terms,
app config and the golden simulation cases.

Only **active** rows are exported. Editing master data deactivates the old row
and inserts a replacement, so a long-lived version carries tombstones that
would collide on import; the tombstone records that *this* environment changed
its mind, and the reason stays in `audit_events` here.

**3. Import it on production through Guide Admin, not the database.**

Upload `guide-package.xlsx` in Guide Admin → Validate → Publish.

Import re-runs every gate: schema, duplicate business keys, range coverage,
raw-bar sourcing, and all 54 golden simulation cases. A package that produces
a different price than it did in the source environment fails here, which is
the entire point of promoting this way. Copying rows between databases would
move the same data and skip all of it.

**4. Create the real user accounts.**

```bash
npm run seed:user -- --username=<u> --password='<p>' --displayName='<Name>' --role=costing_user
```

`super_admin` is deliberately not creatable this way — use `seed:admin` or an
existing Super Admin in the app.

**5. Take a baseline backup.**

```bash
npm run backup
```

Writes a timestamped `pg_dump` custom-format file under `backups/`. This is the
restore point for the day.

---

## On the day

**6. Smoke test with a known quotation.**

Price one item whose correct answer is already known — ideally one your team
has quoted recently by hand — and compare the number. Then open **Explain** on
the line and confirm the resolved rules are the ones you expect.

If the number is right but a rule looks wrong, the price is right by accident.
Treat that as a failure.

**7. Price one set.**

Most of what the team quotes is an assembly (DEC-017), so smoke-test one too:
add a Set, give it two components with a quantity per set above one, and check
that the set price equals the sum of the component prices times their per-set
counts. Open **Explain** on the set — it lists the components with the quantity
each will actually be manufactured in, which is what the quantity break and
dies amortisation used.

**8. Check the quotation output.**

Finalize that costing and download the XLSX. Confirm the letterhead, terms,
payment terms and salesperson name are correct, that the total excludes PPN,
and that a set appears as **one** priced line with its components listed under
it — not as separately priced rows.

**9. Hand over.**

Point users at the app. Keep the previous process available for the first
week — the point of a pilot is that you can still fall back.

---

## Rollback

**Wrong prices, guide-level.** Publish the previous guide version from Guide
Admin. Every past costing keeps the `guide_version_id` it was priced against,
so finalized quotations are unaffected — republishing changes what *new*
calculations use, not what old ones recorded.

**Wrong prices, one rate card.** Fix the rows in Master Data and publish. That
clones the current version forward with your patch and re-runs validation, so
a fix that breaks a golden case is rejected before it reaches anyone.

**Data damage.** Restore the baseline backup:

```bash
npm run restore -- backups/<file>.backup
```

This is a full-database restore. Anything entered after the backup is lost, so
prefer the two guide-level options above unless the damage is structural.

**Application defect.** `git revert` the offending commit and redeploy. CI runs
typecheck, lint and the full suite against a real Postgres on every push, so a
revert that breaks something else is caught before it lands.

---

## What to watch in the first week

- **Minimum price is binding more than expected.** Cheap Nut items and Bolt
  orders above roughly 500 pieces clamp to the floor, which means the volume
  discount stops being visible on those lines. That is arithmetic, not a bug —
  but if the quoted price looks flat across quantities, this is why.
- **Inch sizes at 2-3/4" and above** are priced from the largest metric entry
  (M64), because the metric card stops there. Confirm those quotes by hand.
- **Grade 4.6 at 3-1/4" and 3-1/2"** is deliberately unpriced: no raw bar is
  stocked that large. The app will refuse rather than invent a price.
- **The small-end price-card gap (Bolt/Nut/Stud-Anchor) is filled, not just
  bridged.** `resolvePricePerKg` still has a next-bigger-size fallback for
  any future gap (business decision 2026-09-04), but the 99 rows actually
  missing at the time — Nut 4.6/A563/6.8, Bolt 4.6/5.6/6.8/A307/A307B,
  ten Stud/Anchor grades — were filled via `npm run fill:price-gaps` on
  2026-09-04, each priced at exactly what the fallback was already
  returning, so no quote changed. Explain no longer shows a substitution
  note for these; if one appears for a grade/size not in that list, that's
  a genuinely new gap, not this one recurring.
- **Washer Custom Production (A36, F35) now actually calculates.** Their
  material_size_guides rows had never existed in any guide version — every
  line failed with RAW_SIZE_INVALID regardless of price. Filled 2026-09-04
  via `npm run fill:washer-dimensions`, sourced from DIN 125 Form A
  (business-confirmed). A36 and F35 share one `product_profile` ("Washer")
  in grade_profile_rules, and material_size_guides is keyed on
  (profile, size), so the two grades cannot carry different dimensions
  without also splitting that profile — a larger decision than filling
  geometry, so both currently resolve to the same DIN 125 numbers. Revisit
  if F35's real structural-washer dimensions (JIS B1186, which only
  formally covers M20-M33 anyway) need to diverge from A36's.
  F436 is untouched: it prices via Trading with real `weight_kg` already on
  every `trading_items` row, so it never touches material_size_guides.
  Its `thickness` column is mostly still null — cosmetic only, Trading
  pricing doesn't read it — left unfilled rather than guessed across a
  0.5"-3"/M14-M72 range with no single authoritative source found.
- **"Zinc" coating priced correctly now — it never did before.** All 68 rows
  the "Zinc" dropdown option resolved to were dies/tooling cost data
  (`process_name='Dies'`, `process_group='Tooling'`, `basis='IDR_per_set'`,
  rates 2.5M-15.6M) mislabeled `display_label='Zinc'` — byte-for-byte
  duplicates of `dies_cost_guides`. Selecting Zinc multiplied an item's
  weight in kg by a rate meant to be a flat per-set tooling charge in the
  millions, as if it were IDR/kg, and couldn't even pick the size-correct
  row since none of those 68 carried a diameter tier. A migration comment
  had rationalized this as intentional, citing a "DEC-041" that doesn't
  exist anywhere in docs/ — nobody had checked it against
  `docs/LEGACY-DATA-STUDY.md` (Zinc used in 141 real historical quotation
  lines as its own coating, not a dies-cost alias) or against
  `dies_cost_guides` itself. Fixed 2026-09-10 via `npm run fix:zinc-coating`:
  the 68 rows are deactivated and a real `process_name='Zinc'` row was added
  — IDR 5,000/kg flat, no diameter tiers, applies to every item type
  (business-confirmed). If "Zinc" pricing ever looks flat/uniform regardless
  of size again, that's expected — it's the one coating without tiers, unlike
  HDG and PTFE.
- **Coating on an item smaller than the smallest diameter tier now falls back
  to that smallest tier's rate, instead of refusing.** Auditing HDG/PTFE
  after the Zinc fix turned up real gaps: HDG's tiers start at 8mm and PTFE's
  at 10mm, so a 1/4" (6.35mm) or 5/16" (7.9375mm) Bolt/Nut/Washer with either
  coating threw `COATING_GUIDE_NOT_FOUND`. Business-confirmed 2026-09-12:
  same "never smaller, never a different scope" rule `resolvePricePerKg`
  already applies to price gaps, now generalized in `resolveCoatingRule` to
  every coating (HDG, PTFE, Zinc, and any future one) — no master-data
  change needed, since it's the resolution logic that was too strict, not
  the rate card. Explain shows a substitution note whenever this fires; a
  coating that has genuinely no scope for a product type at all (e.g. HDG
  has no "Anchor" item_scope) still throws — that's a real gap, not a size
  issue, and is unaffected by this change.
- **Set components price on the produced quantity, not the set count**
  (DEC-017). A set of 300 with 2 nuts each prices those nuts as 600 pieces, so
  a component can land in a quantity band the set count alone would not reach,
  and dies amortise over the larger run. If a set looks cheaper than the team
  expects, check the band on the component's Explain first.
- **Logs.** Every request emits one JSON line with method, path, status,
  duration and `requestId` — the same `requestId` recorded on `audit_events`,
  so a reported bad quote can be traced across both.
