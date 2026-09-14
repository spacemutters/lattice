/**
 * The built-in function library.
 *
 * Every function takes already-evaluated arguments. Errors propagate: if any
 * argument is an error, most functions return it untouched rather than trying
 * to compute with it. The exceptions are the ones whose whole job is to handle
 * errors (IFERROR, ISERROR, COUNT), so they inspect arguments directly.
 */

import {
  FormulaError,
  flatten,
  isError,
  isMatrix,
  toBoolean,
  toNumber,
  toText,
  type CellValue,
  type Value,
} from './values.js';

export interface FunctionSpec {
  readonly name: string;
  readonly minArgs: number;
  /** `Infinity` for variadic functions. */
  readonly maxArgs: number;
  /** Skip the automatic error-propagation pass; the function handles errors itself. */
  readonly rawErrors?: boolean;
  readonly call: (args: Value[]) => Value;
  readonly summary: string;
}

/** Collect the numeric arguments, ignoring blanks and text the way SUM does. */
function numbersOf(args: Value[]): number[] | FormulaError {
  const out: number[] = [];
  for (const arg of args) {
    for (const cell of flatten(arg)) {
      if (isError(cell)) return cell;
      if (cell === null) continue;
      // Text inside a range is ignored; text passed directly must coerce.
      if (typeof cell === 'string') {
        if (cell.trim() === '') continue;
        const n = Number(cell);
        if (Number.isNaN(n)) continue;
        out.push(n);
        continue;
      }
      const n = toNumber(cell);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

function singleNumber(v: Value): number | FormulaError {
  if (isMatrix(v)) {
    const cells = flatten(v);
    if (cells.length !== 1) return FormulaError.value('expected a single value');
    return toNumber(cells[0]!);
  }
  return toNumber(v);
}

function singleText(v: Value): string | FormulaError {
  if (isMatrix(v)) {
    const cells = flatten(v);
    if (cells.length !== 1) return FormulaError.value('expected a single value');
    return toText(cells[0]!);
  }
  return toText(v);
}

function unary(name: string, summary: string, fn: (n: number) => number | FormulaError): FunctionSpec {
  return {
    name,
    minArgs: 1,
    maxArgs: 1,
    summary,
    call: (args) => {
      const n = singleNumber(args[0]!);
      if (isError(n)) return n;
      return fn(n);
    },
  };
}

function aggregate(
  name: string,
  summary: string,
  fn: (nums: number[]) => number | FormulaError,
): FunctionSpec {
  return {
    name,
    minArgs: 1,
    maxArgs: Infinity,
    summary,
    call: (args) => {
      const nums = numbersOf(args);
      if (isError(nums)) return nums;
      return fn(nums);
    },
  };
}

/** Compare two scalars the way `=` and `<` do inside IF and MATCH. */
function compare(a: CellValue, b: CellValue): number {
  const an = a === null ? 0 : a;
  const bn = b === null ? 0 : b;
  if (typeof an === 'number' && typeof bn === 'number') return an < bn ? -1 : an > bn ? 1 : 0;
  const as = String(typeof an === 'boolean' ? (an ? 'TRUE' : 'FALSE') : an).toUpperCase();
  const bs = String(typeof bn === 'boolean' ? (bn ? 'TRUE' : 'FALSE') : bn).toUpperCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Does a value satisfy a criterion like `">5"`, `"apple"`, or `42`?
 * Used by COUNTIF, SUMIF and AVERAGEIF.
 */
function matches(value: CellValue, criterion: CellValue): boolean {
  if (isError(value)) return false;
  if (typeof criterion === 'string') {
    const m = /^(<=|>=|<>|<|>|=)(.*)$/.exec(criterion.trim());
    if (m) {
      const op = m[1]!;
      const rest = m[2]!.trim();
      const target: CellValue = rest === '' ? null : Number.isNaN(Number(rest)) ? rest : Number(rest);
      const c = compare(value, target);
      switch (op) {
        case '<': return c < 0;
        case '>': return c > 0;
        case '<=': return c <= 0;
        case '>=': return c >= 0;
        case '<>': return c !== 0;
        default: return c === 0;
      }
    }
  }
  return compare(value, criterion) === 0;
}

const SPECS: FunctionSpec[] = [
  // ---- maths ----
  aggregate('SUM', 'Adds every number given.', (n) => n.reduce((a, b) => a + b, 0)),
  aggregate('PRODUCT', 'Multiplies every number given.', (n) =>
    n.length === 0 ? 0 : n.reduce((a, b) => a * b, 1),
  ),
  aggregate('AVERAGE', 'The mean of the numbers given.', (n) =>
    n.length === 0 ? FormulaError.div0('AVERAGE of nothing') : n.reduce((a, b) => a + b, 0) / n.length,
  ),
  aggregate('MIN', 'The smallest number given.', (n) => (n.length === 0 ? 0 : Math.min(...n))),
  aggregate('MAX', 'The largest number given.', (n) => (n.length === 0 ? 0 : Math.max(...n))),
  aggregate('MEDIAN', 'The middle value.', (n) => {
    if (n.length === 0) return FormulaError.num('MEDIAN of nothing');
    const s = [...n].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  }),
  aggregate('STDEV', 'Sample standard deviation.', (n) => {
    if (n.length < 2) return FormulaError.div0('STDEV needs at least two numbers');
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    const variance = n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1);
    return Math.sqrt(variance);
  }),
  aggregate('VAR', 'Sample variance.', (n) => {
    if (n.length < 2) return FormulaError.div0('VAR needs at least two numbers');
    const mean = n.reduce((a, b) => a + b, 0) / n.length;
    return n.reduce((a, b) => a + (b - mean) ** 2, 0) / (n.length - 1);
  }),

  unary('ABS', 'Distance from zero.', Math.abs),
  unary('SQRT', 'Square root.', (n) => (n < 0 ? FormulaError.num('SQRT of a negative number') : Math.sqrt(n))),
  unary('INT', 'Rounds down to a whole number.', Math.floor),
  unary('SIGN', 'Returns -1, 0 or 1.', Math.sign),
  unary('EXP', 'e raised to a power.', Math.exp),
  unary('LN', 'Natural logarithm.', (n) => (n <= 0 ? FormulaError.num('LN needs a positive number') : Math.log(n))),
  unary('LOG10', 'Base-10 logarithm.', (n) => (n <= 0 ? FormulaError.num('LOG10 needs a positive number') : Math.log10(n))),
  unary('SIN', 'Sine, in radians.', Math.sin),
  unary('COS', 'Cosine, in radians.', Math.cos),
  unary('TAN', 'Tangent, in radians.', Math.tan),

  {
    name: 'ROUND',
    minArgs: 1,
    maxArgs: 2,
    summary: 'Rounds to a number of decimal places.',
    call: (args) => {
      const n = singleNumber(args[0]!);
      if (isError(n)) return n;
      const dRaw = args.length > 1 ? singleNumber(args[1]!) : 0;
      if (isError(dRaw)) return dRaw;
      const f = 10 ** Math.trunc(dRaw);
      // Nudge by an ulp so 1.005 rounds to 1.01 rather than 1.00.
      return Math.round((n * f) * (1 + Number.EPSILON)) / f;
    },
  },
  {
    name: 'ROUNDUP',
    minArgs: 1,
    maxArgs: 2,
    summary: 'Rounds away from zero.',
    call: (args) => {
      const n = singleNumber(args[0]!);
      if (isError(n)) return n;
      const d = args.length > 1 ? singleNumber(args[1]!) : 0;
      if (isError(d)) return d;
      const f = 10 ** Math.trunc(d);
      return (n < 0 ? -1 : 1) * Math.ceil(Math.abs(n) * f) / f;
    },
  },
  {
    name: 'ROUNDDOWN',
    minArgs: 1,
    maxArgs: 2,
    summary: 'Rounds towards zero.',
    call: (args) => {
      const n = singleNumber(args[0]!);
      if (isError(n)) return n;
      const d = args.length > 1 ? singleNumber(args[1]!) : 0;
      if (isError(d)) return d;
      const f = 10 ** Math.trunc(d);
      return (n < 0 ? -1 : 1) * Math.floor(Math.abs(n) * f) / f;
    },
  },
  {
    name: 'MOD',
    minArgs: 2,
    maxArgs: 2,
    summary: 'Remainder after division.',
    call: (args) => {
      const a = singleNumber(args[0]!);
      if (isError(a)) return a;
      const b = singleNumber(args[1]!);
      if (isError(b)) return b;
      if (b === 0) return FormulaError.div0('MOD by zero');
      // Excel's MOD takes the sign of the divisor, unlike JavaScript's %.
      return a - b * Math.floor(a / b);
    },
  },
  {
    name: 'POWER',
    minArgs: 2,
    maxArgs: 2,
    summary: 'Raises a number to a power.',
    call: (args) => {
      const a = singleNumber(args[0]!);
      if (isError(a)) return a;
      const b = singleNumber(args[1]!);
      if (isError(b)) return b;
      const r = a ** b;
      return Number.isFinite(r) ? r : FormulaError.num('result is out of range');
    },
  },
  { name: 'PI', minArgs: 0, maxArgs: 0, summary: 'The constant pi.', call: () => Math.PI },

  // ---- counting ----
  {
    name: 'COUNT',
    minArgs: 1,
    maxArgs: Infinity,
    rawErrors: true,
    summary: 'Counts the numeric values.',
    call: (args) => {
      let n = 0;
      for (const arg of args) {
        for (const cell of flatten(arg)) {
          if (typeof cell === 'number') n++;
        }
      }
      return n;
    },
  },
  {
    name: 'COUNTA',
    minArgs: 1,
    maxArgs: Infinity,
    rawErrors: true,
    summary: 'Counts the values that are not empty.',
    call: (args) => {
      let n = 0;
      for (const arg of args) {
        for (const cell of flatten(arg)) {
          if (cell !== null && cell !== '') n++;
        }
      }
      return n;
    },
  },
  {
    name: 'COUNTBLANK',
    minArgs: 1,
    maxArgs: Infinity,
    rawErrors: true,
    summary: 'Counts the empty cells.',
    call: (args) => {
      let n = 0;
      for (const arg of args) {
        for (const cell of flatten(arg)) {
          if (cell === null || cell === '') n++;
        }
      }
      return n;
    },
  },
  {
    name: 'COUNTIF',
    minArgs: 2,
    maxArgs: 2,
    rawErrors: true,
    summary: 'Counts the cells that meet a condition.',
    call: (args) => {
      const criterion = flatten(args[1]!)[0] ?? null;
      let n = 0;
      for (const cell of flatten(args[0]!)) {
        if (matches(cell, criterion)) n++;
      }
      return n;
    },
  },
  {
    name: 'SUMIF',
    minArgs: 2,
    maxArgs: 3,
    rawErrors: true,
    summary: 'Adds the cells that meet a condition.',
    call: (args) => {
      const test = flatten(args[0]!);
      const criterion = flatten(args[1]!)[0] ?? null;
      const target = args.length > 2 ? flatten(args[2]!) : test;
      let total = 0;
      for (let i = 0; i < test.length; i++) {
        if (!matches(test[i]!, criterion)) continue;
        const v = target[i];
        if (typeof v === 'number') total += v;
      }
      return total;
    },
  },
  {
    name: 'AVERAGEIF',
    minArgs: 2,
    maxArgs: 3,
    rawErrors: true,
    summary: 'Averages the cells that meet a condition.',
    call: (args) => {
      const test = flatten(args[0]!);
      const criterion = flatten(args[1]!)[0] ?? null;
      const target = args.length > 2 ? flatten(args[2]!) : test;
      let total = 0;
      let n = 0;
      for (let i = 0; i < test.length; i++) {
        if (!matches(test[i]!, criterion)) continue;
        const v = target[i];
        if (typeof v === 'number') {
          total += v;
          n++;
        }
      }
      return n === 0 ? FormulaError.div0('AVERAGEIF matched nothing') : total / n;
    },
  },

  // ---- logic ----
  {
    name: 'IF',
    minArgs: 2,
    maxArgs: 3,
    rawErrors: true,
    summary: 'Chooses between two values based on a test.',
    call: (args) => {
      const testRaw = args[0]!;
      const test = isMatrix(testRaw) ? (flatten(testRaw)[0] ?? null) : testRaw;
      if (isError(test)) return test;
      const cond = toBoolean(test);
      if (isError(cond)) return cond;
      if (cond) return args[1]!;
      return args.length > 2 ? args[2]! : false;
    },
  },
  {
    name: 'IFERROR',
    minArgs: 2,
    maxArgs: 2,
    rawErrors: true,
    summary: 'Falls back to a second value when the first is an error.',
    call: (args) => {
      const v = args[0]!;
      const scalar = isMatrix(v) ? (flatten(v)[0] ?? null) : v;
      return isError(scalar) ? args[1]! : v;
    },
  },
  {
    name: 'AND',
    minArgs: 1,
    maxArgs: Infinity,
    summary: 'TRUE when every argument is true.',
    call: (args) => {
      for (const cell of args.flatMap(flatten)) {
        if (cell === null) continue;
        const b = toBoolean(cell);
        if (isError(b)) return b;
        if (!b) return false;
      }
      return true;
    },
  },
  {
    name: 'OR',
    minArgs: 1,
    maxArgs: Infinity,
    summary: 'TRUE when any argument is true.',
    call: (args) => {
      for (const cell of args.flatMap(flatten)) {
        if (cell === null) continue;
        const b = toBoolean(cell);
        if (isError(b)) return b;
        if (b) return true;
      }
      return false;
    },
  },
  {
    name: 'NOT',
    minArgs: 1,
    maxArgs: 1,
    summary: 'Flips TRUE and FALSE.',
    call: (args) => {
      const b = toBoolean(isMatrix(args[0]!) ? (flatten(args[0]!)[0] ?? null) : (args[0] as CellValue));
      if (isError(b)) return b;
      return !b;
    },
  },
  {
    name: 'ISERROR',
    minArgs: 1,
    maxArgs: 1,
    rawErrors: true,
    summary: 'TRUE when the value is an error.',
    call: (args) => {
      const v = args[0]!;
      return isError(isMatrix(v) ? (flatten(v)[0] ?? null) : v);
    },
  },
  {
    name: 'ISBLANK',
    minArgs: 1,
    maxArgs: 1,
    rawErrors: true,
    summary: 'TRUE when the cell is empty.',
    call: (args) => {
      const v = args[0]!;
      const s = isMatrix(v) ? (flatten(v)[0] ?? null) : v;
      return s === null;
    },
  },
  {
    name: 'ISNUMBER',
    minArgs: 1,
    maxArgs: 1,
    rawErrors: true,
    summary: 'TRUE when the value is a number.',
    call: (args) => {
      const v = args[0]!;
      return typeof (isMatrix(v) ? (flatten(v)[0] ?? null) : v) === 'number';
    },
  },
  { name: 'TRUE', minArgs: 0, maxArgs: 0, summary: 'The value TRUE.', call: () => true },
  { name: 'FALSE', minArgs: 0, maxArgs: 0, summary: 'The value FALSE.', call: () => false },

  // ---- text ----
  {
    name: 'CONCAT',
    minArgs: 1,
    maxArgs: Infinity,
    summary: 'Joins text together.',
    call: (args) => {
      let out = '';
      for (const cell of args.flatMap(flatten)) {
        const t = toText(cell);
        if (isError(t)) return t;
        out += t;
      }
      return out;
    },
  },
  {
    name: 'LEN',
    minArgs: 1,
    maxArgs: 1,
    summary: 'How many characters the text has.',
    call: (args) => {
      const t = singleText(args[0]!);
      return isError(t) ? t : t.length;
    },
  },
  {
    name: 'UPPER',
    minArgs: 1,
    maxArgs: 1,
    summary: 'Converts text to capitals.',
    call: (args) => {
      const t = singleText(args[0]!);
      return isError(t) ? t : t.toUpperCase();
    },
  },
  {
    name: 'LOWER',
    minArgs: 1,
    maxArgs: 1,
    summary: 'Converts text to lower case.',
    call: (args) => {
      const t = singleText(args[0]!);
      return isError(t) ? t : t.toLowerCase();
    },
  },
  {
    name: 'TRIM',
    minArgs: 1,
    maxArgs: 1,
    summary: 'Removes spaces from both ends.',
    call: (args) => {
      const t = singleText(args[0]!);
      return isError(t) ? t : t.trim().replace(/\s+/g, ' ');
    },
  },
  {
    name: 'LEFT',
    minArgs: 1,
    maxArgs: 2,
    summary: 'The first characters of some text.',
    call: (args) => {
      const t = singleText(args[0]!);
      if (isError(t)) return t;
      const n = args.length > 1 ? singleNumber(args[1]!) : 1;
      if (isError(n)) return n;
      if (n < 0) return FormulaError.value('LEFT needs a length of zero or more');
      return t.slice(0, Math.trunc(n));
    },
  },
  {
    name: 'RIGHT',
    minArgs: 1,
    maxArgs: 2,
    summary: 'The last characters of some text.',
    call: (args) => {
      const t = singleText(args[0]!);
      if (isError(t)) return t;
      const n = args.length > 1 ? singleNumber(args[1]!) : 1;
      if (isError(n)) return n;
      if (n < 0) return FormulaError.value('RIGHT needs a length of zero or more');
      const k = Math.trunc(n);
      return k === 0 ? '' : t.slice(-k);
    },
  },
  {
    name: 'MID',
    minArgs: 3,
    maxArgs: 3,
    summary: 'Characters taken from the middle of some text.',
    call: (args) => {
      const t = singleText(args[0]!);
      if (isError(t)) return t;
      const start = singleNumber(args[1]!);
      if (isError(start)) return start;
      const len = singleNumber(args[2]!);
      if (isError(len)) return len;
      if (start < 1) return FormulaError.value('MID starts counting at 1');
      if (len < 0) return FormulaError.value('MID needs a length of zero or more');
      const from = Math.trunc(start) - 1;
      return t.slice(from, from + Math.trunc(len));
    },
  },

  // ---- lookup ----
  {
    name: 'VLOOKUP',
    minArgs: 3,
    maxArgs: 4,
    rawErrors: true,
    summary: 'Finds a row by its first column and reads across.',
    call: (args) => {
      const needleRaw = args[0]!;
      const needle = isMatrix(needleRaw) ? (flatten(needleRaw)[0] ?? null) : needleRaw;
      if (isError(needle)) return needle;
      const table = args[1]!;
      if (!isMatrix(table)) return FormulaError.value('VLOOKUP needs a range to search');
      const colRaw = singleNumber(args[2]!);
      if (isError(colRaw)) return colRaw;
      const col = Math.trunc(colRaw) - 1;
      if (col < 0) return FormulaError.value('VLOOKUP column number starts at 1');
      for (const row of table) {
        if (row.length === 0) continue;
        if (compare(row[0] ?? null, needle) === 0) {
          if (col >= row.length) return FormulaError.ref('VLOOKUP column is past the end of the range');
          return row[col] ?? null;
        }
      }
      return FormulaError.na(`VLOOKUP found no match`);
    },
  },
  {
    name: 'INDEX',
    minArgs: 2,
    maxArgs: 3,
    rawErrors: true,
    summary: 'Reads a cell from a range by row and column number.',
    call: (args) => {
      const table = args[0]!;
      if (!isMatrix(table)) return FormulaError.value('INDEX needs a range');
      const rowRaw = singleNumber(args[1]!);
      if (isError(rowRaw)) return rowRaw;
      const colRaw = args.length > 2 ? singleNumber(args[2]!) : 1;
      if (isError(colRaw)) return colRaw;
      const r = Math.trunc(rowRaw) - 1;
      const c = Math.trunc(colRaw) - 1;
      if (r < 0 || c < 0) return FormulaError.value('INDEX counts from 1');
      const row = table[r];
      if (!row || c >= row.length) return FormulaError.ref('INDEX is outside the range');
      return row[c] ?? null;
    },
  },
  {
    name: 'MATCH',
    minArgs: 2,
    maxArgs: 3,
    rawErrors: true,
    summary: 'Finds where a value sits in a range.',
    call: (args) => {
      const needleRaw = args[0]!;
      const needle = isMatrix(needleRaw) ? (flatten(needleRaw)[0] ?? null) : needleRaw;
      if (isError(needle)) return needle;
      const cells = flatten(args[1]!);
      for (let i = 0; i < cells.length; i++) {
        if (compare(cells[i]!, needle) === 0) return i + 1;
      }
      return FormulaError.na('MATCH found no match');
    },
  },
];

const REGISTRY = new Map<string, FunctionSpec>(SPECS.map((s) => [s.name, s]));

export function lookupFunction(name: string): FunctionSpec | undefined {
  return REGISTRY.get(name.toUpperCase());
}

export function functionNames(): string[] {
  return [...REGISTRY.keys()].sort();
}

export function allFunctions(): FunctionSpec[] {
  return [...REGISTRY.values()].sort((a, b) => a.name.localeCompare(b.name));
}
