import { describe, it, expect } from "vitest";
import { evaluateFormula, validateFormula, parseFormula, FormulaError } from "../src/lib/calc/formulaDsl";

describe("formula DSL", () => {
  it("evaluates the Stud raw-cut formula and matches the SIM-STUD-M20X1000 fixture", () => {
    const expr = "raw_weight=PI()*(raw_diameter/2)^2*finished_length*density*1e-9;costing_weight=raw_weight*1.02";
    const result = evaluateFormula(expr, {
      raw_diameter: 22,
      finished_length: 1000,
      density: 7850,
    });
    expect(result.raw_weight as number).toBeCloseTo(2.984041782, 6);
    expect(result.costing_weight as number).toBeCloseTo(3.043722618, 6);
  });

  it("evaluates COALESCE, IF and comparison operators (Nut formula shape)", () => {
    const expr =
      "corner=COALESCE(width_corner,width_flat*1.154);" +
      "thickness=IF(grade='2H',diameter,0.8*diameter);" +
      "forging_ID=IF(diameter<20,0,0.85*diameter);" +
      "volume=PI()*((corner/2)^2-(forging_ID/2)^2)*thickness";

    // width_corner present -> COALESCE picks it directly.
    const withCorner = evaluateFormula(expr, { width_corner: 32, width_flat: 30, grade: "2H", diameter: 20 });
    expect(withCorner.corner).toBe(32);
    expect(withCorner.thickness).toBe(20); // grade='2H' -> thickness = diameter
    expect(withCorner.forging_ID).toBe(17); // diameter >= 20 -> 0.85 * 20

    // width_corner absent -> COALESCE falls back to width_flat * 1.154.
    const withoutCorner = evaluateFormula(expr, { width_corner: null as unknown as number, width_flat: 30, grade: "8.8", diameter: 10 });
    expect(withoutCorner.corner as number).toBeCloseTo(34.62, 6);
    expect(withoutCorner.thickness).toBeCloseTo(8, 6); // not 2H -> 0.8 * diameter
    expect(withoutCorner.forging_ID).toBe(0); // diameter < 20 -> 0
  });

  it("rejects a formula that calls a function outside the allow-list", () => {
    expect(() => parseFormula("x=EXEC('rm -rf /')")).not.toThrow(); // parses structurally
    const check = validateFormula("x=EXEC(1)", []);
    expect(check.valid).toBe(false);
  });

  it("rejects a formula referencing an undeclared identifier", () => {
    const check = validateFormula("x=undeclared_var*2", ["declared_var"]);
    expect(check.valid).toBe(false);
  });

  it("accepts a formula whose identifiers are all declared or previously assigned", () => {
    const check = validateFormula("a=x*2;b=a+y", ["x", "y"]);
    expect(check.valid).toBe(true);
  });

  it("throws at evaluation time on division by zero rather than returning Infinity", () => {
    expect(() => evaluateFormula("x=1/y", { y: 0 })).toThrow(FormulaError);
  });
});
