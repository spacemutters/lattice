/**
 * Application shell: toolbar, formula bar, sheet tabs and the dependency
 * inspector. The grid owns the viewport; this file owns everything around it.
 */

import './styles.css';
import { Grid, type Selection } from './grid.js';
import { Workbook } from './workbook.js';
import { allFunctions } from '../../src/functions.js';
import { keyOf, keyToA1 } from '../../src/refs.js';
import { isError } from '../../src/values.js';

const FUNCTIONS = allFunctions();

const wb = new Workbook();

// ---- elements ----

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;

const addrEl = $<HTMLDivElement>('#addr');
const formulaEl = $<HTMLInputElement>('#formula');
const acEl = $<HTMLDivElement>('#ac');
const tabsEl = $<HTMLDivElement>('#tabs');
const statEl = $<HTMLDivElement>('#stat');
const inspectorEl = $<HTMLDivElement>('#inspector');
const bodyEl = $<HTMLDivElement>('#body');
const undoBtn = $<HTMLButtonElement>('#undo');
const redoBtn = $<HTMLButtonElement>('#redo');
const inspectBtn = $<HTMLButtonElement>('#toggle-inspector');

let inspectorOpen = true;
let acIndex = 0;
let acMatches: typeof FUNCTIONS = [];

// ---- grid ----

const grid = new Grid(wb, {
  onSelectionChange: (sel) => {
    syncFormulaBar(sel);
    updateDependencyMap();
    renderInspector();
    syncToolbarState();
  },
  onEdit: (col, row, raw) => {
    wb.setCell(col, row, raw);
    refresh();
  },
  onRequestRender: () => refresh(),
});

bodyEl.insertBefore(grid.el, inspectorEl);

// ---- formula bar ----

function syncFormulaBar(sel: Selection): void {
  const { col, row } = sel.focus;
  const box = grid.normalized();
  const single = box.c0 === box.c1 && box.r0 === box.r1;
  addrEl.textContent = single
    ? keyToA1(keyOf(col, row))
    : `${keyToA1(keyOf(box.c0, box.r0))}:${keyToA1(keyOf(box.c1, box.r1))}`;
  formulaEl.value = wb.active.engine.getRaw(keyOf(col, row));
  hideAutocomplete();
}

formulaEl.addEventListener('input', () => {
  const text = formulaEl.value;
  const m = /([A-Za-z]{2,})$/.exec(text.slice(0, formulaEl.selectionStart ?? text.length));
  if (!text.startsWith('=') || !m) return hideAutocomplete();
  const prefix = m[1]!.toUpperCase();
  acMatches = FUNCTIONS.filter((f) => f.name.startsWith(prefix)).slice(0, 8);
  if (acMatches.length === 0) return hideAutocomplete();
  acIndex = 0;
  renderAutocomplete();
});

