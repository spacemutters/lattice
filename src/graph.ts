/**
 * The dependency graph.
 *
 * Two adjacency maps are kept: `precedents` (what a cell reads) and
 * `dependents` (who reads a cell). The second one is what makes recalculation
 * incremental — after a cell changes, the set of cells that could possibly be
 * affected is exactly its transitive dependents, and everything else can be
 * left alone.
 */

export class DependencyGraph {
  /** cell -> the cells it reads */
  private readonly precedents = new Map<string, Set<string>>();
  /** cell -> the cells that read it */
  private readonly dependents = new Map<string, Set<string>>();

  /** Replace everything `cell` depends on. */
  setPrecedents(cell: string, deps: Iterable<string>): void {
    this.clearPrecedents(cell);
    const set = new Set(deps);
    // A self-edge is kept on purpose. Its in-degree never reaches zero, so
    // Kahn's algorithm leaves the cell unordered and reports it as cyclic,
    // which is exactly the behaviour `=A1+1` should have.
    if (set.size === 0) return;

    this.precedents.set(cell, set);
    for (const dep of set) {
      let back = this.dependents.get(dep);
      if (!back) {
        back = new Set();
        this.dependents.set(dep, back);
      }
      back.add(cell);
    }
  }

  clearPrecedents(cell: string): void {
    const old = this.precedents.get(cell);
    if (!old) return;
    for (const dep of old) {
      const back = this.dependents.get(dep);
      if (!back) continue;
      back.delete(cell);
      if (back.size === 0) this.dependents.delete(dep);
    }
    this.precedents.delete(cell);
  }

  getPrecedents(cell: string): ReadonlySet<string> {
    return this.precedents.get(cell) ?? EMPTY;
  }

  getDependents(cell: string): ReadonlySet<string> {
    return this.dependents.get(cell) ?? EMPTY;
  }

  /**
   * Every cell reachable downstream of `seeds`, including the seeds themselves.
   * Breadth-first, so each cell is visited once no matter how many paths reach it.
   */
  affectedBy(seeds: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];

    for (const s of seeds) {
      if (!seen.has(s)) {
        seen.add(s);
        queue.push(s);
      }
    }

    for (let i = 0; i < queue.length; i++) {
      const cell = queue[i]!;
      for (const dep of this.getDependents(cell)) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        queue.push(dep);
      }
    }

    return seen;
  }

  /**
   * Order `subset` so every cell comes after the cells it reads.
   *
   * Kahn's algorithm over the induced subgraph. Anything still holding an
   * unsatisfied edge when the queue empties is part of a cycle, or downstream
   * of one, and is returned separately rather than ordered.
   */
  topologicalOrder(subset: ReadonlySet<string>): { order: string[]; cyclic: Set<string> } {
    const indegree = new Map<string, number>();

    for (const cell of subset) {
      let n = 0;
      for (const dep of this.getPrecedents(cell)) {
        if (subset.has(dep)) n++;
      }
      indegree.set(cell, n);
    }

    const queue: string[] = [];
    for (const [cell, n] of indegree) {
      if (n === 0) queue.push(cell);
    }

    const order: string[] = [];
    for (let i = 0; i < queue.length; i++) {
      const cell = queue[i]!;
      order.push(cell);
      for (const dependent of this.getDependents(cell)) {
        if (!subset.has(dependent)) continue;
        const n = indegree.get(dependent);
        if (n === undefined) continue;
        const left = n - 1;
        indegree.set(dependent, left);
        if (left === 0) queue.push(dependent);
      }
    }

    const cyclic = new Set<string>();
    if (order.length !== subset.size) {
      const ordered = new Set(order);
      for (const cell of subset) {
        if (!ordered.has(cell)) cyclic.add(cell);
      }
    }

    return { order, cyclic };
  }

  /** Does `cell` reach itself through its precedents? */
  isInCycle(cell: string): boolean {
    const stack = [...this.getPrecedents(cell)];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === cell) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const p of this.getPrecedents(current)) stack.push(p);
    }
    return false;
  }

  clear(): void {
    this.precedents.clear();
    this.dependents.clear();
  }

  get size(): number {
    return this.precedents.size;
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>();
