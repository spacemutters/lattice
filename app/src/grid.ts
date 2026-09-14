/**
 * The grid.
 *
 * Only the cells inside the viewport are in the DOM. Scrolling recomputes the
 * visible window and rebuilds that slice inside a rAF, so a 60 x 1000 sheet
 * costs the same to render as a 60 x 20 one.
 */

import { indexToColumn, keyOf } from '../../src/refs.js';
import { display, isError } from '../../src/values.js';
import type { CellFormat, Workbook } from './workbook.js';

export const COLS = 60;
export const ROWS = 1000;
const ROW_H = 25;
const COL_W = 104;
const GUTTER_W = 46;
const OVERSCAN = 4;

export interface Selection {
  anchor: { col: number; row: number };
  focus: { col: number; row: number };
}

export interface GridCallbacks {
  onSelectionChange(sel: Selection): void;
  onEdit(col: number, row: number, raw: string): void;
  onRequestRender(): void;
}

export class Grid {
  readonly el: HTMLDivElement;
  private readonly canvas: HTMLDivElement;
  private readonly selBox: HTMLDivElement;
  private editor: HTMLInputElement | null = null;

  sel: Selection = { anchor: { col: 0, row: 0 }, focus: { col: 0, row: 0 } };
  /** Cells to tint as precedents / dependents of the cursor. */
  depMap = new Map<string, 'precedent' | 'dependent'>();

  private dragging = false;
  private frame = 0;

  constructor(
    private readonly wb: Workbook,
    private readonly cb: GridCallbacks,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'grid-wrap';
    this.el.tabIndex = 0;

    this.canvas = document.createElement('div');
    this.canvas.className = 'canvas';
    this.canvas.style.width = `${GUTTER_W + COLS * COL_W}px`;
    this.canvas.style.height = `${ROW_H + ROWS * ROW_H}px`;
    this.el.append(this.canvas);

    this.selBox = document.createElement('div');
    this.selBox.className = 'selection';
    const handle = document.createElement('div');
    handle.className = 'handle';
    this.selBox.append(handle);

    this.el.addEventListener('scroll', () => this.schedule(), { passive: true });
    this.el.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', () => { this.dragging = false; });
    this.el.addEventListener('dblclick', () => this.beginEdit());
    this.el.addEventListener('keydown', (e) => this.onKeyDown(e));
    this.el.addEventListener('copy', (e) => this.onCopy(e as ClipboardEvent));
    this.el.addEventListener('paste', (e) => this.onPaste(e as ClipboardEvent));
  }

  // ---- rendering ----

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render(): void {
    const { scrollTop, scrollLeft, clientHeight, clientWidth } = this.el;

    const firstRow = Math.max(0, Math.floor((scrollTop - ROW_H) / ROW_H) - OVERSCAN);
    const lastRow = Math.min(ROWS - 1, Math.ceil((scrollTop + clientHeight) / ROW_H) + OVERSCAN);
    const firstCol = Math.max(0, Math.floor((scrollLeft - GUTTER_W) / COL_W) - OVERSCAN);
    const lastCol = Math.min(COLS - 1, Math.ceil((scrollLeft + clientWidth) / COL_W) + OVERSCAN);

    const frag = document.createDocumentFragment();
    const engine = this.wb.active.engine;
    const box = this.normalized();

    // corner
    const corner = document.createElement('div');
    corner.className = 'corner';
    corner.style.width = `${GUTTER_W}px`;
    corner.style.transform = `translate(${scrollLeft}px, ${scrollTop}px)`;
    frag.append(corner);

    // column headers
    for (let c = firstCol; c <= lastCol; c++) {
      const h = document.createElement('div');
      h.className = 'head';
      h.style.width = `${COL_W}px`;
      h.style.left = `${GUTTER_W + c * COL_W}px`;
      h.style.transform = `translateY(${scrollTop}px)`;
      h.textContent = indexToColumn(c);
      if (c >= box.c0 && c <= box.c1) h.dataset.sel = 'true';
      frag.append(h);
    }

    // row gutters
    for (let r = firstRow; r <= lastRow; r++) {
      const g = document.createElement('div');
      g.className = 'gutter';
      g.style.width = `${GUTTER_W}px`;
      g.style.top = `${ROW_H + r * ROW_H}px`;
      g.style.transform = `translateX(${scrollLeft}px)`;
      g.textContent = String(r + 1);
      if (r >= box.r0 && r <= box.r1) g.dataset.sel = 'true';
      frag.append(g);
    }

    // cells
    for (let r = firstRow; r <= lastRow; r++) {
      for (let c = firstCol; c <= lastCol; c++) {
        const key = keyOf(c, r);
        const value = engine.get(key);
        const fmt = this.wb.formatOf(key);

        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.style.width = `${COL_W}px`;
        cell.style.left = `${GUTTER_W + c * COL_W}px`;
        cell.style.top = `${ROW_H + r * ROW_H}px`;

        if (value !== null) {
          cell.textContent = formatValue(value, fmt);
          if (isError(value)) cell.dataset.err = 'true';
          else if (typeof value === 'number') cell.dataset.num = 'true';
        }

        if (fmt.bold) cell.dataset.bold = 'true';
        if (fmt.italic) cell.dataset.italic = 'true';
        if (fmt.align) cell.dataset.align = fmt.align;

        const dep = this.depMap.get(key);
        if (dep) cell.dataset.dep = dep;
        else if (c >= box.c0 && c <= box.c1 && r >= box.r0 && r <= box.r1) {
          cell.dataset.inRange = 'true';
        }

        frag.append(cell);
      }
    }

    this.canvas.replaceChildren(frag);
    this.canvas.append(this.selBox);
    this.positionSelection();
  }

