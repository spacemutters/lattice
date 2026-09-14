import { describe, expect, it } from 'vitest';
import { Sheet } from '../src/sheet.js';
import { parse } from '../src/parser.js';
import { tokenize } from '../src/lexer.js';
import { columnToIndex, indexToColumn } from '../src/refs.js';
import { FormulaError, isError } from '../src/values.js';

function sheet(cells: Record<string, string>): Sheet {
  const s = new Sheet();
  s.setMany(Object.entries(cells));
  return s;
}

describe('column notation', () => {
  it('round-trips bijective base-26', () => {
    const cases: Array<[number, string]> = [
      [0, 'A'],
      [25, 'Z'],
      [26, 'AA'],
      [51, 'AZ'],
      [52, 'BA'],
      [701, 'ZZ'],
      [702, 'AAA'],
    ];
    for (const [index, letters] of cases) {
      expect(indexToColumn(index)).toBe(letters);
      expect(columnToIndex(letters)).toBe(index);
    }
  });

  it('round-trips every column in the first four thousand', () => {
    for (let i = 0; i < 4000; i++) {
      expect(columnToIndex(indexToColumn(i))).toBe(i);
    }
  });
});

describe('lexer', () => {
  it('keeps two-character comparisons whole', () => {
    const ops = tokenize('1<=2').filter((t) => t.type === 'operator');
    expect(ops.map((t) => t.value)).toEqual(['<=']);
  });

  it('reads doubled quotes as one literal quote', () => {
    const [tok] = tokenize('"she said ""hi"""');
    expect(tok?.value).toBe('she said "hi"');
  });

  it('does not swallow a trailing e as an exponent', () => {
    const types = tokenize('1e').map((t) => t.type);
    expect(types).toEqual(['number', 'identifier', 'eof']);
  });

  it('rejects an unterminated string', () => {
    expect(() => tokenize('"open')).toThrow(/unterminated/);
  });
});

describe('operator precedence', () => {
  const cases: Array<[string, number]> = [
    ['=1+2*3', 7],
    ['=(1+2)*3', 9],
    ['=2^3^2', 512],        // right-associative
    ['=-2^2', 4],           // unary minus binds tighter than ^
    ['=10-3-2', 5],         // left-associative
    ['=2*3%', 0.06],        // percent is postfix and binds tightest
    ['=1+2=3', 1],          // comparison is loosest, so this is (1+2)=3
  ];

  for (const [formula, expected] of cases) {
    it(`${formula} is ${expected}`, () => {
      const s = sheet({ A1: formula });
      const v = s.get('A1');
      expect(typeof v === 'boolean' ? (v ? 1 : 0) : v).toBe(expected);
    });
  }

  it('parses without throwing for every precedence case', () => {
    for (const [formula] of cases) {
      expect(() => parse(formula)).not.toThrow();
    }
  });
});

describe('arithmetic and errors', () => {
  it('divides by zero into #DIV/0!', () => {
    const s = sheet({ A1: '=1/0' });
    expect(String(s.get('A1'))).toBe('#DIV/0!');
  });

  it('propagates an error through every dependent', () => {
    const s = sheet({ A1: '=1/0', B1: '=A1+1', C1: '=B1*2' });
    expect(String(s.get('C1'))).toBe('#DIV/0!');
  });

  it('reports an unknown function as #NAME?', () => {
    const s = sheet({ A1: '=NOPE(1)' });
    expect(String(s.get('A1'))).toBe('#NAME?');
  });

  it('rejects the wrong number of arguments', () => {
    const s = sheet({ A1: '=ROUND()' });
    expect(isError(s.get('A1'))).toBe(true);
  });

  it('avoids floating point noise on display', () => {
    const s = sheet({ A1: '=0.1+0.2' });
    expect(s.getDisplay('A1')).toBe('0.3');
  });
});

describe('references and ranges', () => {
  it('reads a single cell', () => {
    const s = sheet({ A1: '42', B1: '=A1*2' });
    expect(s.get('B1')).toBe(84);
  });

  it('treats absolute and relative addresses as the same cell', () => {
    const s = sheet({ A1: '5', B1: '=$A$1+A1' });
    expect(s.get('B1')).toBe(10);
  });

  it('sums a range', () => {
    const s = sheet({ A1: '1', A2: '2', A3: '3', B1: '=SUM(A1:A3)' });
    expect(s.get('B1')).toBe(6);
  });

  it('normalises a reversed range', () => {
    const s = sheet({ A1: '1', A2: '2', A3: '3', B1: '=SUM(A3:A1)' });
    expect(s.get('B1')).toBe(6);
  });

  it('ignores text inside a summed range', () => {
    const s = sheet({ A1: '1', A2: 'hello', A3: '3', B1: '=SUM(A1:A3)' });
    expect(s.get('B1')).toBe(4);
  });

  it('refuses a range where one value is needed', () => {
    const s = sheet({ A1: '1', A2: '2', B1: '=A1:A2+1' });
    expect(String(s.get('B1'))).toBe('#VALUE!');
  });
});

