# Lattice

A spreadsheet formula engine, and a spreadsheet built on top of it.

Type `=B2*C2` into a cell and three things have to happen: the text has to be
parsed into a tree, the tree has to know which cells it reads, and when one of
those cells changes, everything downstream has to recompute — in the right
order, once each, without recomputing the rest of the sheet.

That last part is the interesting one. **In a 40,000-cell sheet, editing one
cell recomputes 39 of them and leaves the other 39,961 alone.**

**[Try it →](https://lattice-sheets.vercel.app)**

---

## What's here

| | |
|---|---|
| `src/` | The engine. No dependencies. |
| `app/` | A spreadsheet application using it. |
| `tests/` | 89 tests. |
| `bench/` | The benchmark whose numbers appear below. |

## The engine

```ts
import { Sheet } from '@spacemutters/lattice';

const sheet = new Sheet();
sheet.set('A1', '10');
sheet.set('A2', '20');
sheet.set('B1', '=SUM(A1:A2) * 1.2');

sheet.get('B1');        // 36
sheet.getDisplay('B1'); // "36"

sheet.set('A1', '40');
sheet.get('B1');        // 72
sheet.stats.evaluated;  // 1 — only B1 was recomputed
```

### How it works

**Tokenizer** (`lexer.ts`) — one pass, no backtracking. The only genuinely
ambiguous character is `-`, which the parser resolves rather than the lexer.

**Pratt parser** (`parser.ts`) — precedence climbing. Each operator has a
binding power; a left-associative operator parses its right side at `bp + 1`,
a right-associative one at `bp`. That single difference is all of associativity:

```
=2^3^2   →  512   (right-associative, so 2^(3^2))
=-2^2    →  4     (unary minus binds tighter than ^)
=10-3-2  →  5     (left-associative)
=1+2=3   →  TRUE  (comparison binds loosest)
```

**Dependency graph** (`graph.ts`) — two adjacency maps, `precedents` and
`dependents`. The second is what makes recalculation incremental: after a cell
changes, the cells that could possibly be affected are exactly its transitive
dependents, so everything else can be skipped.

**Ordering** — Kahn's algorithm over the affected subgraph only. Anything still
holding an unsatisfied edge when the queue drains is in a cycle, and gets
`#CYCLE!` instead of an infinite loop. A self-reference like `=A1+1` works out
naturally: its own in-degree never reaches zero.

**Evaluation** (`evaluator.ts`) — errors are values, not exceptions. `=1/0` is
`#DIV/0!`, and anything reading it becomes `#DIV/0!` too, while the rest of the
sheet keeps working. That is how spreadsheets behave, and it means one bad cell
cannot take down a recalculation pass.

### Functions

51 of them: `SUM` `AVERAGE` `MIN` `MAX` `MEDIAN` `STDEV` `VAR` `PRODUCT`
`ABS` `SQRT` `INT` `SIGN` `EXP` `LN` `LOG10` `SIN` `COS` `TAN` `ROUND`
`ROUNDUP` `ROUNDDOWN` `MOD` `POWER` `PI` `COUNT` `COUNTA` `COUNTBLANK`
`COUNTIF` `SUMIF` `AVERAGEIF` `IF` `IFERROR` `AND` `OR` `NOT` `ISERROR`
`ISBLANK` `ISNUMBER` `TRUE` `FALSE` `CONCAT` `LEN` `UPPER` `LOWER` `TRIM`
`LEFT` `RIGHT` `MID` `VLOOKUP` `INDEX` `MATCH`

Spreadsheet semantics are kept where they differ from JavaScript's:
`MOD(-1,3)` is `2`, not `-1`. `ROUND(1.005,2)` is `1.01`, not `1`.
`0.1+0.2` displays as `0.3`.

## The application

A real spreadsheet, not a toy embed:

- **Virtualized grid** — only visible cells are in the DOM, so 60 × 1000 costs
  what 60 × 20 costs.
- **Dependency inspector** — select a cell and the sheet shows you the graph.
  Blue is what it reads, orange is what reads it.
- Multi-sheet workbooks, formatting (bold, italic, alignment, currency,
  percentage, thousands), undo/redo, CSV import and export, and persistence.
- Full keyboard navigation: arrows, `Tab`, `Enter`, `Shift` to extend,
  `Ctrl`+arrow to jump, `F2` to edit, type to replace.
- Function autocomplete in the formula bar.
- Follows the system light/dark setting. There is no theme toggle, on purpose.

The interface follows Apple's Human Interface Guidelines — system colours
(`#007AFF` tint, `#8E8E93` secondary label, `#F2F2F7` secondary background),
Apple's web radius ladder (5, 9, 12, 17), an 8px spacing rhythm, and `.1s` in /
`.21s` out motion. It looks like Apple Numbers because it *is* a spreadsheet;
the reference has product logic rather than being decoration.

## Benchmarks

From `npm run bench`, on a single machine — relative numbers matter more than
absolute:

```
One edit in a 40,000-cell sheet
  total cells                  40000
  edit A1 -> recomputed           39  in 10.22 ms
  fraction of sheet touched   0.097%
  full rebuild                973.12 ms
  speed-up                       95x

A single chain, each cell reading the one before
  depth   100   0.63 ms
  depth  1000   5.33 ms
  depth  5000  24.95 ms

One cell read by many
  fan-out  100   0.52 ms
  fan-out 1000   2.90 ms
  fan-out 5000  18.13 ms
```

The point is not that it is fast in absolute terms. It is that cost tracks the
size of the *change*, not the size of the sheet.

## Tests

89 tests covering precedence and associativity, error propagation, cycle
detection and recovery, incremental recalculation (asserting the *number* of
cells recomputed, not just the result), range normalisation, spreadsheet-
specific numeric behaviour, and malformed input.

Every malformed formula is asserted to produce an error value rather than throw:

```
=1+    =(1    =SUM(    =*2    =1++    =A1:    ="unclosed
```

```bash
npm test          # 89 tests
npm run coverage
npm run bench
npm run typecheck
```

## Running it

```bash
npm install
npm run app:dev   # the spreadsheet, on :5180
npm run build     # the library
```

## Limitations

Worth stating plainly:

- **Single sheet per engine.** The app has multiple sheets, but each owns its
  own engine instance, so there are no cross-sheet references like `Sheet2!A1`.
  That needs sheet-qualified keys throughout the graph.
- **No array formulas.** A range collapses to a scalar or feeds an aggregate;
  it does not spill.
- **No dates.** There is no serial-date model, so no `TODAY` or `DATEDIF`.
- **Recalculation is synchronous.** A 5,000-cell chain blocks for ~25 ms. Large
  sheets would want the work sliced across frames.

## Licence

MIT