  private positionSelection(): void {
    const box = this.normalized();
    this.selBox.style.left = `${GUTTER_W + box.c0 * COL_W}px`;
    this.selBox.style.top = `${ROW_H + box.r0 * ROW_H}px`;
    this.selBox.style.width = `${(box.c1 - box.c0 + 1) * COL_W}px`;
    this.selBox.style.height = `${(box.r1 - box.r0 + 1) * ROW_H}px`;
  }

  // ---- selection ----

  normalized(): { c0: number; c1: number; r0: number; r1: number } {
    const { anchor, focus } = this.sel;
    return {
      c0: Math.min(anchor.col, focus.col),
      c1: Math.max(anchor.col, focus.col),
      r0: Math.min(anchor.row, focus.row),
      r1: Math.max(anchor.row, focus.row),
    };
  }

  selectedKeys(): string[] {
    const { c0, c1, r0, r1 } = this.normalized();
    const keys: string[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) keys.push(keyOf(c, r));
    return keys;
  }

  moveTo(col: number, row: number, extend = false): void {
    const c = clamp(col, 0, COLS - 1);
    const r = clamp(row, 0, ROWS - 1);
    this.sel = extend
      ? { anchor: this.sel.anchor, focus: { col: c, row: r } }
      : { anchor: { col: c, row: r }, focus: { col: c, row: r } };
    this.scrollIntoView(c, r);
    this.cb.onSelectionChange(this.sel);
    this.schedule();
  }

  private scrollIntoView(col: number, row: number): void {
    const x = GUTTER_W + col * COL_W;
    const y = ROW_H + row * ROW_H;
    if (x < this.el.scrollLeft + GUTTER_W) this.el.scrollLeft = x - GUTTER_W;
    else if (x + COL_W > this.el.scrollLeft + this.el.clientWidth) {
      this.el.scrollLeft = x + COL_W - this.el.clientWidth;
    }
    if (y < this.el.scrollTop + ROW_H) this.el.scrollTop = y - ROW_H;
    else if (y + ROW_H > this.el.scrollTop + this.el.clientHeight) {
      this.el.scrollTop = y + ROW_H - this.el.clientHeight;
    }
  }

  private hit(e: MouseEvent): { col: number; row: number } | null {
    const rect = this.el.getBoundingClientRect();
    const x = e.clientX - rect.left + this.el.scrollLeft - GUTTER_W;
    const y = e.clientY - rect.top + this.el.scrollTop - ROW_H;
    if (x < 0 || y < 0) return null;
    return { col: Math.floor(x / COL_W), row: Math.floor(y / ROW_H) };
  }

