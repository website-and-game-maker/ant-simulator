import { describe, expect, it } from 'vitest';
import { SpatialHash } from '../spatialHash';

interface Dot {
  id: number;
  pos: { x: number; y: number };
}

describe('SpatialHash', () => {
  it('finds items within radius and excludes far ones', () => {
    const hash = new SpatialHash<Dot>(20, (d) => d.pos);
    const dots: Dot[] = [
      { id: 1, pos: { x: 0, y: 0 } },
      { id: 2, pos: { x: 5, y: 5 } },
      { id: 3, pos: { x: 500, y: 500 } },
    ];
    hash.rebuild(dots);
    const near = hash.queryNear({ x: 0, y: 0 }, 15).map((d) => d.id);
    expect(near).toContain(1);
    expect(near).toContain(2);
    expect(near).not.toContain(3);
  });

  it('rebuild clears stale entries', () => {
    const hash = new SpatialHash<Dot>(20, (d) => d.pos);
    hash.rebuild([{ id: 1, pos: { x: 0, y: 0 } }]);
    expect(hash.queryNear({ x: 0, y: 0 }, 5)).toHaveLength(1);
    hash.rebuild([]);
    expect(hash.queryNear({ x: 0, y: 0 }, 5)).toHaveLength(0);
  });

  it('forEachNear visits every match without duplicates', () => {
    const hash = new SpatialHash<Dot>(10, (d) => d.pos);
    const dots: Dot[] = Array.from({ length: 30 }, (_, i) => ({ id: i, pos: { x: (i % 6) * 8, y: Math.floor(i / 6) * 8 } }));
    hash.rebuild(dots);
    const seen = new Set<number>();
    hash.forEachNear({ x: 20, y: 20 }, 100, (d) => seen.add(d.id));
    expect(seen.size).toBe(dots.length);
  });
});
