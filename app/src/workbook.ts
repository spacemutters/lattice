/**
 * Workbook state: several sheets, per-cell formatting, undo/redo, persistence.
 *
 * The engine owns values. This layer owns everything the engine deliberately
 * does not care about — what a cell looks like, which sheet you are on, and how
 * to get back to where you were.
 */

import { Sheet } from '../../src/sheet.js';
import { keyOf, keyToA1 } from '../../src/refs.js';

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  align?: 'left' | 'center' | 'right';
  numberFormat?: 'auto' | 'plain' | 'currency' | 'percent' | 'comma';
}

export interface SheetState {
  id: string;
  name: string;
  engine: Sheet;
  formats: Map<string, CellFormat>;
  cursor: { col: number; row: number };
}

interface Snapshot {
  activeId: string;
  sheets: Array<{
    id: string;
    name: string;
    cells: Array<[string, string]>;
    formats: Array<[string, CellFormat]>;
  }>;
}

const STORAGE_KEY = 'lattice.workbook.v1';
const MAX_HISTORY = 120;

export class Workbook {
  sheets: SheetState[] = [];
  activeId = '';

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private nextId = 1;

  constructor() {
    if (!this.load()) this.seed();
  }

  get active(): SheetState {
    return this.sheets.find((s) => s.id === this.activeId) ?? this.sheets[0]!;
  }

  // ---- sheets ----

  addSheet(name?: string): SheetState {
    this.commit();
    const id = `s${this.nextId++}`;
    const sheet: SheetState = {
      id,
      name: name ?? `Sheet ${this.sheets.length + 1}`,
      engine: new Sheet(),
      formats: new Map(),
      cursor: { col: 0, row: 0 },
    };
    this.sheets.push(sheet);
    this.activeId = id;
    this.save();
    return sheet;
  }

  removeSheet(id: string): void {
    if (this.sheets.length <= 1) return;
    this.commit();
    const i = this.sheets.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.sheets.splice(i, 1);
    if (this.activeId === id) {
      this.activeId = this.sheets[Math.min(i, this.sheets.length - 1)]!.id;
    }
    this.save();
  }

  renameSheet(id: string, name: string): void {
    const sheet = this.sheets.find((s) => s.id === id);
    if (!sheet || name.trim() === '') return;
    this.commit();
    sheet.name = name.trim();
    this.save();
  }

  select(id: string): void {
    if (this.sheets.some((s) => s.id === id)) this.activeId = id;
  }

  // ---- editing ----

  /** Write one cell. Pushes an undo entry. */
  setCell(col: number, row: number, raw: string): void {
    this.commit();
    this.active.engine.set(keyOf(col, row), raw);
    this.save();
  }

  /** Write many cells as one undoable action, with one recalculation. */
  setCells(writes: Array<[string, string]>): void {
    if (writes.length === 0) return;
    this.commit();
    this.active.engine.setMany(writes);
    this.save();
  }

  format(keys: string[], patch: CellFormat): void {
    if (keys.length === 0) return;
    this.commit();
    const { formats } = this.active;
    for (const key of keys) {
      formats.set(key, { ...formats.get(key), ...patch });
    }
    this.save();
  }

  /** Flip a boolean format across a selection: all-on becomes all-off. */
  toggleFormat(keys: string[], prop: 'bold' | 'italic'): void {
    if (keys.length === 0) return;
    const { formats } = this.active;
    const allOn = keys.every((k) => formats.get(k)?.[prop]);
    this.format(keys, { [prop]: !allOn } as CellFormat);
  }

  formatOf(key: string): CellFormat {
    return this.active.formats.get(key) ?? {};
  }

  clearCells(keys: string[]): void {
    if (keys.length === 0) return;
    this.commit();
    this.active.engine.setMany(keys.map((k) => [k, ''] as [string, string]));
    for (const k of keys) this.active.formats.delete(k);
    this.save();
  }

  // ---- history ----

  private commit(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
    this.save();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    this.save();
    return true;
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }

  // ---- serialisation ----

  private snapshot(): Snapshot {
    return {
      activeId: this.activeId,
      sheets: this.sheets.map((s) => ({
        id: s.id,
        name: s.name,
        cells: s.engine.entries().map((e) => [e.key, e.raw] as [string, string]),
        formats: [...s.formats.entries()].map(([k, v]) => [k, { ...v }] as [string, CellFormat]),
      })),
    };
  }

  private restore(snap: Snapshot): void {
    this.sheets = snap.sheets.map((s) => {
      const engine = new Sheet();
      engine.setMany(s.cells);
      return {
        id: s.id,
        name: s.name,
        engine,
        formats: new Map(s.formats),
        cursor: { col: 0, row: 0 },
      };
    });
    this.activeId = snap.activeId;
    if (!this.sheets.some((s) => s.id === this.activeId)) {
      this.activeId = this.sheets[0]?.id ?? '';
    }
  }