describe('cycles', () => {
  it('flags a direct self-reference', () => {
    const s = sheet({ A1: '=A1+1' });
    expect(String(s.get('A1'))).toBe('#CYCLE!');
  });

  it('flags a two-cell cycle', () => {
    const s = sheet({ A1: '=B1', B1: '=A1' });
    expect(String(s.get('A1'))).toBe('#CYCLE!');
    expect(String(s.get('B1'))).toBe('#CYCLE!');
  });

  it('flags a three-cell cycle', () => {
    const s = sheet({ A1: '=B1', B1: '=C1', C1: '=A1' });
    for (const c of ['A1', 'B1', 'C1']) {
      expect(String(s.get(c))).toBe('#CYCLE!');
    }
  });

  it('recovers once the cycle is broken', () => {
    const s = sheet({ A1: '=B1', B1: '=A1' });
    expect(String(s.get('A1'))).toBe('#CYCLE!');
    s.set('B1', '10');
    expect(s.get('A1')).toBe(10);
    expect(s.get('B1')).toBe(10);
  });

  it('leaves unrelated cells alone', () => {
    const s = sheet({ A1: '=B1', B1: '=A1', D1: '7', E1: '=D1*2' });
    expect(s.get('E1')).toBe(14);
  });
});

describe('incremental recalculation', () => {
  it('recomputes only what the change reaches', () => {
    const s = new Sheet();
    s.setMany([
      ['A1', '1'],
      ['B1', '=A1+1'],
      ['C1', '=B1+1'],
      ['Z1', '999'],
      ['Z2', '=Z1+1'],
    ]);

    s.set('A1', '10');
    // A1's chain is three cells; Z1/Z2 must not be touched.
    expect(s.stats.evaluated).toBe(2); // B1 and C1 hold formulas
    expect(s.get('C1')).toBe(12);
  });

  it('evaluates a diamond dependency once per cell', () => {
    const s = new Sheet();
    s.setMany([
      ['A1', '1'],
      ['B1', '=A1*2'],
      ['C1', '=A1*3'],
      ['D1', '=B1+C1'],
    ]);
    s.set('A1', '2');
    expect(s.get('D1')).toBe(10);
    expect(s.stats.evaluated).toBe(3);
  });

  it('updates a long chain correctly', () => {
    const s = new Sheet();
    s.set('A1', '1');
    for (let i = 2; i <= 100; i++) {
      s.set(`A${i}`, `=A${i - 1}+1`);
    }
    expect(s.get('A100')).toBe(100);
    s.set('A1', '0');
    expect(s.get('A100')).toBe(99);
  });

  it('drops dependencies when a formula is replaced', () => {
    const s = sheet({ A1: '1', B1: '2', C1: '=A1' });
    expect(s.dependentsOf('A1')).toContain('0,0'.replace('0,0', s.snapshot('C1').key));
    s.set('C1', '=B1');
    expect(s.dependentsOf('A1')).toHaveLength(0);
    expect(s.dependentsOf('B1')).toHaveLength(1);
  });
});

describe('graph introspection', () => {
  it('reports precedents and dependents', () => {
    const s = sheet({ A1: '1', A2: '2', B1: '=A1+A2' });
    expect(s.precedentsOf('B1')).toHaveLength(2);
    expect(s.dependentsOf('A1')).toHaveLength(1);
  });

  it('reports everything downstream', () => {
    const s = sheet({ A1: '1', B1: '=A1', C1: '=B1', D1: '=C1' });
    expect(s.affectedBy('A1')).toHaveLength(3);
  });
});

