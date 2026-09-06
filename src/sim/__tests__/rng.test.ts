import { describe, expect, it } from 'vitest';
import { chance, clamp, gaussian, mulberry32, pick, range, rangeInt } from '../rng';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1)', () => {
    const rng = mulberry32(1234);
    for (let i = 0; i < 500; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    expect(a).not.toEqual(b);
  });
});

describe('helpers', () => {
  it('clamp bounds a value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('range stays within [min, max)', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const v = range(rng, 2, 5);
      expect(v).toBeGreaterThanOrEqual(2);
      expect(v).toBeLessThan(5);
    }
  });

  it('rangeInt stays within [min, max]', () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 200; i++) {
      const v = rangeInt(rng, 1, 3);
      expect([1, 2, 3]).toContain(v);
    }
  });

  it('chance(rng, 0) is always false and chance(rng, 1) is always true', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 50; i++) {
      expect(chance(rng, 0)).toBe(false);
      expect(chance(rng, 1)).toBe(true);
    }
  });

  it('pick returns an element from the array', () => {
    const rng = mulberry32(5);
    const arr = ['a', 'b', 'c'];
    for (let i = 0; i < 50; i++) {
      expect(arr).toContain(pick(rng, arr));
    }
  });

  it('gaussian centers roughly on the mean over many samples', () => {
    const rng = mulberry32(11);
    let sum = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) sum += gaussian(rng, 10, 1);
    expect(sum / n).toBeGreaterThan(9.7);
    expect(sum / n).toBeLessThan(10.3);
  });
});
