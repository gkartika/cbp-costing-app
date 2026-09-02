/**
 * Replays CBP's own quoting history through the calculation engine.
 *
 * The legacy spreadsheet records, per line, both the price that was quoted
 * (`Bolt Price/Unit`) and the weight-formula price it was derived from
 * (`Price/Unit(Berat)` = `Weight/Unit` x `Harga / Kg`). On roughly 3,100 lines
 * those two agree, which means the quote was pure formula output with no human
 * markup on top. Those lines are a free regression suite: real inputs with a
 * known-correct answer, far broader than the 54 hand-written golden cases.
 *
 * What this compares, and why it is not the final price:
 *
 *   The recorded number is weight x price-per-kg and nothing else — no
 *   quantity break, no lead-time surcharge, no length-ratio uplift, no minimum
 *   floor, no coating. Comparing it against the app's `unitSellingPrice` would
 *   compare two different quantities and report failures that are really just
 *   adjustments doing their job. So the comparison is made one layer down, on
 *   the two inputs that produce the recorded number:
 *
 *     1. WEIGHT      — tests the geometry formulas and the size guide.
 *     2. PRICE/KG    — tests the rate card and grade resolution.
 *
 *   Splitting them means a disagreement points at a specific card rather than
 *   at "the price is wrong".
 *
 * The sheet does not say whether its `Weight/Unit` is the raw calculated
 * weight or the costing weight with the 2% tolerance already added, so both
 * are scored and the report says which fits better.
 *
 * Usage:
 *   npm run backtest:legacy            # fetches the sheet (cached locally)
 *   npm run backtest:legacy -- --refresh
 *   npm run backtest:legacy -- --limit=200 --verbose
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { pool } from "../src/lib/db";
import { loadGuideContext } from "../src/lib/calc/loadGuideContext";
import { calculateCustomLine, type CustomLineInput } from "../src/lib/calc/customPipeline";
import { toAppError } from "../src/lib/errors";

const SHEET_ID = "1KquH3FCRP_j8vHdikDn6MghmBHsq7FVNGdJEKuoEvRM";
const SHEET_TAB = "Main Sheet";
const CACHE_DIR = join(process.cwd(), ".cache");
const CACHE_FILE = join(CACHE_DIR, "legacy-main-sheet.csv");

const arg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};
const has = (flag: string) => process.argv.includes(`--${flag}`);

// ---------------------------------------------------------------- source data

async function loadCsv(): Promise<string> {
  if (!has("refresh") && existsSync(CACHE_FILE)) {
    return readFileSync(CACHE_FILE, "utf8");
  }
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, text, "utf8");
  return text;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// Main Sheet column positions (see docs/LEGACY-DATA-STUDY.md).
const COL = {
  coating: 8,
  spec: 9,
  size: 10,
  grade: 11,
  thread: 12,
  qty: 13,
  boltPricePerUnit: 14,
  weightPerUnit: 15,
  hargaPerKg: 16,
  pricePerUnitBerat: 17,
  quoteNo: 6,
} as const;

const num = (v: string | undefined): number => {
  const x = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isNaN(x) ? 0 : x;
};

/**
 * The leading noun of SPECIFICATION names the part the Bolt Price/Unit column
 * refers to. Assemblies ("Hex Bolt c/w Hex Nut") still price their bolt in
 * this column, so the prefix is what matters, not the whole string.
 */
function familyOf(spec: string): CustomLineInput["productFamily"] | null {
  const s = spec.trim();
  if (/^(Heavy Hex Bolt|Hex Bolt|Machine Bolt)/i.test(s)) return "Bolt";
  if (/^(Heavy Hex Nut|Hex Nut)/i.test(s)) return "Nut";
  if (/^(Stud Bolt|Double Ended)/i.test(s)) return "Stud / Anchor";
  if (/^Washer/i.test(s)) return "Washer";
  return null;
}

type ParsedSize = { label: string; diameterMm: number; lengthMm: number | null };

const MM_PER_INCH = 25.4;

/**
 * Parses the leading diameter of a size string into the guide's own label
 * form — "M20" for metric, "1/2" and "2-1/2" for inch.
 */
