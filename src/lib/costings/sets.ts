/**
 * Set pricing (DEC-017).
 *
 * A set line is a customer-facing assembly — "Hex Bolt c/w Hex Nut, Washer" —
 * whose price comes from its components rather than from the calculator
 * directly. The set carries the quantity ordered; each component carries how
 * many of it go into one set.
 *
 * Everything here is arithmetic over already-priced components. The pricing
 * itself stays in customPipeline, which never learns that sets exist.
 */
import type { CostingLineRow } from "./lines";

/**
 * How many of this component actually get manufactured.
 *
 * This is the number the calculator must see, not the set count. Ordering 100
 * sets of "Stud Bolt c/w 2 Heavy Hex Nut" means making 200 nuts, and both
 * quantity-driven parts of the pipeline depend on knowing that: the quantity
 * break card resolves on how many pieces are produced, and dies cost is a
 * one-time tooling charge amortised across the run — spreading a nut die over
 * 100 instead of 200 pieces would overcharge every set by half the tooling.
 */
export function effectiveComponentQty(qtyPerSet: number, setQty: number): number {
  return qtyPerSet * setQty;
}

export type SetTotals = {
  basePricePerSet: number;
  coatingPricePerSet: number;
  diesPricePerSet: number;
  /** Sum of component selling prices — each already rounded, so the set price lands on the rounding grid without rounding again. */
  pricePerSet: number;
  orderTotal: number;
};

export type PricedComponent = {
  qtyPerSet: number;
  basePricePerItem: number;
  coatingPricePerItem: number;
  diesPricePerItem: number;
  unitSellingPrice: number;
};

/**
 * Components are rounded individually and then summed, which is how CBP's
 * spreadsheet has always done it: every component price in the legacy history
 * is a round number and Price/Set is their exact total. Summing first and
 * rounding once would quote a different number than the team's own records for
 * the same set.
 */
export function sumSet(components: PricedComponent[], setQty: number): SetTotals {
  const acc = components.reduce(
    (a, c) => ({
      basePricePerSet: a.basePricePerSet + c.basePricePerItem * c.qtyPerSet,
      coatingPricePerSet: a.coatingPricePerSet + c.coatingPricePerItem * c.qtyPerSet,
      diesPricePerSet: a.diesPricePerSet + c.diesPricePerItem * c.qtyPerSet,
      pricePerSet: a.pricePerSet + c.unitSellingPrice * c.qtyPerSet,
    }),
    { basePricePerSet: 0, coatingPricePerSet: 0, diesPricePerSet: 0, pricePerSet: 0 },
  );
  return { ...acc, orderTotal: acc.pricePerSet * setQty };
}

export type LineTree<T> = { line: T; components: T[] };

/**
 * Rebuilds the parent/child nesting from a flat, line_no-ordered result set.
 *
 * Components share the costing's single line_no sequence, so a component added
 * later sorts after unrelated top-level lines. Nesting is therefore rebuilt
 * from parent_line_id rather than read off the ordering — which also keeps the
 * five aggregation queries that read snapshots on a plain `ORDER BY line_no`.
 */
export function buildLineTree<T extends { costingLineId: string; parentLineId: string | null; lineNo: number }>(
  lines: T[],
): LineTree<T>[] {
  const byParent = new Map<string, T[]>();
  for (const l of lines) {
    if (l.parentLineId === null) continue;
    const siblings = byParent.get(l.parentLineId);
    if (siblings) siblings.push(l);
    else byParent.set(l.parentLineId, [l]);
  }
  return lines
    .filter((l) => l.parentLineId === null)
    .map((line) => ({
      line,
      components: (byParent.get(line.costingLineId) ?? []).sort((a, b) => a.lineNo - b.lineNo),
    }));
}

/**
 * CBP's assembly naming: the first component leads, the rest follow after
 * "c/w" with their multiplier — "Bolt, A193-B7, HT M20x80 c/w 2 Nut, A194-2H
 * M20, Washer, F436 M20". Matches the convention in the legacy sheet, where
 * the count sits in front of the component it applies to and a count of one is
 * left implicit.
 *
 * Used only when the user leaves the set's Description blank, so a quotation
 * never ships an unlabelled assembly line.
 */
export function defaultSetDescription(componentDescriptions: { description: string; qtyPerSet: number }[]): string {
  const parts = componentDescriptions.filter((c) => c.description.trim());
  if (parts.length === 0) return "";
  const [lead, ...rest] = parts;
  const head = lead.qtyPerSet > 1 ? `${lead.qtyPerSet} ${lead.description}` : lead.description;
  if (rest.length === 0) return head;
  return `${head} c/w ${rest.map((c) => (c.qtyPerSet > 1 ? `${c.qtyPerSet} ${c.description}` : c.description)).join(", ")}`;
}

/** A set with no components has no price; calculating one would silently quote zero. */
export function assertSetHasComponents(line: Pick<CostingLineRow, "line_kind" | "line_no">, componentCount: number) {
  if (line.line_kind === "set" && componentCount === 0) {
    throw new Error(`Set #${line.line_no} has no components`);
  }
}