  private onMouseDown(e: MouseEvent): void {
    if (this.editor) this.commitEdit();
    const pos = this.hit(e);
    if (!pos) return;
    this.el.focus();
    this.dragging = true;
    this.moveTo(pos.col, pos.row, e.shiftKey);
    e.preventDefault();
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.dragging) return;
    const pos = this.hit(e);
    if (!pos) return;
    if (pos.col === this.sel.focus.col && pos.row === this.sel.focus.row) return;
    this.moveTo(pos.col, pos.row, true);
  }

  // ---- keyboard ----

  private onKeyDown(e: KeyboardEvent): void {
    if (this.editor) return;

    const { col, row } = this.sel.focus;
    const mod = e.ctrlKey || e.metaKey;

    switch (e.key) {
      case 'ArrowUp':    this.moveTo(col, mod ? 0 : row - 1, e.shiftKey); break;
      case 'ArrowDown':  this.moveTo(col, mod ? ROWS - 1 : row + 1, e.shiftKey); break;
      case 'ArrowLeft':  this.moveTo(mod ? 0 : col - 1, row, e.shiftKey); break;
      case 'ArrowRight': this.moveTo(mod ? COLS - 1 : col + 1, row, e.shiftKey); break;
      case 'Tab':        this.moveTo(col + (e.shiftKey ? -1 : 1), row); break;
      case 'Enter':      this.moveTo(col, row + (e.shiftKey ? -1 : 1)); break;
      case 'Home':       this.moveTo(0, mod ? 0 : row); break;
      case 'End':        this.moveTo(COLS - 1, row); break;
      case 'PageDown':   this.moveTo(col, row + 20, e.shiftKey); break;
      case 'PageUp':     this.moveTo(col, row - 20, e.shiftKey); break;
      case 'Delete':
      case 'Backspace':
        this.wb.clearCells(this.selectedKeys());
        this.cb.onRequestRender();
        break;
      case 'F2':
        this.beginEdit();
        break;
      case 'Escape':
        this.moveTo(col, row);
        break;
      default:
        // A printable key starts editing, replacing what was there.
        if (!mod && !e.altKey && e.key.length === 1) {
          this.beginEdit(e.key);
        } else {
          return;
        }
    }
    e.preventDefault();
  }

  // ---- inline editing ----

  beginEdit(seed?: string): void {
    if (this.editor) return;
    const { col, row } = this.sel.focus;
    const key = keyOf(col, row);

    const input = document.createElement('input');
    input.className = 'editor';
    input.style.left = `${GUTTER_W + col * COL_W}px`;
    input.style.top = `${ROW_H + row * ROW_H}px`;
    input.style.width = `${COL_W}px`;
    input.style.height = `${ROW_H}px`;
    input.value = seed ?? this.wb.active.engine.getRaw(key);

    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter')  { this.commitEdit(); this.moveTo(col, row + 1); e.preventDefault(); }
      else if (e.key === 'Tab') { this.commitEdit(); this.moveTo(col + 1, row); e.preventDefault(); }
      else if (e.key === 'Escape') { this.cancelEdit(); this.el.focus(); e.preventDefault(); }
    });
    input.addEventListener('blur', () => this.commitEdit());

    this.canvas.append(input);
    this.editor = input;
    input.focus();
    if (seed === undefined) input.select();
  }

  private commitEdit(): void {
    const input = this.editor;
    if (!input) return;
    this.editor = null;
    const { col, row } = this.sel.focus;
    const value = input.value;
    input.remove();
    this.cb.onEdit(col, row, value);
  }

  private cancelEdit(): void {
    this.editor?.remove();
    this.editor = null;
    this.schedule();
  }

  get isEditing(): boolean {
    return this.editor !== null;
  }

  // ---- clipboard ----

  private onCopy(e: ClipboardEvent): void {
    const { c0, c1, r0, r1 } = this.normalized();
    const engine = this.wb.active.engine;
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const row: string[] = [];
      for (let c = c0; c <= c1; c++) row.push(engine.getDisplay(keyOf(c, r)));
      lines.push(row.join('\t'));
    }
    e.clipboardData?.setData('text/plain', lines.join('\n'));
    e.preventDefault();
  }

  private onPaste(e: ClipboardEvent): void {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    const { c0, r0 } = this.normalized();
    const writes: Array<[string, string]> = [];
    text.replace(/\r/g, '').split('\n').forEach((line, r) => {
      line.split('\t').forEach((value, c) => {
        writes.push([keyOf(c0 + c, r0 + r), value]);
      });
    });
    this.wb.setCells(writes);
    this.cb.onRequestRender();
    e.preventDefault();
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/** Apply the cell's number format for display. */
export function formatValue(value: unknown, fmt: CellFormat): string {
  const text = display(value as never);
  if (typeof value !== 'number') return text;

  switch (fmt.numberFormat) {
    case 'currency':
      return value.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      });
    case 'percent':
      return value.toLocaleString(undefined, {
        style: 'percent',
        maximumFractionDigits: 1,
      });
    case 'comma':
      return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
    case 'plain':
      return String(value);
    default:
      return text;
  }
}
