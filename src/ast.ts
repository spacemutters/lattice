import type { CellRef, RangeRef } from './refs.js';

export type BinaryOperator =
  | '+'
  | '-'
  | '*'
  | '/'
  | '^'
  | '&'
  | '='
  | '<>'
  | '<'
  | '>'
  | '<='
  | '>=';

export type UnaryOperator = '-' | '+';

export interface NumberLiteral {
  readonly kind: 'number';
  readonly value: number;
}

export interface StringLiteral {
  readonly kind: 'string';
  readonly value: string;
}

export interface BooleanLiteral {
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface ReferenceNode {
  readonly kind: 'ref';
  readonly ref: CellRef;
}

export interface RangeNode {
  readonly kind: 'range';
  readonly range: RangeRef;
}

export interface UnaryNode {
  readonly kind: 'unary';
  readonly op: UnaryOperator;
  readonly operand: Node;
}

export interface BinaryNode {
  readonly kind: 'binary';
  readonly op: BinaryOperator;
  readonly left: Node;
  readonly right: Node;
}

export interface PercentNode {
  readonly kind: 'percent';
  readonly operand: Node;
}

export interface CallNode {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly Node[];
}

export type Node =
  | NumberLiteral
  | StringLiteral
  | BooleanLiteral
  | ReferenceNode
  | RangeNode
  | UnaryNode
  | BinaryNode
  | PercentNode
  | CallNode;

/** Walk every node in the tree, parents before children. */
export function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  switch (node.kind) {
    case 'unary':
      walk(node.operand, visit);
      break;
    case 'percent':
      walk(node.operand, visit);
      break;
    case 'binary':
      walk(node.left, visit);
      walk(node.right, visit);
      break;
    case 'call':
      for (const arg of node.args) walk(arg, visit);
      break;
    default:
      break;
  }
}
