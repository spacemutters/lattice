/**
 * A1 notation.
 *
 * Columns are base-26 with no zero digit, which is why `Z` is followed by `AA`
 * rather than `BA`. The conversion below handles that bijective numbering in
 * both directions.
 */

export interface CellRef {
  readonly col: number;
  readonly row: number;
  readonly colAbsolute: boolean;
  readonly rowAbsolute: boolean;
}

export interface RangeRef {
  readonly start: CellRef;
  readonly end: CellRef;
}

const A1_PATTERN = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9][0-9]{0,6})$/;

/** `A` -> 0, `Z` -> 25, `AA` -> 26. Bijective base-26. */
export function columnToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** 0 -> `A`, 25 -> `Z`, 26 -> `AA`. */
export function indexToColumn(index: number): string {
  if (index < 0) throw new RangeError(`column index ${index} is negative`);
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Parse `A1`, `$A$1`, `B$7`. Returns null when the text is not a reference. */
export function parseRef(text: string): CellRef | null {
  const m = A1_PATTERN.exec(text);
  if (!m) return null;
  const [, colAbs, letters, rowAbs, digits] = m;
  if (letters === undefined || digits === undefined) return null;
  const col = columnToIndex(letters);
  const row = Number(digits) - 1;
  return {
    col,
    row,
    colAbsolute: colAbs === '$',
    rowAbsolute: rowAbs === '$',
  };
}

export function formatRef(ref: CellRef): string {
  const c = (ref.colAbsolute ? '$' : '') + indexToColumn(ref.col);
  const r = (ref.rowAbsolute ? '$' : '') + String(ref.row + 1);
  return c + r;
}

/** A stable key for graph lookups. Ignores absoluteness: `$A$1` and `A1` are one cell. */
export function keyOf(col: number, row: number): string {
  return `${col},${row}`;
}

export function keyOfRef(ref: CellRef): string {
  return keyOf(ref.col, ref.row);
}

export function parseKey(key: string): { col: number; row: number } {
  const i = key.indexOf(',');
  return { col: Number(key.slice(0, i)), row: Number(key.slice(i + 1)) };
}

/** Human-readable form of a key, for error messages. */
export function keyToA1(key: string): string {
  const { col, row } = parseKey(key);
  return indexToColumn(col) + String(row + 1);
}

/**
 * Normalise a range so start is always the top-left corner.
 * `B3:A1` and `A1:B3` describe the same block.
 */
export function normalizeRange(range: RangeRef): RangeRef {
  const { start, end } = range;
  return {
    start: {
      col: Math.min(start.col, end.col),
      row: Math.min(start.row, end.row),
      colAbsolute: start.colAbsolute,
      rowAbsolute: start.rowAbsolute,
    },
    end: {
      col: Math.max(start.col, end.col),
      row: Math.max(start.row, end.row),
      colAbsolute: end.colAbsolute,
      rowAbsolute: end.rowAbsolute,
    },
  };
}

/** Every cell key inside a range, row-major. */
export function* rangeKeys(range: RangeRef): Generator<string> {
  const { start, end } = normalizeRange(range);
  for (let row = start.row; row <= end.row; row++) {
    for (let col = start.col; col <= end.col; col++) {
      yield keyOf(col, row);
    }
  }
}

export function rangeSize(range: RangeRef): number {
  const { start, end } = normalizeRange(range);
  return (end.col - start.col + 1) * (end.row - start.row + 1);
}