  save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.snapshot()));
    } catch {
      // Private windows and blocked storage are fine; the sheet still works.
    }
  }

  private load(): boolean {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return false;
    }
    if (!raw) return false;
    try {
      const snap = JSON.parse(raw) as Snapshot;
      if (!Array.isArray(snap.sheets) || snap.sheets.length === 0) return false;
      this.restore(snap);
      const highest = Math.max(
        0,
        ...this.sheets.map((s) => Number(s.id.replace(/\D/g, '')) || 0),
      );
      this.nextId = highest + 1;
      return true;
    } catch {
      return false;
    }
  }

  reset(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.sheets = [];
    this.nextId = 1;
    this.seed();
    this.save();
  }

  // ---- CSV ----

  toCSV(): string {
    const entries = this.active.engine.entries();
    if (entries.length === 0) return '';
    let maxCol = 0;
    let maxRow = 0;
    for (const e of entries) {
      const [c, r] = e.key.split(',').map(Number);
      maxCol = Math.max(maxCol, c!);
      maxRow = Math.max(maxRow, r!);
    }
    const lines: string[] = [];
    for (let r = 0; r <= maxRow; r++) {
      const cells: string[] = [];
      for (let c = 0; c <= maxCol; c++) {
        const text = this.active.engine.getDisplay(keyOf(c, r));
        cells.push(/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
      }
      lines.push(cells.join(','));
    }
    return lines.join('\n');
  }

  fromCSV(text: string, startCol = 0, startRow = 0): void {
    const rows = parseCSV(text);
    const writes: Array<[string, string]> = [];
    rows.forEach((cells, r) => {
      cells.forEach((value, c) => {
        if (value !== '') writes.push([keyOf(startCol + c, startRow + r), value]);
      });
    });
    this.setCells(writes);
  }

  // ---- starting content ----

  private seed(): void {
    const id = `s${this.nextId++}`;
    const engine = new Sheet();

    engine.setMany([
      ['A1', 'Region'], ['B1', 'Units'], ['C1', 'Price'], ['D1', 'Revenue'], ['E1', 'Share'],
      ['A2', 'North'], ['B2', '1240'], ['C2', '18.50'], ['D2', '=B2*C2'], ['E2', '=D2/$D$7'],
      ['A3', 'South'], ['B3', '980'],  ['C3', '18.50'], ['D3', '=B3*C3'], ['E3', '=D3/$D$7'],
      ['A4', 'East'],  ['B4', '1570'], ['C4', '17.25'], ['D4', '=B4*C4'], ['E4', '=D4/$D$7'],
      ['A5', 'West'],  ['B5', '2310'], ['C5', '16.80'], ['D5', '=B5*C5'], ['E5', '=D5/$D$7'],
      ['A6', 'Inland'],['B6', '415'],  ['C6', '21.00'], ['D6', '=B6*C6'], ['E6', '=D6/$D$7'],

      ['A7', 'Total'], ['B7', '=SUM(B2:B6)'], ['C7', '=AVERAGE(C2:C6)'], ['D7', '=SUM(D2:D6)'], ['E7', '=SUM(E2:E6)'],

      ['A9',  'Best region'],   ['B9',  '=INDEX(A2:A6,MATCH(MAX(D2:D6),D2:D6))'],
      ['A10', 'Best revenue'],  ['B10', '=MAX(D2:D6)'],
      ['A11', 'Above average'], ['B11', '=COUNTIF(D2:D6,">"&AVERAGE(D2:D6))'],
      ['A12', 'Spread'],        ['B12', '=MAX(D2:D6)-MIN(D2:D6)'],
      ['A13', 'Std deviation'], ['B13', '=ROUND(STDEV(D2:D6),2)'],
      ['A14', 'Headline'],      ['B14', '=B9&" leads with "&TEXTJOIN'],
    ]);

    // That last one is deliberately broken, to show an error rendering properly.
    engine.set('B14', '=B9&" leads on "&ROUND(B10,0)');

    const formats = new Map<string, CellFormat>();
    for (const k of ['A1', 'B1', 'C1', 'D1', 'E1']) {
      formats.set(toKey(k), { bold: true, align: 'center' });
    }
    for (const k of ['A7', 'B7', 'C7', 'D7', 'E7']) {
      formats.set(toKey(k), { bold: true });
    }
    for (const k of ['C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'B10']) {
      formats.set(toKey(k), { numberFormat: 'currency' });
    }
    for (const k of ['E2', 'E3', 'E4', 'E5', 'E6', 'E7']) {
      formats.set(toKey(k), { numberFormat: 'percent' });
    }
    for (const k of ['A9', 'A10', 'A11', 'A12', 'A13', 'A14']) {
      formats.set(toKey(k), { bold: true });
    }

    this.sheets = [{ id, name: 'Revenue', engine, formats, cursor: { col: 0, row: 0 } }];
    this.activeId = id;

    const second = new Sheet();
    second.setMany([
      ['A1', 'n'], ['B1', 'n squared'], ['C1', 'running total'],
      ...Array.from({ length: 24 }, (_, i) => {
        const r = i + 2;
        return [
          [`A${r}`, String(i + 1)],
          [`B${r}`, `=A${r}^2`],
          [`C${r}`, r === 2 ? `=B${r}` : `=C${r - 1}+B${r}`],
        ] as Array<[string, string]>;
      }).flat(),
    ]);
    const secondFormats = new Map<string, CellFormat>([
      [toKey('A1'), { bold: true, align: 'center' }],
      [toKey('B1'), { bold: true, align: 'center' }],
      [toKey('C1'), { bold: true, align: 'center' }],
    ]);
    this.sheets.push({
      id: `s${this.nextId++}`,
      name: 'Chain',
      engine: second,
      formats: secondFormats,
      cursor: { col: 0, row: 0 },
    });
  }
}

function toKey(a1: string): string {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return keyOf(col - 1, Number(m[2]) - 1);
}

/** RFC-4180-ish CSV reader: handles quotes, escaped quotes and CRLF. */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

export { keyToA1 };