formulaEl.addEventListener('keydown', (e) => {
  if (acMatches.length > 0) {
    if (e.key === 'ArrowDown') { acIndex = (acIndex + 1) % acMatches.length; renderAutocomplete(); e.preventDefault(); return; }
    if (e.key === 'ArrowUp') { acIndex = (acIndex - 1 + acMatches.length) % acMatches.length; renderAutocomplete(); e.preventDefault(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && acMatches[acIndex])) {
      applyCompletion(acMatches[acIndex]!.name);
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') { hideAutocomplete(); e.preventDefault(); return; }
  }

  if (e.key === 'Enter') {
    const { col, row } = grid.sel.focus;
    wb.setCell(col, row, formulaEl.value);
    refresh();
    grid.moveTo(col, row + 1);
    grid.el.focus();
    e.preventDefault();
  } else if (e.key === 'Escape') {
    syncFormulaBar(grid.sel);
    grid.el.focus();
    e.preventDefault();
  }
});

function applyCompletion(name: string): void {
  const caret = formulaEl.selectionStart ?? formulaEl.value.length;
  const before = formulaEl.value.slice(0, caret).replace(/([A-Za-z]{2,})$/, `${name}(`);
  formulaEl.value = before + formulaEl.value.slice(caret);
  const pos = before.length;
  formulaEl.setSelectionRange(pos, pos);
  hideAutocomplete();
}

function renderAutocomplete(): void {
  acEl.hidden = false;
  acEl.replaceChildren(
    ...acMatches.map((f, i) => {
      const btn = document.createElement('button');
      btn.className = 'ac-item';
      btn.type = 'button';
      btn.dataset.active = String(i === acIndex);
      const name = document.createElement('div');
      name.className = 'ac-name';
      name.textContent = `${f.name}()`;
      const desc = document.createElement('div');
      desc.className = 'ac-desc';
      desc.textContent = f.summary;
      btn.append(name, desc);
      btn.addEventListener('mousedown', (e) => { e.preventDefault(); applyCompletion(f.name); });
      return btn;
    }),
  );
}

function hideAutocomplete(): void {
  acMatches = [];
  acEl.hidden = true;
  acEl.replaceChildren();
}

// ---- toolbar ----

function syncToolbarState(): void {
  const keys = grid.selectedKeys();
  const allBold = keys.length > 0 && keys.every((k) => wb.formatOf(k).bold);
  const allItalic = keys.length > 0 && keys.every((k) => wb.formatOf(k).italic);
  $<HTMLButtonElement>('#bold').setAttribute('aria-pressed', String(allBold));
  $<HTMLButtonElement>('#italic').setAttribute('aria-pressed', String(allItalic));
  undoBtn.disabled = !wb.canUndo;
  redoBtn.disabled = !wb.canRedo;
}

$('#bold').addEventListener('click', () => { wb.toggleFormat(grid.selectedKeys(), 'bold'); refresh(); });
$('#italic').addEventListener('click', () => { wb.toggleFormat(grid.selectedKeys(), 'italic'); refresh(); });

for (const align of ['left', 'center', 'right'] as const) {
  $(`#align-${align}`).addEventListener('click', () => {
    wb.format(grid.selectedKeys(), { align });
    refresh();
  });
}

for (const nf of ['auto', 'currency', 'percent', 'comma'] as const) {
  $(`#fmt-${nf}`).addEventListener('click', () => {
    wb.format(grid.selectedKeys(), { numberFormat: nf });
    refresh();
  });
}

undoBtn.addEventListener('click', () => { if (wb.undo()) refresh(); });
redoBtn.addEventListener('click', () => { if (wb.redo()) refresh(); });

inspectBtn.addEventListener('click', () => {
  inspectorOpen = !inspectorOpen;
  inspectorEl.hidden = !inspectorOpen;
  inspectBtn.setAttribute('aria-pressed', String(inspectorOpen));
  updateDependencyMap();
  refresh();
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([wb.toCSV()], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${wb.active.name}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import').addEventListener('click', () => $<HTMLInputElement>('#file').click());
$<HTMLInputElement>('#file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const { c0, r0 } = grid.normalized();
  wb.fromCSV(await file.text(), c0, r0);
  refresh();
  (e.target as HTMLInputElement).value = '';
});

$('#reset').addEventListener('click', () => {
  wb.reset();
  renderTabs();
  refresh();
});

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || grid.isEditing) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { if (wb.undo()) refresh(); e.preventDefault(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { if (wb.redo()) refresh(); e.preventDefault(); }
  else if (k === 'b') { wb.toggleFormat(grid.selectedKeys(), 'bold'); refresh(); e.preventDefault(); }
  else if (k === 'i') { wb.toggleFormat(grid.selectedKeys(), 'italic'); refresh(); e.preventDefault(); }
});

// ---- sheet tabs ----

function renderTabs(): void {
  tabsEl.replaceChildren(
    ...wb.sheets.map((s) => {
      const tab = document.createElement('button');
      tab.className = 'tab';
      tab.type = 'button';
      tab.setAttribute('aria-selected', String(s.id === wb.activeId));
      tab.textContent = s.name;

      tab.addEventListener('click', () => {
        wb.select(s.id);
        renderTabs();
        grid.moveTo(0, 0);
        refresh();
      });
      tab.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const name = prompt('Sheet name', s.name);
        if (name) { wb.renameSheet(s.id, name); renderTabs(); }
      });

      if (wb.sheets.length > 1) {
        const x = document.createElement('span');
        x.className = 'tab-x';
        x.textContent = '×';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          wb.removeSheet(s.id);
          renderTabs();
          refresh();
        });
        tab.append(x);
      }
      return tab;
    }),
    (() => {
      const add = document.createElement('button');
      add.className = 'tab';
      add.type = 'button';
      add.textContent = '+';
      add.title = 'New sheet';
      add.addEventListener('click', () => {
        wb.addSheet();
        renderTabs();
        grid.moveTo(0, 0);
        refresh();
      });
      return add;
    })(),
  );
}

// ---- dependency inspector ----

function updateDependencyMap(): void {
  grid.depMap.clear();
  if (!inspectorOpen) return;
  const { col, row } = grid.sel.focus;
  const key = keyOf(col, row);
  const engine = wb.active.engine;
  for (const p of engine.precedentsOf(key)) grid.depMap.set(p, 'precedent');
  for (const d of engine.dependentsOf(key)) grid.depMap.set(d, 'dependent');
  grid.depMap.delete(key);
}

