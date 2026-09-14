/**
 * Tokenizer.
 *
 * Single pass, no regex backtracking on the hot path. The only genuinely
 * ambiguous character is `-`, which is unary or binary depending on what came
 * before it; the parser settles that, not the lexer.
 */

export type TokenType =
  | 'number'
  | 'string'
  | 'boolean'
  | 'identifier'
  | 'ref'
  | 'operator'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'colon'
  | 'percent'
  | 'eof';

export interface Token {
  readonly type: TokenType;
  readonly value: string;
  /** Byte offset in the source, so errors can point at the right character. */
  readonly pos: number;
}

export class LexError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = 'LexError';
    this.pos = pos;
  }
}

const OPERATOR_CHARS = new Set(['+', '-', '*', '/', '^', '&', '=', '<', '>']);

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isLetter(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z');
}

function isIdentStart(ch: string): boolean {
  return isLetter(ch) || ch === '_' || ch === '$';
}

function isIdentPart(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || ch === '_' || ch === '.' || ch === '$';
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Numbers: 12, 3.5, .5, 1e-3
    if (isDigit(ch) || (ch === '.' && isDigit(input[i + 1] ?? ''))) {
      const start = i;
      while (i < n && isDigit(input[i]!)) i++;
      if (input[i] === '.') {
        i++;
        while (i < n && isDigit(input[i]!)) i++;
      }
      if (input[i] === 'e' || input[i] === 'E') {
        const save = i;
        i++;
        if (input[i] === '+' || input[i] === '-') i++;
        if (i < n && isDigit(input[i]!)) {
          while (i < n && isDigit(input[i]!)) i++;
        } else {
          i = save; // `1e` with no exponent: the `e` is not ours
        }
      }
      tokens.push({ type: 'number', value: input.slice(start, i), pos: start });
      continue;
    }

    // Strings: "hello", with "" as an escaped quote
    if (ch === '"') {
      const start = i;
      i++;
      let out = '';
      let closed = false;
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        out += input[i];
        i++;
      }
      if (!closed) throw new LexError('unterminated string', start);
      tokens.push({ type: 'string', value: out, pos: start });
      continue;
    }

    // Identifiers, references, TRUE/FALSE
    if (isIdentStart(ch)) {
      const start = i;
      while (i < n && isIdentPart(input[i]!)) i++;
      const raw = input.slice(start, i);
      const upper = raw.toUpperCase();

      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'boolean', value: upper, pos: start });
        continue;
      }

      // A bare A1-shaped word is a reference unless a `(` makes it a call.
      if (/^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/.test(raw) && input[i] !== '(') {
        tokens.push({ type: 'ref', value: raw, pos: start });
        continue;
      }

      tokens.push({ type: 'identifier', value: upper, pos: start });
      continue;
    }

    if (ch === '(') {
      tokens.push({ type: 'lparen', value: ch, pos: i++ });
      continue;
    }
    if (ch === ')') {
      tokens.push({ type: 'rparen', value: ch, pos: i++ });
      continue;
    }
    if (ch === ',' || ch === ';') {
      tokens.push({ type: 'comma', value: ',', pos: i++ });
      continue;
    }
    if (ch === ':') {
      tokens.push({ type: 'colon', value: ch, pos: i++ });
      continue;
    }
    if (ch === '%') {
      tokens.push({ type: 'percent', value: ch, pos: i++ });
      continue;
    }

    if (OPERATOR_CHARS.has(ch)) {
      const start = i;
      // Two-character comparisons first, so `<=` never lexes as `<` then `=`.
      const two = input.slice(i, i + 2);
      if (two === '<=' || two === '>=' || two === '<>') {
        i += 2;
        tokens.push({ type: 'operator', value: two, pos: start });
        continue;
      }
      i++;
      tokens.push({ type: 'operator', value: ch, pos: start });
      continue;
    }

    throw new LexError(`unexpected character "${ch}"`, i);
  }

  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}
