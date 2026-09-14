/**
 * Measures the thing the design is actually for: after one cell changes, does
 * the engine touch only what that change reaches?
 *
 * Run with `npm run bench`.
 */

import { Sheet } from '../src/sheet.js';
import { indexToColumn } from '../src/refs.js';

function ms(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

function fmt(n: number): string {
  return n.toFixed(2).padStart(9);
}

function buildGrid(cols: number, rows: number): Sheet {
  const s = new Sheet();
  const writes: Array<[string, string]> = [];

  // Column A is raw data; every other column is a formula on the column before.
  for (let r = 1; r <= rows; r++) {
    writes.push([`A${r}`, String(r)]);
    for (let c = 1; c < cols; c++) {
      const here = indexToColumn(c);
      const prev = indexToColumn(c - 1);
      writes.push([`${here}${r}`, `=${prev}${r}*2+1`]);
    }
  }

  s.setMany(writes);
  return s;
}

function section(title: string): void {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

console.log('lattice recalculation benchmark');

// ---- 1. Build cost ----
section('Building a grid of formulas');
for (const [cols, rows] of [[10, 100], [20, 500], [40, 1000]] as const) {
  const total = cols * rows;
  let sheet!: Sheet;
  const build = ms(() => {
    sheet = buildGrid(cols, rows);
  });
  console.log(
    `  ${String(total).padStart(6)} cells  build ${fmt(build)} ms  ` +
      `(${((build / total) * 1000).toFixed(2)} us/cell, ${sheet.stats.formulas} formulas)`,
  );
}

// ---- 2. Incremental vs. full ----
section('One edit in a 40,000-cell sheet');
{
  const sheet = buildGrid(40, 1000);
  const total = 40 * 1000;

  // Editing A1 touches only row 1: 40 cells out of 40,000.
  const narrow = ms(() => {
    sheet.set('A1', '999');
  });
  const narrowTouched = sheet.stats.evaluated;

  console.log(`  total cells                ${String(total).padStart(7)}`);
  console.log(`  edit A1 -> recomputed      ${String(narrowTouched).padStart(7)}  in ${fmt(narrow)} ms`);
  console.log(
    `  fraction of sheet touched  ${((narrowTouched / total) * 100).toFixed(3)}%`,
  );

  // A full rebuild is the honest comparison for "recompute everything".
  const full = ms(() => {
    buildGrid(40, 1000);
  });
  console.log(`  full rebuild               ${fmt(full)} ms`);
  console.log(`  speed-up                   ${(full / narrow).toFixed(0)}x`);
}

// ---- 3. Deep chains ----
section('A single chain, each cell reading the one before');
for (const depth of [100, 1000, 5000]) {
  const s = new Sheet();
  const writes: Array<[string, string]> = [['A1', '1']];
  for (let i = 2; i <= depth; i++) writes.push([`A${i}`, `=A${i - 1}+1`]);
  s.setMany(writes);

  const edit = ms(() => {
    s.set('A1', '0');
  });
  const tail = s.get(`A${depth}`);
  console.log(
    `  depth ${String(depth).padStart(5)}  edit head ${fmt(edit)} ms  ` +
      `tail = ${String(tail).padStart(6)}  (${s.stats.evaluated} recomputed)`,
  );
}

// ---- 4. Wide fan-out ----
section('One cell read by many');
for (const fanout of [100, 1000, 5000]) {
  const s = new Sheet();
  const writes: Array<[string, string]> = [['A1', '2']];
  for (let i = 1; i <= fanout; i++) writes.push([`B${i}`, `=A1*${i}`]);
  s.setMany(writes);

  const edit = ms(() => {
    s.set('A1', '3');
  });
  console.log(
    `  fan-out ${String(fanout).padStart(5)}  edit ${fmt(edit)} ms  ` +
      `(${s.stats.evaluated} recomputed, B${fanout} = ${String(s.get(`B${fanout}`))})`,
  );
}

// ---- 5. Range aggregation ----
section('SUM over a growing range');
for (const size of [100, 1000, 10000]) {
  const s = new Sheet();
  const writes: Array<[string, string]> = [];
  for (let i = 1; i <= size; i++) writes.push([`A${i}`, String(i)]);
  writes.push(['C1', `=SUM(A1:A${size})`]);
  s.setMany(writes);

  const edit = ms(() => {
    s.set('A1', '0');
  });
  const expected = (size * (size + 1)) / 2 - 1;
  const ok = s.get('C1') === expected;
  console.log(
    `  range ${String(size).padStart(6)}  edit ${fmt(edit)} ms  ` +
      `SUM = ${String(s.get('C1')).padStart(10)}  ${ok ? 'ok' : 'WRONG'}`,
  );
}

console.log('');
