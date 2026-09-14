/**
 * The value model.
 *
 * A cell holds a scalar. A range evaluates to a matrix. Errors are values too,
 * not exceptions, because that is how spreadsheets behave: an error in one cell
 * propagates through every formula that reads it, and the rest of the sheet
 * keeps working.
 */

export type ErrorCode =
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#NUM!'
  | '#N/A'
  | '#CYCLE!';

/** A spreadsheet error. Carries a human-readable reason for tooling and tests. */
export class FormulaError {
  readonly code: ErrorCode;
  readonly reason: string;

  constructor(code: ErrorCode, reason = '') {
    this.code = code;
    this.reason = reason;
  }

  toString(): string {
    return this.code;
  }

  static div0(reason = 'division by zero'): FormulaError {
    return new FormulaError('#DIV/0!', reason);
  }
  static value(reason = 'wrong type of argument'): FormulaError {
    return new FormulaError('#VALUE!', reason);
  }
  static ref(reason = 'reference is not valid'): FormulaError {
    return new FormulaError('#REF!', reason);
  }
  static name(reason = 'unknown function or name'): FormulaError {
    return new FormulaError('#NAME?', reason);
  }
  static num(reason = 'number is out of range'): FormulaError {
    return new FormulaError('#NUM!', reason);
  }
  static na(reason = 'value is not available'): FormulaError {
    return new FormulaError('#N/A', reason);
  }
  static cycle(reason = 'formula refers to itself'): FormulaError {
    return new FormulaError('#CYCLE!', reason);
  }
}

/** What a single cell can hold. `null` is an empty cell. */
export type Scalar = number | string | boolean | null;

/** What a cell resolves to once evaluated. */
export type CellValue = Scalar | FormulaError;

/** A rectangular block of cells, produced by a range like `A1:B3`. */
export type Matrix = CellValue[][];

/** Anything an expression can evaluate to. */
export type Value = CellValue | Matrix;

export function isError(v: unknown): v is FormulaError {
  return v instanceof FormulaError;
}

export function isMatrix(v: Value): v is Matrix {
  return Array.isArray(v);
}

/** Flatten a value into scalars, the way SUM and friends see their arguments. */
export function flatten(v: Value): CellValue[] {
  if (!isMatrix(v)) return [v];
  const out: CellValue[] = [];
  for (const row of v) for (const cell of row) out.push(cell);
  return out;
}

/**
 * Coerce to a number the way a spreadsheet does.
 *
 * Booleans count (TRUE is 1), blanks count as 0, numeric strings parse, and
 * anything else is a #VALUE! error. Errors pass straight through so they
 * propagate rather than being swallowed.
 */
export function toNumber(v: CellValue): number | FormulaError {
  if (isError(v)) return v;
  if (v === null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const trimmed = v.trim();
  if (trimmed === '') return 0;
  const n = Number(trimmed);
  if (Number.isNaN(n)) return FormulaError.value(`"${v}" is not a number`);
  return n;
}

export function toText(v: CellValue): string | FormulaError {
  if (isError(v)) return v;
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return formatNumber(v);
}

export function toBoolean(v: CellValue): boolean | FormulaError {
  if (isError(v)) return v;
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const upper = v.trim().toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;
  return FormulaError.value(`"${v}" is not a boolean`);
}

/**
 * Render a number without floating-point noise.
 *
 * `0.1 + 0.2` must display as `0.3`, so round to 15 significant digits, which
 * is the precision an IEEE-754 double actually carries.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  return String(Number(n.toPrecision(15)));
}

/** Display form of any cell value, for a UI or a snapshot test. */
export function display(v: CellValue): string {
  if (isError(v)) return v.code;
  if (v === null) return '';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return v;
}
