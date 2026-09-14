/**
 * The sheet: the public surface of the engine.
 *
 * Holds raw input per cell, a parsed AST per formula, and a computed value per
 * cell. A write marks the changed cell and everything downstream as dirty and
 * recomputes only that set, in dependency order.
 */

import { walk, type Node } from './ast.js';
import { evaluateToCell, type EvalContext } from './evaluator.js';
import { DependencyGraph } from './graph.js';
import { ParseError, parse } from './parser.js';
import { LexError } from './lexer.js';
import {
  keyOf,
  keyOfRef,
  keyToA1,
  normalizeRange,
  parseKey,
  parseRef,
  rangeKeys,
  type RangeRef,
} from './refs.js';
import {
  FormulaError,
  display,
  type CellValue,
  type Matrix,
} from './values.js';

interface Cell {
  /** Exactly what was typed. */
  raw: string;
  /** Parsed tree, for formulas only. */
  ast?: Node;
  /** Why the formula would not parse, if it would not. */
  parseError?: string;
  /** Last computed value. */
  value: CellValue;
}

export interface RecalcStats {
  /** Cells whose value was recomputed in the last write. */
  evaluated: number;
  /** Cells that hold a formula anywhere in the sheet. */
  formulas: number;
  /** Microseconds spent in the last recalculation. */
  micros: number;
}