describe('functions', () => {
  const cases: Array<[string, unknown]> = [
    ['=SUM(1,2,3)', 6],
    ['=AVERAGE(2,4,6)', 4],
    ['=MIN(5,2,8)', 2],
    ['=MAX(5,2,8)', 8],
    ['=MEDIAN(1,3,2)', 2],
    ['=MEDIAN(1,2,3,4)', 2.5],
    ['=ABS(-4)', 4],
    ['=SQRT(9)', 3],
    ['=SQRT(-1)', '#NUM!'],
    ['=ROUND(2.345,2)', 2.35],
    ['=ROUND(1.005,2)', 1.01],
    ['=ROUNDUP(1.1,0)', 2],
    ['=ROUNDDOWN(1.9,0)', 1],
    ['=MOD(-1,3)', 2],
    ['=POWER(2,10)', 1024],
    ['=INT(3.7)', 3],
    ['=SIGN(-3)', -1],
    ['=COUNT(1,"a",2)', 2],
    ['=COUNTA(1,"a",2)', 3],
    ['=IF(TRUE,"y","n")', 'y'],
    ['=IF(1>2,"y","n")', 'n'],
    ['=IFERROR(1/0,"safe")', 'safe'],
    ['=AND(TRUE,FALSE)', false],
    ['=OR(TRUE,FALSE)', true],
    ['=NOT(FALSE)', true],
    ['=ISERROR(1/0)', true],
    ['=ISNUMBER(1)', true],
    ['=CONCAT("a","b")', 'ab'],
    ['=LEN("hello")', 5],
    ['=UPPER("ab")', 'AB'],
    ['=LOWER("AB")', 'ab'],
    ['=TRIM("  a  b  ")', 'a b'],
    ['=LEFT("hello",2)', 'he'],
    ['=RIGHT("hello",2)', 'lo'],
    ['=MID("hello",2,3)', 'ell'],
    ['="a"&"b"', 'ab'],
    ['=1&2', '12'],
  ];

  for (const [formula, expected] of cases) {
    it(`${formula} is ${JSON.stringify(expected)}`, () => {
      const s = sheet({ A1: formula });
      const v = s.get('A1');
      expect(isError(v) ? String(v) : v).toEqual(expected);
    });
  }

  it('looks a value up with VLOOKUP', () => {
    const s = sheet({
      A1: 'apple', B1: '10',
      A2: 'pear', B2: '20',
      D1: '=VLOOKUP("pear",A1:B2,2)',
      D2: '=VLOOKUP("plum",A1:B2,2)',
    });
    expect(s.get('D1')).toBe(20);
    expect(String(s.get('D2'))).toBe('#N/A');
  });

  it('indexes and matches', () => {
    const s = sheet({
      A1: '5', A2: '6', A3: '7',
      C1: '=INDEX(A1:A3,2)',
      C2: '=MATCH(7,A1:A3)',
    });
    expect(s.get('C1')).toBe(6);
    expect(s.get('C2')).toBe(3);
  });

  it('counts and sums conditionally', () => {
    const s = sheet({
      A1: '1', A2: '5', A3: '10',
      C1: '=COUNTIF(A1:A3,">4")',
      C2: '=SUMIF(A1:A3,">4")',
    });
    expect(s.get('C1')).toBe(2);
    expect(s.get('C2')).toBe(15);
  });
});

describe('literal coercion', () => {
  it('reads numbers, booleans and text', () => {
    const s = sheet({ A1: '42', A2: 'TRUE', A3: 'hello', A4: '15%', A5: '1e3' });
    expect(s.get('A1')).toBe(42);
    expect(s.get('A2')).toBe(true);
    expect(s.get('A3')).toBe('hello');
    expect(s.get('A4')).toBe(0.15);
    expect(s.get('A5')).toBe(1000);
  });

  it('leaves a leading-zero code as text', () => {
    const s = sheet({ A1: '007abc' });
    expect(s.get('A1')).toBe('007abc');
  });

  it('clears a cell when set to empty', () => {
    const s = sheet({ A1: '1', B1: '=A1+1' });
    s.set('A1', '');
    expect(s.get('A1')).toBe(null);
    expect(s.get('B1')).toBe(1);
  });
});

describe('malformed input', () => {
  const bad = ['=1+', '=(1', '=SUM(', '=*2', '=1++', '=A1:', '="unclosed'];
  for (const formula of bad) {
    it(`survives ${formula}`, () => {
      const s = new Sheet();
      expect(() => s.set('A1', formula)).not.toThrow();
      expect(isError(s.get('A1'))).toBe(true);
    });
  }

  it('rejects an address that is not a reference', () => {
    const s = new Sheet();
    expect(() => s.set('not-a-cell', '1')).toThrow(RangeError);
  });
});

describe('FormulaError', () => {
  it('renders as its code', () => {
    expect(String(FormulaError.div0())).toBe('#DIV/0!');
    expect(`${FormulaError.na()}`).toBe('#N/A');
  });

  it('carries a reason', () => {
    expect(FormulaError.value('because').reason).toBe('because');
  });
});
