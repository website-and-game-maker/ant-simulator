import { describe, expect, it } from 'vitest';
import { PheromoneField } from '../pheromones';

describe('PheromoneField', () => {
  it('reads back a deposit at the same point', () => {
    const field = new PheromoneField(200, 200, 10, 0.5, false);
    field.deposit({ x: 50, y: 50 }, 100, 0);
    expect(field.sampleAt({ x: 50, y: 50 })).toBeGreaterThan(0);
    expect(field.sampleAt({ x: 190, y: 190 })).toBe(0);
  });

  it('evaporates over time', () => {
    const field = new PheromoneField(200, 200, 10, 2, false);
    field.deposit({ x: 50, y: 50 }, 100, 0);
    const before = field.sampleAt({ x: 50, y: 50 });
    field.step(1);
    const after = field.sampleAt({ x: 50, y: 50 });
    expect(after).toBeLessThan(before);
  });

  it('reads foreign-colony trails as much fainter than the owner does', () => {
    const field = new PheromoneField(200, 200, 10, 0.5, false);
    field.deposit({ x: 50, y: 50 }, 100, 0);
    const owner = field.sampleAt({ x: 50, y: 50 }, 0);
    const foreign = field.sampleAt({ x: 50, y: 50 }, 1);
    expect(foreign).toBeLessThan(owner);
  });

  it('bestDirection points roughly toward a strong deposit', () => {
    const field = new PheromoneField(400, 400, 5, 0.1, false);
    // Lay a little trail straight to the east of the origin.
    for (let x = 0; x < 100; x += 5) field.deposit({ x, y: 200 }, 200, 0);
    const { heading, strength } = field.bestDirection({ x: 0, y: 200 }, 0, 0, 20);
    expect(strength).toBeGreaterThan(0);
    expect(Math.cos(heading)).toBeGreaterThan(0); // points mostly eastward
  });

  it('out-of-bounds samples return 0 instead of throwing', () => {
    const field = new PheromoneField(100, 100, 10, 0.5, false);
    expect(() => field.sampleAt({ x: -50, y: -50 })).not.toThrow();
    expect(field.sampleAt({ x: -50, y: -50 })).toBe(0);
  });
});