function parseDiameter(s: string): { label: string; diameterMm: number; rest: string } | null {
  let m = s.match(/^M\s?(\d+(?:\.\d+)?)/);
  if (m) return { label: `M${m[1]}`, diameterMm: +m[1], rest: s.slice(m[0].length) };
  m = s.match(/^(\d+)\s*-\s*(\d+)\/(\d+)\s*"?/);
  if (m) {
    return {
      label: `${m[1]}-${m[2]}/${m[3]}`,
      diameterMm: (+m[1] + +m[2] / +m[3]) * MM_PER_INCH,
      rest: s.slice(m[0].length),
    };
  }
  m = s.match(/^(\d+)\/(\d+)\s*"?/);
  if (m) return { label: `${m[1]}/${m[2]}`, diameterMm: (+m[1] / +m[2]) * MM_PER_INCH, rest: s.slice(m[0].length) };
  m = s.match(/^(\d+)\s*"/);
  if (m) return { label: m[1], diameterMm: +m[1] * MM_PER_INCH, rest: s.slice(m[0].length) };
  return null;
}

/**
 * Length after the "x". The unit is not fixed by the diameter's unit — the
 * same quotation writes `1/2" x 40` (millimetres) and `1" x 4"` (inches) — so
 * only an explicit inch mark makes it inches. Reading `4"` as 4mm turns a
 * 100mm bolt into a 4mm one, which is silent and severe: it produced the
 * worst outliers in the first run of this backtest.
 */
function parseLength(rest: string): number | null {
  const s = rest.replace(/^\s*[xX]\s*/, "");
  if (s === rest) return null; // no "x" separator, so no length component

  let m = s.match(/^(\d+)\s*-\s*(\d+)\/(\d+)\s*"/);
  if (m) return (+m[1] + +m[2] / +m[3]) * MM_PER_INCH;
  m = s.match(/^(\d+)\/(\d+)\s*"/);
  if (m) return (+m[1] / +m[2]) * MM_PER_INCH;
  m = s.match(/^(\d+(?:\.\d+)?)\s*"/);
  if (m) return +m[1] * MM_PER_INCH;
  m = s.match(/^(\d+(?:\.\d+)?)/);
  if (m) return +m[1];
  return null;
}

function parseSize(raw: string): ParsedSize | null {
  const d = parseDiameter(raw.trim());
  if (!d) return null;
  return { label: d.label, diameterMm: d.diameterMm, lengthMm: parseLength(d.rest) };
}

type Case = {
  family: CustomLineInput["productFamily"];
  grade: string;
  size: ParsedSize;
  threadCondition: string | null;
  qty: number;
  expectedPrice: number;
  expectedWeight: number;
  expectedPerKg: number;
  quoteNo: string;
  spec: string;
};

function buildCases(rows: string[][]): { cases: Case[]; skipped: Record<string, number> } {
  const cases: Case[] = [];
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };

  for (const r of rows.slice(1)) {
    if (!r.some((v) => v && v.trim())) continue;

    const quoted = num(r[COL.boltPricePerUnit]);
    const formula = num(r[COL.pricePerUnitBerat]);
    if (!quoted || !formula) {
      skip("no weight-formula price");
      continue;
    }
    // Within 1% (or Rp100) counts as "the formula was used verbatim" — the
    // sheet rounds displayed prices, so exact equality is too strict.
    if (Math.abs(quoted - formula) > Math.max(100, formula * 0.01)) {
      skip("human markup over formula");
      continue;
    }
    // A composite grade ("B7; 2H; F436") names one grade per component and
    // there is no way to tell from here which applies to the bolt column.
    const grades = (r[COL.grade] ?? "").split(";").map((g) => g.trim()).filter(Boolean);
    if (grades.length !== 1) {
      skip("composite grade");
      continue;
    }
    const family = familyOf(r[COL.spec] ?? "");
    if (!family) {
      skip("unsupported product family");
      continue;
    }
    const size = parseSize(r[COL.size] ?? "");
    if (!size) {
      skip("unparseable size");
      continue;
    }
    const qty = num(r[COL.qty]);
    if (!qty) {
      skip("no quantity");
      continue;
    }

    const thread = (r[COL.thread] ?? "").trim();
    cases.push({
      family,
      grade: grades[0],
      size,
      // The column is reused on anchor/U-bolt rows to hold leg dimensions, so
      // only the two real values are accepted.
      threadCondition: thread === "FT" || thread === "HT" ? thread : null,
      qty,
      expectedPrice: quoted,
      expectedWeight: num(r[COL.weightPerUnit]),
      expectedPerKg: num(r[COL.hargaPerKg]),
      quoteNo: (r[COL.quoteNo] ?? "").trim(),
      spec: (r[COL.spec] ?? "").trim(),
    });
  }
  return { cases, skipped };
}

// ---------------------------------------------------------------- comparison

/** Within 2% counts as agreement: the sheet stores rounded weights and prices. */
const TOLERANCE = 0.02;
const agrees = (a: number, b: number) => b !== 0 && Math.abs(a - b) / b <= TOLERANCE;

type Outcome =
  | { kind: "ok"; c: Case; weightRaw: number; weightCosting: number; perKg: number }
  | { kind: "error"; c: Case; code: string; message: string };

function pct(n: number, of: number): string {
  return of === 0 ? "—" : `${((n / of) * 100).toFixed(1)}%`;
}

function summarise(label: string, hits: number, total: number): string {
  return `${label.padEnd(28)} ${String(hits).padStart(5)} / ${String(total).padEnd(5)}  ${pct(hits, total).padStart(6)}`;
}

/** Groups failures by a key so the report points at a card, not at 400 rows. */
function topGroups(items: string[], n = 12): [string, number][] {
  const counts: Record<string, number> = {};
  for (const i of items) counts[i] = (counts[i] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function main() {
  const csv = await loadCsv();
  const rows = parseCsv(csv);
  const { cases: allCases, skipped } = buildCases(rows);

  const limit = arg("limit") ? Number(arg("limit")) : undefined;
  const cases = limit ? allCases.slice(0, limit) : allCases;

  const { rows: published } = await pool.query<{ guide_version_id: string; version_code: string }>(
    `SELECT guide_version_id, version_code FROM guide_versions WHERE status = 'published' LIMIT 1`,
  );
  if (published.length === 0) throw new Error("No published guide version to test against.");
  const ctx = await loadGuideContext(published[0].guide_version_id);

  console.log(`Guide version : ${published[0].version_code}`);
  console.log(`Sheet rows    : ${rows.length - 1}`);
  console.log(`Backtestable  : ${allCases.length}${limit ? ` (running ${cases.length})` : ""}\n`);

  console.log("Rows excluded, and why:");
  for (const [why, n] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${why.padEnd(30)} ${String(n).padStart(5)}`);
  }
  console.log();

  const outcomes: Outcome[] = [];
  for (const c of cases) {
    const input: CustomLineInput = {
      productFamily: c.family,
      gradeOrSpec: c.grade,
      sizeLabel: c.size.label,
      diameterMm: c.size.diameterMm,
      qty: c.qty,
      leadTimeDays: null,
      lengthMm: c.size.lengthMm,
      developedCutLengthMm: null,
      threadCondition: c.threadCondition,
      coatingCode: null,
      diesOption: "yes",
      diesTotalCost: null,
    };
    try {
      const r = calculateCustomLine(ctx, input);
      outcomes.push({
        kind: "ok",
        c,
        weightRaw: r.rawWeightPerItemKg,
        weightCosting: r.costingWeightPerItemKg,
        perKg: r.pricePerKg,
      });
    } catch (err) {
      const e = toAppError(err);
      outcomes.push({ kind: "error", c, code: e.code, message: e.userMessage });
    }
  }

  const priced = outcomes.filter((o): o is Extract<Outcome, { kind: "ok" }> => o.kind === "ok");
  const errored = outcomes.filter((o): o is Extract<Outcome, { kind: "error" }> => o.kind === "error");

  console.log("=".repeat(64));
  console.log("PRICEABILITY");
  console.log("=".repeat(64));
  console.log(summarise("priced without error", priced.length, cases.length));
  if (errored.length > 0) {
    console.log("\n  failures by reason:");
    for (const [code, n] of topGroups(errored.map((o) => o.code))) {
      console.log(`    ${code.padEnd(32)} ${String(n).padStart(5)}`);
    }
    console.log("\n  failures by grade / size:");
    for (const [k, n] of topGroups(errored.map((o) => `${o.c.family} ${o.c.grade} ${o.c.size.label}`))) {
      console.log(`    ${k.padEnd(32)} ${String(n).padStart(5)}`);
    }
  }

  const withWeight = priced.filter((o) => o.c.expectedWeight > 0);
  const rawHits = withWeight.filter((o) => agrees(o.weightRaw, o.c.expectedWeight));
  const costingHits = withWeight.filter((o) => agrees(o.weightCosting, o.c.expectedWeight));

  console.log("\n" + "=".repeat(64));
  console.log(`WEIGHT  (within ${TOLERANCE * 100}%)`);
  console.log("=".repeat(64));
  console.log(summarise("raw weight matches", rawHits.length, withWeight.length));
  console.log(summarise("costing weight (+tol) matches", costingHits.length, withWeight.length));
  const better = costingHits.length >= rawHits.length ? "costing (tolerance included)" : "raw (no tolerance)";
  console.log(`\n  The sheet's Weight/Unit best matches: ${better}`);

  const weightMisses = withWeight.filter(
    (o) => !agrees(o.weightRaw, o.c.expectedWeight) && !agrees(o.weightCosting, o.c.expectedWeight),
  );
  if (weightMisses.length > 0) {
    console.log("\n  disagreements by family / size:");
    for (const [k, n] of topGroups(weightMisses.map((o) => `${o.c.family} ${o.c.size.label}`))) {
      console.log(`    ${k.padEnd(32)} ${String(n).padStart(5)}`);
    }
    const ratios = weightMisses.map((o) => o.weightRaw / o.c.expectedWeight).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    console.log(`\n  median app/sheet weight ratio on misses: ${median.toFixed(3)}`);
  }

  const withKg = priced.filter((o) => o.c.expectedPerKg > 0);
  const kgHits = withKg.filter((o) => agrees(o.perKg, o.c.expectedPerKg));

  console.log("\n" + "=".repeat(64));
  console.log(`PRICE PER KG  (within ${TOLERANCE * 100}%)`);
  console.log("=".repeat(64));
  console.log(summarise("rate card matches", kgHits.length, withKg.length));

  const kgMisses = withKg.filter((o) => !agrees(o.perKg, o.c.expectedPerKg));
  if (kgMisses.length > 0) {
    console.log("\n  disagreements by grade:");
    for (const [k, n] of topGroups(kgMisses.map((o) => o.c.grade))) {
      console.log(`    ${k.padEnd(32)} ${String(n).padStart(5)}`);
    }
    const ratios = kgMisses.map((o) => o.perKg / o.c.expectedPerKg).sort((a, b) => a - b);
    console.log(
      `\n  app/sheet rate ratio on misses — p10 ${ratios[Math.floor(ratios.length * 0.1)].toFixed(2)}` +
        `  median ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}` +
        `  p90 ${ratios[Math.floor(ratios.length * 0.9)].toFixed(2)}`,
    );
  }

  const bothHit = priced.filter(
    (o) =>
      o.c.expectedWeight > 0 &&
      o.c.expectedPerKg > 0 &&
      (agrees(o.weightRaw, o.c.expectedWeight) || agrees(o.weightCosting, o.c.expectedWeight)) &&
      agrees(o.perKg, o.c.expectedPerKg),
  );
  console.log("\n" + "=".repeat(64));
  console.log("BOTH  (weight and rate agree — the app reproduces the line end to end)");
  console.log("=".repeat(64));
  console.log(summarise("fully reproduced", bothHit.length, cases.length));

  if (has("verbose")) {
    console.log("\nFirst 20 disagreements:");
    for (const o of [...weightMisses, ...kgMisses].slice(0, 20)) {
      console.log(
        `  ${o.c.quoteNo.padEnd(14)} ${o.c.spec.slice(0, 28).padEnd(30)} ${o.c.grade.padEnd(8)} ${o.c.size.label.padEnd(8)}` +
          ` wt ${o.weightRaw.toFixed(3)} vs ${o.c.expectedWeight}   kg ${o.perKg} vs ${o.c.expectedPerKg}`,
      );
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