export interface CellSnapshot {
  readonly key: string;
  readonly a1: string;
  readonly raw: string;
  readonly value: CellValue;
  readonly display: string;
  readonly isFormula: boolean;
  readonly error: string | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export class Sheet {
  private readonly cells = new Map<string, Cell>();
  private readonly graph = new DependencyGraph();
  private lastStats: RecalcStats = { evaluated: 0, formulas: 0, micros: 0 };

  private readonly ctx: EvalContext = {
    getCell: (key) => this.cells.get(key)?.value ?? null,
    getRange: (range) => this.readRange(range),
  };

  // ---- reading ----

  /** Computed value of a cell, addressed as `A1` or by `col,row` key. */
  get(address: string): CellValue {
    return this.cells.get(this.toKey(address))?.value ?? null;
  }

  /** What the user typed. */
  getRaw(address: string): string {
    return this.cells.get(this.toKey(address))?.raw ?? '';
  }

  /** Display string, the way a UI would render it. */
  getDisplay(address: string): string {
    return display(this.get(address));
  }

  snapshot(address: string): CellSnapshot {
    const key = this.toKey(address);
    const cell = this.cells.get(key);
    const value = cell?.value ?? null;
    return {
      key,
      a1: keyToA1(key),
      raw: cell?.raw ?? '',
      value,
      display: display(value),
      isFormula: Boolean(cell?.raw.startsWith('=')),
      error: value instanceof FormulaError ? value.code : null,
    };
  }

  /** Every non-empty cell. */
  entries(): CellSnapshot[] {
    return [...this.cells.keys()].map((k) => this.snapshot(k));
  }

  get stats(): RecalcStats {
    return { ...this.lastStats, formulas: this.countFormulas() };
  }

  // ---- writing ----

  /**
   * Write a cell and recalculate everything it affects.
   * Returns the keys that were recomputed.
   */
  set(address: string, raw: string): string[] {
    const key = this.toKey(address);
    const text = raw ?? '';

    if (text === '') {
      this.cells.delete(key);
      this.graph.clearPrecedents(key);
      return this.recalculate([key]);
    }

    const cell: Cell = { raw: text, value: null };

    if (text.startsWith('=')) {
      try {
        const ast = parse(text);
        cell.ast = ast;
        this.graph.setPrecedents(key, collectDependencies(ast));
      } catch (err) {
        if (err instanceof ParseError || err instanceof LexError) {
          cell.parseError = err.message;
          cell.value = FormulaError.name(err.message);
          this.graph.clearPrecedents(key);
        } else {
          throw err;
        }
      }
    } else {
      this.graph.clearPrecedents(key);
      cell.value = coerceLiteral(text);
    }

    this.cells.set(key, cell);
    return this.recalculate([key]);
  }

  /** Write many cells, recalculating once at the end. */
  setMany(writes: Iterable<readonly [string, string]>): string[] {
    const seeds: string[] = [];

    for (const [address, raw] of writes) {
      const key = this.toKey(address);
      const text = raw ?? '';
      seeds.push(key);

      if (text === '') {
        this.cells.delete(key);
        this.graph.clearPrecedents(key);
        continue;
      }

      const cell: Cell = { raw: text, value: null };
      if (text.startsWith('=')) {
        try {
          const ast = parse(text);
          cell.ast = ast;
          this.graph.setPrecedents(key, collectDependencies(ast));
        } catch (err) {
          if (err instanceof ParseError || err instanceof LexError) {
            cell.parseError = err.message;
            cell.value = FormulaError.name(err.message);
            this.graph.clearPrecedents(key);
          } else {
            throw err;
          }
        }
      } else {
        this.graph.clearPrecedents(key);
        cell.value = coerceLiteral(text);
      }
      this.cells.set(key, cell);
    }

    return this.recalculate(seeds);
  }

  clear(): void {
    this.cells.clear();
    this.graph.clear();
    this.lastStats = { evaluated: 0, formulas: 0, micros: 0 };
  }

  // ---- graph introspection, for the dependency inspector ----

  precedentsOf(address: string): string[] {
    return [...this.graph.getPrecedents(this.toKey(address))];
  }

  dependentsOf(address: string): string[] {
    return [...this.graph.getDependents(this.toKey(address))];
  }

  /** Everything downstream of a cell, transitively. Excludes the cell itself. */
  affectedBy(address: string): string[] {
    const key = this.toKey(address);
    const set = this.graph.affectedBy([key]);
    set.delete(key);
    return [...set];
  }

  // ---- internals ----

  private recalculate(seeds: string[]): string[] {
    const started = performance.now();

    const affected = this.graph.affectedBy(seeds);
    const { order, cyclic } = this.graph.topologicalOrder(affected);

    for (const key of cyclic) {
      const cell = this.cells.get(key);
      if (cell?.ast) {
        cell.value = FormulaError.cycle(`${keyToA1(key)} is part of a reference cycle`);
      }
    }

    let evaluated = 0;
    for (const key of order) {
      const cell = this.cells.get(key);
      if (!cell?.ast) continue;
      if (cell.parseError !== undefined) continue;
      cell.value = evaluateToCell(cell.ast, this.ctx);
      evaluated++;
    }

    this.lastStats = {
      evaluated,
      formulas: this.countFormulas(),
      micros: Math.round((performance.now() - started) * 1000),
    };

    const touched = [...affected];
    for (const key of cyclic) if (!affected.has(key)) touched.push(key);
    return touched;
  }

  private readRange(range: RangeRef): Matrix {
    const { start, end } = normalizeRange(range);
    const out: Matrix = [];
    for (let row = start.row; row <= end.row; row++) {
      const line: CellValue[] = [];
      for (let col = start.col; col <= end.col; col++) {
        line.push(this.cells.get(keyOf(col, row))?.value ?? null);
      }
      out.push(line);
    }
    return out;
  }

  private countFormulas(): number {
    let n = 0;
    for (const cell of this.cells.values()) if (cell.ast) n++;
    return n;
  }

  /** Accept `A1`, `$B$2`, or an internal `col,row` key. */
  private toKey(address: string): string {
    if (address.includes(',')) {
      const { col, row } = parseKey(address);
      if (Number.isFinite(col) && Number.isFinite(row)) return keyOf(col, row);
    }
    const ref = parseRef(address);
    if (!ref) throw new RangeError(`"${address}" is not a cell reference`);
    return keyOfRef(ref);
  }
}

/** Every cell key a formula reads, ranges expanded. */
function collectDependencies(ast: Node): Set<string> {
  const deps = new Set<string>();
  walk(ast, (node) => {
    if (node.kind === 'ref') {
      deps.add(keyOfRef(node.ref));
    } else if (node.kind === 'range') {
      for (const key of rangeKeys(node.range)) deps.add(key);
    }
  });
  return deps;
}

/** Turn typed text into a number, boolean, or string. */
function coerceLiteral(text: string): CellValue {
  const trimmed = text.trim();
  if (trimmed === '') return text;

  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE') return true;
  if (upper === 'FALSE') return false;

  // Only treat it as a number when the whole string is one.
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (!Number.isNaN(n)) return n;
  }

  // Percentages typed directly, e.g. "15%".
  if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(trimmed)) {
    return Number(trimmed.slice(0, -1)) / 100;
  }

  return text;
}

export { EMPTY_SET };