function renderInspector(): void {
  if (!inspectorOpen) return;
  const { col, row } = grid.sel.focus;
  const key = keyOf(col, row);
  const engine = wb.active.engine;
  const snap = engine.snapshot(key);
  const precedents = engine.precedentsOf(key);
  const dependents = engine.dependentsOf(key);
  const downstream = engine.affectedBy(key);

  const frag = document.createDocumentFragment();

  frag.append(heading('Cell'));
  frag.append(
    card([
      ['Address', snap.a1],
      ['Kind', snap.isFormula ? 'Formula' : snap.raw === '' ? 'Empty' : 'Literal'],
      ['Value', snap.display || '—'],
      ...(snap.isFormula ? ([['Formula', snap.raw]] as Array<[string, string]>) : []),
      ...(snap.error ? ([['Error', snap.error]] as Array<[string, string]>) : []),
    ]),
  );

  frag.append(heading('Dependencies'));
  const depCard = document.createElement('div');
  depCard.className = 'insp-card';

  const legend = document.createElement('div');
  legend.className = 'legend';
  legend.innerHTML =
    '<span><i style="background:var(--precedent)"></i>reads</span>' +
    '<span><i style="background:var(--dependent)"></i>read by</span>';
  depCard.append(legend);

  depCard.append(chipSection('Reads', precedents, 'precedent'));
  depCard.append(chipSection('Read by', dependents, 'dependent'));

  const downstreamRow = document.createElement('div');
  downstreamRow.className = 'insp-row';
  downstreamRow.innerHTML = `<span>Downstream total</span><span>${downstream.length}</span>`;
  depCard.append(downstreamRow);
  frag.append(depCard);

  frag.append(heading('Recalculation'));
  const stats = engine.stats;
  frag.append(
    card([
      ['Last edit touched', `${stats.evaluated} cells`],
      ['Time', `${(stats.micros / 1000).toFixed(2)} ms`],
      ['Formulas on sheet', String(stats.formulas)],
    ]),
  );

  inspectorEl.replaceChildren(frag);
}

function heading(text: string): HTMLElement {
  const h = document.createElement('h2');
  h.className = 'insp-title';
  h.textContent = text;
  return h;
}

function card(rows: Array<[string, string]>): HTMLElement {
  const el = document.createElement('div');
  el.className = 'insp-card';
  for (const [k, v] of rows) {
    const row = document.createElement('div');
    row.className = 'insp-row';
    const a = document.createElement('span');
    a.textContent = k;
    const b = document.createElement('span');
    b.textContent = v;
    row.append(a, b);
    el.append(row);
  }
  return el;
}

function chipSection(label: string, keys: string[], kind: 'precedent' | 'dependent'): HTMLElement {
  const wrap = document.createElement('div');
  const row = document.createElement('div');
  row.className = 'insp-row';
  row.innerHTML = `<span>${label}</span><span>${keys.length}</span>`;
  wrap.append(row);

  if (keys.length > 0) {
    const list = document.createElement('div');
    list.className = 'chip-list';
    for (const k of keys.slice(0, 24).sort()) {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.dataset.kind = kind;
      chip.textContent = keyToA1(k);
      chip.addEventListener('click', () => {
        const [c, r] = k.split(',').map(Number);
        grid.moveTo(c!, r!);
        grid.el.focus();
      });
      list.append(chip);
    }
    if (keys.length > 24) {
      const more = document.createElement('span');
      more.className = 'chip';
      more.textContent = `+${keys.length - 24}`;
      list.append(more);
    }
    wrap.append(list);
  }
  return wrap;
}

// ---- status bar ----

function renderStats(): void {
  const engine = wb.active.engine;
  const s = engine.stats;
  const cells = engine.entries().length;
  const errors = engine.entries().filter((e) => isError(e.value)).length;
  statEl.innerHTML =
    `<span>cells <b>${cells}</b></span>` +
    `<span>formulas <b>${s.formulas}</b></span>` +
    `<span>recalculated <b>${s.evaluated}</b></span>` +
    `<span>in <b>${(s.micros / 1000).toFixed(2)} ms</b></span>` +
    (errors > 0 ? `<span>errors <b>${errors}</b></span>` : '');
}

// ---- refresh ----

function refresh(): void {
  updateDependencyMap();
  grid.render();
  renderInspector();
  renderStats();
  syncToolbarState();
  syncFormulaBar(grid.sel);
}

// ---- start ----

/**
 * `?cell=D2` opens the sheet with that cell selected, so a link can point at a
 * particular formula and its dependency graph rather than just the front page.
 */
function startingCell(): { col: number; row: number } {
  const raw = new URLSearchParams(location.search).get('cell');
  const m = raw ? /^([A-Za-z]{1,3})([1-9][0-9]{0,6})$/.exec(raw.trim()) : null;
  if (!m) return { col: 0, row: 0 };
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

renderTabs();
const start = startingCell();
grid.moveTo(start.col, start.row);
refresh();
grid.el.focus();
window.addEventListener('resize', () => grid.schedule());
