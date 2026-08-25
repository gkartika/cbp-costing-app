/**
 * Controlled expression DSL for Calculation_Formulas (PKG-011 / VAL-028).
 * Formulas look like:
 *   corner=COALESCE(width_corner,width_flat*1.154);
 *   raw_weight=PI()*(raw_diameter/2)^2*finished_length*density*1e-9;
 *   costing_weight=raw_weight*1.02
 *
 * This is a hand-written lexer/parser/evaluator over a small allow-listed
 * grammar — never `eval`/`Function`, so an imported guide package cannot run
 * arbitrary code, only the arithmetic this file explicitly implements.
 */

export type Value = number | string | boolean;

type BinaryOp = "+" | "-" | "*" | "/" | "^" | "=" | "!=" | "<" | ">" | "<=" | ">=" | "AND" | "OR";

type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; name: string }
  | { kind: "unary"; op: "-" | "+"; operand: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "call"; name: string; args: Expr[] };

export type Statement = { varName: string; expr: Expr };
export type ParsedFormula = { statements: Statement[] };

export class FormulaError extends Error {}

const ALLOWED_FUNCTIONS = new Set([
  "COALESCE",
  "IF",
  "PI",
  "MIN",
  "MAX",
  "ABS",
  "ROUND",
  "CEILING",
  "FLOOR",
]);

// ---------- Lexer ----------

type Token =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "ident"; value: string }
  | { type: "op"; value: string }
  | { type: "eof" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdentChar = (c: string) => /[A-Za-z0-9_]/.test(c);

  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && isDigit(src[j])) j++;
      if (src[j] === ".") {
        j++;
        while (j < src.length && isDigit(src[j])) j++;
      }
      if (src[j] === "e" || src[j] === "E") {
        let k = j + 1;
        if (src[k] === "+" || src[k] === "-") k++;
        if (isDigit(src[k] ?? "")) {
          j = k;
          while (j < src.length && isDigit(src[j])) j++;
        }
      }
      const text = src.slice(i, j);
      tokens.push({ type: "num", value: Number(text) });
      i = j;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== "'") {
        value += src[j];
        j++;
      }
      if (src[j] !== "'") throw new FormulaError(`Unterminated string literal at position ${i}`);
      tokens.push({ type: "str", value });
      i = j + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < src.length && isIdentChar(src[j])) j++;
      tokens.push({ type: "ident", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "<" || c === ">" || c === "!" || c === "=") {
      if (src[i + 1] === "=") {
        tokens.push({ type: "op", value: c + "=" });
        i += 2;
        continue;
      }
      if (c === "!") throw new FormulaError(`Unexpected '!' at position ${i}`);
      tokens.push({ type: "op", value: c });
      i += 1;
      continue;
    }
    if ("+-*/^(),;".includes(c)) {
      tokens.push({ type: "op", value: c });
      i += 1;
      continue;
    }
    throw new FormulaError(`Unexpected character '${c}' at position ${i}`);
  }
  tokens.push({ type: "eof" });
  return tokens;
}

