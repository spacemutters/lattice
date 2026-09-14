/**
 * Differential and fuzz testing.
 *
 * The engine's central claim is that recomputing only the affected cells gives
 * the same answer as recomputing everything. That is exactly the kind of claim
 * that holds for the cases you thought of and breaks on the ones you did not,
 * so it is checked here against randomly generated sheets rather than fixtures.
 *
 * The random source is a seeded PRNG, so a failure reproduces from its seed
 * instead of vanishing on the next run.
 */

import { describe, expect, it } from 'vitest';
import { Sheet } from '../src/sheet.js';
import { parse } from '../src/parser.js';
import { indexToColumn } from '../src/refs.js';
import { display } from '../src/values.js';

/** mulberry32: small, fast, and reproducible from a 32-bit seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

const BINARY = ['+', '-', '*', '/', '^', '&', '=', '<', '>', '<=', '>=', '<>'] as const;
const FUNCS = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'ABS', 'ROUND', 'IF', 'LEN', 'CONCAT'] as const;

const COLS = 6;
const ROWS = 12;

const addr = (col: number, row: number) => `${indexToColumn(col)}${row + 1}`;

/**
 * Build a formula that only ever refers to earlier rows, so a generated sheet
 * is acyclic by construction. Cycles get their own dedicated tests.
 */
function randomFormula(r: () => number, row: number): string {
  const ref = () => addr(int(r, 0, COLS - 1), int(r, 0, Math.max(0, row - 1)));

  const atom = (): string => {
    const roll = r();
    if (roll < 0.4) return ref();
    if (roll < 0.6) return String(int(r, -50, 50));
    if (roll < 0.7) return String(int(r, 1, 100) / 4);
    if (roll < 0.75) return '"text"';
    if (roll < 0.8) return pick(r, ['TRUE', 'FALSE']);
    if (roll < 0.9) {
      const from = int(r, 0, Math.max(0, row - 1));
      const to = Math.min(Math.max(0, row - 1), from + int(r, 0, 3));
      const col = int(r, 0, COLS - 1);
      return `${addr(col, from)}:${addr(col, to)}`;
    }
    return ref();
  };

  const expr = (depth: number): string => {
    if (depth <= 0) return atom();
    const roll = r();
    if (roll < 0.45) return `${expr(depth - 1)}${pick(r, BINARY)}${expr(depth - 1)}`;
    if (roll < 0.6) return `(${expr(depth - 1)})`;
    if (roll < 0.7) return `-${expr(depth - 1)}`;
    const fn = pick(r, FUNCS);
    const arity = fn === 'IF' ? 3 : fn === 'CONCAT' ? 2 : fn === 'ROUND' ? 2 : 1;
    const args = Array.from({ length: arity }, () => expr(depth - 1));
    return `${fn}(${args.join(',')})`;
  };

  return `=${expr(int(r, 1, 3))}`;
}

/** A whole sheet's worth of writes, acyclic by construction. */
function randomSheet(r: () => number): Array<[string, string]> {
  const writes: Array<[string, string]> = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const key = addr(col, row);
      if (row === 0 || r() < 0.3) {
        writes.push([key, String(int(r, -20, 20))]);
      } else {
        writes.push([key, randomFormula(r, row)]);
      }
    }
  }
  return writes;
}

function snapshotOf(sheet: Sheet): Record<string, string> {
  const out: Record<string, string> = {};
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const key = addr(col, row);
      out[key] = display(sheet.get(key));
    }
  }
  return out;
}

describe('incremental recalculation matches a full rebuild', () => {
  // Each seed is an independent randomly generated sheet plus a run of edits.
  for (const seed of [1, 7, 42, 99, 123, 2024, 31337, 8675309]) {
    it(`agrees with a from-scratch rebuild (seed ${seed})`, () => {
      const r = rng(seed);
      const writes = randomSheet(r);

      const live = new Sheet();
      live.setMany(writes);

      // A running copy of what has been written, so the rebuild sees the same
      // inputs the incremental sheet does.
      const state = new Map(writes);

      for (let edit = 0; edit < 25; edit++) {
        const col = int(r, 0, COLS - 1);
        const row = int(r, 0, ROWS - 1);
        const key = addr(col, row);
        const value =
          r() < 0.75 ? String(int(r, -20, 20)) : row === 0 ? '0' : randomFormula(r, row);

        live.set(key, value);
        state.set(key, value);

        // Rebuild from nothing and compare every cell.
        const fresh = new Sheet();
        fresh.setMany([...state.entries()]);

        expect(snapshotOf(live), `after edit ${edit + 1} to ${key} = ${value}`).toEqual(
          snapshotOf(fresh),
        );
      }
    });
  }
});

describe('the engine never throws', () => {
  it('survives 3000 randomly generated formulas', () => {
    const r = rng(20260914);
    const sheet = new Sheet();

    for (let i = 0; i < 3000; i++) {
      const row = int(r, 0, ROWS - 1);
      const key = addr(int(r, 0, COLS - 1), row);
      expect(() => sheet.set(key, randomFormula(r, row))).not.toThrow();
    }
  });

  it('survives random character soup', () => {
    const r = rng(5150);
    const alphabet = '=+-*/^&<>(),:"$%ABC123 \t';
    const sheet = new Sheet();

    for (let i = 0; i < 3000; i++) {
      const len = int(r, 1, 24);
      let s = '=';
      for (let c = 0; c < len; c++) s += alphabet[Math.floor(r() * alphabet.length)];
      expect(() => sheet.set('A1', s), `input: ${JSON.stringify(s)}`).not.toThrow();
    }
  });

  it('either parses a formula or throws a ParseError, never anything else', () => {
    const r = rng(777);
    const alphabet = '=+-*/^&<>(),:"$%ABC123 ';

    for (let i = 0; i < 3000; i++) {
      const len = int(r, 1, 20);
      let s = '';
      for (let c = 0; c < len; c++) s += alphabet[Math.floor(r() * alphabet.length)];
      try {
        parse(`=${s}`);
      } catch (err) {
        expect(
          (err as Error).name,
          `unexpected error type for ${JSON.stringify(s)}`,
        ).toMatch(/^(ParseError|LexError)$/);
      }
    }
  });
});

describe('graph invariants hold under random edits', () => {
  it('keeps precedents and dependents mirrored', () => {
    const r = rng(4242);
    const sheet = new Sheet();
    sheet.setMany(randomSheet(r));

    for (let edit = 0; edit < 60; edit++) {
      const row = int(r, 0, ROWS - 1);
      const key = addr(int(r, 0, COLS - 1), row);
      sheet.set(key, r() < 0.5 ? String(int(r, -10, 10)) : randomFormula(r, row));
    }

    // Every edge must be visible from both ends.
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const cell = addr(col, row);
        for (const p of sheet.precedentsOf(cell)) {
          expect(sheet.dependentsOf(p), `${cell} reads ${p}, so ${p} must list it`).toContain(
            sheet.snapshot(cell).key,
          );
        }
      }
    }
  });

  it('drops every edge when a formula becomes a literal', () => {
    const r = rng(31);
    const sheet = new Sheet();
    sheet.setMany(randomSheet(r));

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        sheet.set(addr(col, row), '1');
      }
    }

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        expect(sheet.precedentsOf(addr(col, row))).toHaveLength(0);
      }
    }
  });
});
