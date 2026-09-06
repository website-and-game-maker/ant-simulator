import type { Vec2 } from './vec2';

/**
 * Uniform grid spatial hash for fast "who's near me" queries.
 *
 * Ants need to ask "what food/ants/predators are within radius R" every
 * tick. A naive O(n²) scan falls over at a few hundred ants; a grid makes
 * neighbor queries roughly O(1) amortized by only checking the handful of
 * cells that could possibly contain something within range.
 */
export class SpatialHash<T> {
  private cellSize: number;
  private buckets = new Map<number, T[]>();
  private posOf: (item: T) => Vec2;

  constructor(cellSize: number, posOf: (item: T) => Vec2) {
    this.cellSize = cellSize;
    this.posOf = posOf;
  }

  private keyFor(cx: number, cy: number): number {
    // Pack two 20-bit-ish signed coords into one number key. Good enough for
    // world sizes we use (worlds are a few thousand units wide).
    return (cx + 1 << 20) * 100000 + (cy + 1);
  }

  clear() {
    this.buckets.clear();
  }

  insert(item: T) {
    const p = this.posOf(item);
    const cx = Math.floor(p.x / this.cellSize);
    const cy = Math.floor(p.y / this.cellSize);
    const key = this.keyFor(cx, cy);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    bucket.push(item);
  }

  rebuild(items: Iterable<T>) {
    this.clear();
    for (const item of items) this.insert(item);
  }

  /** Visit every item whose cell is within `radius` of `pos` (radius search is
   * approximate: it's cell-conservative, caller should re-check exact distance). */
  forEachNear(pos: Vec2, radius: number, fn: (item: T) => void) {
    const minCx = Math.floor((pos.x - radius) / this.cellSize);
    const maxCx = Math.floor((pos.x + radius) / this.cellSize);
    const minCy = Math.floor((pos.y - radius) / this.cellSize);
    const maxCy = Math.floor((pos.y + radius) / this.cellSize);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.buckets.get(this.keyFor(cx, cy));
        if (!bucket) continue;
        for (const item of bucket) fn(item);
      }
    }
  }

  queryNear(pos: Vec2, radius: number): T[] {
    const out: T[] = [];
    this.forEachNear(pos, radius, (item) => out.push(item));
    return out;
  }
}