// ---------- Parser (recursive descent, precedence climbing) ----------

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expectOp(value: string): void {
    const t = this.next();
    if (t.type !== "op" || t.value !== value) {
      throw new FormulaError(`Expected '${value}' but got ${JSON.stringify(t)}`);
    }
  }

  parseFormula(): ParsedFormula {
    const statements: Statement[] = [];
    statements.push(this.parseStatement());
    while (this.peek().type === "op" && (this.peek() as { value: string }).value === ";") {
      this.next();
      if (this.peek().type === "eof") break;
      statements.push(this.parseStatement());
    }
    if (this.peek().type !== "eof") {
      throw new FormulaError(`Unexpected trailing content: ${JSON.stringify(this.peek())}`);
    }
    return { statements };
  }

  private parseStatement(): Statement {
    const identTok = this.next();
    if (identTok.type !== "ident") {
      throw new FormulaError(`Expected variable name, got ${JSON.stringify(identTok)}`);
    }
    this.expectOp("=");
    const expr = this.parseExpr();
    return { varName: identTok.value, expr };
  }

  // Precedence, low to high: OR, AND, comparisons, + -, * /, ^ (right-assoc), unary, primary
  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.isIdentKeyword("OR")) {
      this.next();
      left = { kind: "binary", op: "OR", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseComparison();
    while (this.isIdentKeyword("AND")) {
      this.next();
      left = { kind: "binary", op: "AND", left, right: this.parseComparison() };
    }
    return left;
  }

  private isIdentKeyword(kw: string): boolean {
    const t = this.peek();
    return t.type === "ident" && t.value.toUpperCase() === kw;
  }

  private parseComparison(): Expr {
    let left = this.parseAdditive();
    const comparisonOps = ["=", "!=", "<", ">", "<=", ">="];
    while (this.peek().type === "op" && comparisonOps.includes((this.peek() as { value: string }).value)) {
      const op = (this.next() as { value: string }).value as BinaryOp;
      left = { kind: "binary", op, left, right: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.peek().type === "op" && ["+", "-"].includes((this.peek() as { value: string }).value)) {
      const op = (this.next() as { value: string }).value as "+" | "-";
      left = { kind: "binary", op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parsePower();
    while (this.peek().type === "op" && ["*", "/"].includes((this.peek() as { value: string }).value)) {
      const op = (this.next() as { value: string }).value as "*" | "/";
      left = { kind: "binary", op, left, right: this.parsePower() };
    }
    return left;
  }

  private parsePower(): Expr {
    const left = this.parseUnary();
    if (this.peek().type === "op" && (this.peek() as { value: string }).value === "^") {
      this.next();
      const right = this.parsePower(); // right-associative
      return { kind: "binary", op: "^", left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.peek().type === "op" && ["-", "+"].includes((this.peek() as { value: string }).value)) {
      const op = (this.next() as { value: string }).value as "-" | "+";
      return { kind: "unary", op, operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const t = this.next();
    if (t.type === "num") return { kind: "num", value: t.value };
    if (t.type === "str") return { kind: "str", value: t.value };
    if (t.type === "op" && t.value === "(") {
      const inner = this.parseExpr();
      this.expectOp(")");
      return inner;
    }
    if (t.type === "ident") {
      if (this.peek().type === "op" && (this.peek() as { value: string }).value === "(") {
        this.next();
        const args: Expr[] = [];
        if (!(this.peek().type === "op" && (this.peek() as { value: string }).value === ")")) {
          args.push(this.parseExpr());
          while (this.peek().type === "op" && (this.peek() as { value: string }).value === ",") {
            this.next();
            args.push(this.parseExpr());
          }
        }
        this.expectOp(")");
        return { kind: "call", name: t.value.toUpperCase(), args };
      }
      return { kind: "ident", name: t.value };
    }
    throw new FormulaError(`Unexpected token ${JSON.stringify(t)}`);
  }
}

export function parseFormula(source: string): ParsedFormula {
  return new Parser(tokenize(source)).parseFormula();
}

// ---------- Static validation (import-time, no concrete inputs) ----------

/**
 * Verifies a formula parses, only calls allow-listed functions, and only
 * references identifiers that are either declared required inputs or an
 * earlier statement's own assignment (no forward/undefined references).
 * Used at import time (VAL-028 GUIDE_FORMULA_INVALID) before any costing
 * ever runs the formula for real.
 */
export function validateFormula(
  source: string,
  declaredInputs: string[],
): { valid: true } | { valid: false; error: string } {
  let parsed: ParsedFormula;
  try {
    parsed = parseFormula(source);
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }

  const known = new Set(declaredInputs);
  for (const stmt of parsed.statements) {
    try {
      checkExprReferences(stmt.expr, known);
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
    known.add(stmt.varName);
  }
  return { valid: true };
}

function checkExprReferences(expr: Expr, known: Set<string>): void {
  switch (expr.kind) {
    case "num":
    case "str":
      return;
    case "ident":
      if (!known.has(expr.name)) {
        throw new FormulaError(`Unknown identifier '${expr.name}' (not a declared input or prior assignment)`);
      }
      return;
    case "unary":
      checkExprReferences(expr.operand, known);
      return;
    case "binary":
      checkExprReferences(expr.left, known);
      checkExprReferences(expr.right, known);
      return;
    case "call":
      if (!ALLOWED_FUNCTIONS.has(expr.name)) {
        throw new FormulaError(`Function '${expr.name}' is not in the allow-list`);
      }
      for (const arg of expr.args) checkExprReferences(arg, known);
      return;
  }
}

// ---------- Evaluation ----------

/**
 * Runs every statement in order against `scope`, returning a new scope with
 * every intermediate and final variable populated — callers keep whichever
 * named results they need (raw_weight, costing_weight, ...) plus the full
 * set is retained as calculation evidence (AUD-004).
 */
export function evaluateFormula(source: string, scope: Record<string, Value>): Record<string, Value> {
  const parsed = parseFormula(source);
  const env: Record<string, Value> = { ...scope };
  for (const stmt of parsed.statements) {
    env[stmt.varName] = evalExpr(stmt.expr, env);
  }
  return env;
}

function evalExpr(expr: Expr, env: Record<string, Value>): Value {
  switch (expr.kind) {
    case "num":
      return expr.value;
    case "str":
      return expr.value;
    case "ident": {
      const v = env[expr.name];
      if (v === undefined) {
        throw new FormulaError(`Unknown identifier '${expr.name}' at evaluation time`);
      }
      return v;
    }
    case "unary": {
      const v = asNumber(evalExpr(expr.operand, env), expr.op);
      return expr.op === "-" ? -v : v;
    }
    case "binary":
      return evalBinary(expr.op, evalExpr(expr.left, env), evalExpr(expr.right, env));
    case "call":
      return evalCall(expr.name, expr.args, env);
  }
}

function asNumber(v: Value, context: string): number {
  if (typeof v !== "number") {
    throw new FormulaError(`Expected a number for '${context}', got ${typeof v}`);
  }
  return v;
}

function evalBinary(op: BinaryOp, left: Value, right: Value): Value {
  switch (op) {
    case "+":
      return asNumber(left, "+") + asNumber(right, "+");
    case "-":
      return asNumber(left, "-") - asNumber(right, "-");
    case "*":
      return asNumber(left, "*") * asNumber(right, "*");
    case "/": {
      const denom = asNumber(right, "/");
      if (denom === 0) throw new FormulaError("Division by zero");
      return asNumber(left, "/") / denom;
    }
    case "^":
      return Math.pow(asNumber(left, "^"), asNumber(right, "^"));
    case "=":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
      return asNumber(left, "<") < asNumber(right, "<");
    case ">":
      return asNumber(left, ">") > asNumber(right, ">");
    case "<=":
      return asNumber(left, "<=") <= asNumber(right, "<=");
    case ">=":
      return asNumber(left, ">=") >= asNumber(right, ">=");
    case "AND":
      return Boolean(left) && Boolean(right);
    case "OR":
      return Boolean(left) || Boolean(right);
  }
}

function evalCall(name: string, args: Expr[], env: Record<string, Value>): Value {
  switch (name) {
    case "PI":
      return Math.PI;
    case "COALESCE": {
      for (const arg of args) {
        const v = evalExpr(arg, env);
        if (v !== null && v !== undefined && !(typeof v === "number" && Number.isNaN(v))) return v;
      }
      throw new FormulaError("COALESCE: all arguments were null/undefined");
    }
    case "IF": {
      if (args.length !== 3) throw new FormulaError("IF requires exactly 3 arguments");
      const cond = evalExpr(args[0], env);
      return Boolean(cond) ? evalExpr(args[1], env) : evalExpr(args[2], env);
    }
    case "MIN":
      return Math.min(...args.map((a) => asNumber(evalExpr(a, env), "MIN")));
    case "MAX":
      return Math.max(...args.map((a) => asNumber(evalExpr(a, env), "MAX")));
    case "ABS":
      return Math.abs(asNumber(evalExpr(args[0], env), "ABS"));
    case "ROUND":
      return Math.round(asNumber(evalExpr(args[0], env), "ROUND"));
    case "CEILING": {
      const value = asNumber(evalExpr(args[0], env), "CEILING");
      const increment = args[1] ? asNumber(evalExpr(args[1], env), "CEILING") : 1;
      if (increment <= 0) throw new FormulaError("CEILING increment must be positive");
      return Math.ceil(value / increment) * increment;
    }
    case "FLOOR": {
      const value = asNumber(evalExpr(args[0], env), "FLOOR");
      const increment = args[1] ? asNumber(evalExpr(args[1], env), "FLOOR") : 1;
      if (increment <= 0) throw new FormulaError("FLOOR increment must be positive");
      return Math.floor(value / increment) * increment;
    }
    default:
      throw new FormulaError(`Function '${name}' is not in the allow-list`);
  }
}
