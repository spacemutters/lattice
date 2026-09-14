/**
 * Pratt parser (precedence climbing).
 *
 * Each operator gets a binding power. A left-associative operator parses its
 * right side at `bp + 1` so an equal-power operator stops and binds left;
 * `^` is right-associative, so it recurses at `bp` and keeps binding right.
 * That single difference is the whole of associativity here.
 */

import type {
  BinaryOperator,
  CallNode,
  Node,
  UnaryOperator,
} from './ast.js';
import { tokenize, type Token } from './lexer.js';
import { normalizeRange, parseRef, type CellRef } from './refs.js';

export class ParseError extends Error {
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = 'ParseError';
    this.pos = pos;
  }
}

/** Excel's precedence, lowest binds loosest. */
const BINDING_POWER: Record<BinaryOperator, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '>': 1,
  '<=': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
};

const RIGHT_ASSOCIATIVE = new Set<BinaryOperator>(['^']);

/** Binds tighter than `^`, so `-2^2` is `-(2^2)` exactly as Excel computes it. */
const UNARY_POWER = 6;

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  private expect(type: Token['type'], what: string): Token {
    const tok = this.peek();
    if (tok.type !== type) {
      throw new ParseError(`expected ${what} but found "${tok.value || 'end of formula'}"`, tok.pos);
    }
    return this.next();
  }

  parse(): Node {
    const node = this.parseExpression(0);
    const tok = this.peek();
    if (tok.type !== 'eof') {
      throw new ParseError(`unexpected "${tok.value}"`, tok.pos);
    }
    return node;
  }

  private parseExpression(minPower: number): Node {
    let left = this.parseUnary();

    for (;;) {
      const tok = this.peek();
      if (tok.type !== 'operator') break;
      const op = tok.value as BinaryOperator;
      const power = BINDING_POWER[op];
      if (power === undefined || power < minPower) break;

      this.next();
      const nextMin = RIGHT_ASSOCIATIVE.has(op) ? power : power + 1;
      const right = this.parseExpression(nextMin);
      left = { kind: 'binary', op, left, right };
    }

    return left;
  }

  private parseUnary(): Node {
    const tok = this.peek();
    if (tok.type === 'operator' && (tok.value === '-' || tok.value === '+')) {
      this.next();
      const operand = this.parseExpression(UNARY_POWER);
      return { kind: 'unary', op: tok.value as UnaryOperator, operand };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let node = this.parsePrimary();
    while (this.peek().type === 'percent') {
      this.next();
      node = { kind: 'percent', operand: node };
    }
    return node;
  }

  private parsePrimary(): Node {
    const tok = this.next();

    switch (tok.type) {
      case 'number': {
        const value = Number(tok.value);
        if (Number.isNaN(value)) throw new ParseError(`bad number "${tok.value}"`, tok.pos);
        return { kind: 'number', value };
      }

      case 'string':
        return { kind: 'string', value: tok.value };

      case 'boolean':
        return { kind: 'boolean', value: tok.value === 'TRUE' };

      case 'ref': {
        const start = parseRef(tok.value);
        if (!start) throw new ParseError(`bad reference "${tok.value}"`, tok.pos);
        return this.maybeRange(start, tok.pos);
      }

      case 'lparen': {
        const inner = this.parseExpression(0);
        this.expect('rparen', '")"');
        return inner;
      }

      case 'identifier':
        return this.parseCall(tok);

      default:
        throw new ParseError(`unexpected "${tok.value || 'end of formula'}"`, tok.pos);
    }
  }

  /** After a reference, a `:` turns it into a range. */
  private maybeRange(start: CellRef, pos: number): Node {
    if (this.peek().type !== 'colon') {
      return { kind: 'ref', ref: start };
    }
    this.next();
    const endTok = this.peek();
    if (endTok.type !== 'ref') {
      throw new ParseError('a range needs a cell on both sides of ":"', endTok.pos);
    }
    this.next();
    const end = parseRef(endTok.value);
    if (!end) throw new ParseError(`bad reference "${endTok.value}"`, pos);
    return { kind: 'range', range: normalizeRange({ start, end }) };
  }

  private parseCall(nameTok: Token): CallNode {
    this.expect('lparen', `"(" after ${nameTok.value}`);
    const args: Node[] = [];

    if (this.peek().type === 'rparen') {
      this.next();
      return { kind: 'call', name: nameTok.value, args };
    }

    for (;;) {
      args.push(this.parseExpression(0));
      const tok = this.peek();
      if (tok.type === 'comma') {
        this.next();
        continue;
      }
      if (tok.type === 'rparen') {
        this.next();
        break;
      }
      throw new ParseError(`expected "," or ")" in ${nameTok.value}(...)`, tok.pos);
    }

    return { kind: 'call', name: nameTok.value, args };
  }
}

/**
 * Parse a formula body. The leading `=` is optional and stripped if present.
 */
export function parse(formula: string): Node {
  const body = formula.startsWith('=') ? formula.slice(1) : formula;
  if (body.trim() === '') {
    throw new ParseError('formula is empty', 0);
  }
  return new Parser(tokenize(body)).parse();
}
