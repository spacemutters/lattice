/**
 * Tree-walking evaluator.
 *
 * The sheet supplies a resolver so the evaluator never needs to know how cells
 * are stored. Errors are returned, never thrown, so one bad cell cannot take
 * down a recalculation pass.
 */

import type { BinaryOperator, Node } from './ast.js';
import { lookupFunction } from './functions.js';
import { keyOfRef, normalizeRange, type RangeRef } from './refs.js';
import {
  FormulaError,
  flatten,
  isError,
  isMatrix,
  toNumber,
  toText,
  type CellValue,
  type Matrix,
  type Value,
} from './values.js';

export interface EvalContext {
  /** Current value of a single cell, by `col,row` key. */
  getCell(key: string): CellValue;
  /** Current values of a rectangular block, row-major. */
  getRange(range: RangeRef): Matrix;
}

/** Collapse a matrix to a scalar where a scalar is required. */
function scalarize(v: Value): CellValue {
  if (!isMatrix(v)) return v;
  const cells = flatten(v);
  if (cells.length === 1) return cells[0]!;
  return FormulaError.value('a range was used where one value is needed');
}

function compareValues(a: CellValue, b: CellValue): number | FormulaError {
  if (isError(a)) return a;
  if (isError(b)) return b;
  const an = a === null ? 0 : a;
  const bn = b === null ? 0 : b;
  if (typeof an === 'number' && typeof bn === 'number') {
    return an < bn ? -1 : an > bn ? 1 : 0;
  }
  if (typeof an === 'boolean' || typeof bn === 'boolean') {
    // Excel orders numbers below text below booleans.
    const rank = (x: CellValue) =>
      typeof x === 'number' ? 0 : typeof x === 'string' ? 1 : 2;
    const ra = rank(an);
    const rb = rank(bn);
    if (ra !== rb) return ra < rb ? -1 : 1;
    const ab = an === true ? 1 : 0;
    const bb = bn === true ? 1 : 0;
    return ab < bb ? -1 : ab > bb ? 1 : 0;
  }
  const as = String(an).toUpperCase();
  const bs = String(bn).toUpperCase();
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function arithmetic(op: BinaryOperator, a: CellValue, b: CellValue): CellValue {
  const x = toNumber(a);
  if (isError(x)) return x;
  const y = toNumber(b);
  if (isError(y)) return y;

  switch (op) {
    case '+':
      return x + y;
    case '-':
      return x - y;
    case '*':
      return x * y;
    case '/':
      return y === 0 ? FormulaError.div0() : x / y;
    case '^': {
      const r = x ** y;
      return Number.isFinite(r) ? r : FormulaError.num('result is out of range');
    }
    default:
      return FormulaError.value(`unknown operator "${op}"`);
  }
}

export function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.kind) {
    case 'number':
      return node.value;

    case 'string':
      return node.value;

    case 'boolean':
      return node.value;

    case 'ref':
      return ctx.getCell(keyOfRef(node.ref));

    case 'range':
      return ctx.getRange(normalizeRange(node.range));

    case 'unary': {
      const operand = scalarize(evaluate(node.operand, ctx));
      if (isError(operand)) return operand;
      const n = toNumber(operand);
      if (isError(n)) return n;
      return node.op === '-' ? -n : n;
    }

    case 'percent': {
      const operand = scalarize(evaluate(node.operand, ctx));
      if (isError(operand)) return operand;
      const n = toNumber(operand);
      if (isError(n)) return n;
      return n / 100;
    }

    case 'binary': {
      const left = scalarize(evaluate(node.left, ctx));
      if (isError(left)) return left;
      const right = scalarize(evaluate(node.right, ctx));
      if (isError(right)) return right;

      if (node.op === '&') {
        const a = toText(left);
        if (isError(a)) return a;
        const b = toText(right);
        if (isError(b)) return b;
        return a + b;
      }

      if (node.op === '=' || node.op === '<>' || node.op === '<' ||
          node.op === '>' || node.op === '<=' || node.op === '>=') {
        const c = compareValues(left, right);
        if (isError(c)) return c;
        switch (node.op) {
          case '=': return c === 0;
          case '<>': return c !== 0;
          case '<': return c < 0;
          case '>': return c > 0;
          case '<=': return c <= 0;
          default: return c >= 0;
        }
      }

      return arithmetic(node.op, left, right);
    }

    case 'call': {
      const spec = lookupFunction(node.name);
      if (!spec) return FormulaError.name(`${node.name} is not a function`);

      if (node.args.length < spec.minArgs || node.args.length > spec.maxArgs) {
        const expected =
          spec.maxArgs === Infinity
            ? `at least ${spec.minArgs}`
            : spec.minArgs === spec.maxArgs
              ? `${spec.minArgs}`
              : `${spec.minArgs} to ${spec.maxArgs}`;
        return FormulaError.value(
          `${spec.name} takes ${expected} argument${expected === '1' ? '' : 's'}, got ${node.args.length}`,
        );
      }

      const args = node.args.map((a) => evaluate(a, ctx));

      if (!spec.rawErrors) {
        for (const arg of args) {
          if (isError(arg)) return arg;
          if (isMatrix(arg)) {
            for (const cell of flatten(arg)) {
              if (isError(cell)) return cell;
            }
          }
        }
      }

      return spec.call(args);
    }
  }
}

/** Evaluate and collapse to something a cell can hold. */
export function evaluateToCell(node: Node, ctx: EvalContext): CellValue {
  return scalarize(evaluate(node, ctx));
}
