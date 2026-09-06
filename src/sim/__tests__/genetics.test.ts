import { describe, expect, it } from 'vitest';
import { averageGenetics, inheritGenetics, randomGenetics } from '../genetics';
import { mulberry32 } from '../rng';

describe('randomGenetics', () => {
  it('produces traits within their designed ranges', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 200; i++) {
      const g = randomGenetics(rng, 18);
      expect(g.speed).toBeGreaterThanOrEqual(0.7);
      expect(g.speed).toBeLessThanOrEqual(1.35);
      expect(g.aggression).toBeGreaterThanOrEqual(0.05);
      expect(g.aggression).toBeLessThanOrEqual(0.95);
      expect(g.hue).toBeGreaterThanOrEqual(0);
      expect(g.hue).toBeLessThan(360);
    }
  });
});

describe('inheritGenetics', () => {
  it('blends two parents and stays within valid trait ranges', () => {
    const rng = mulberry32(2);
    const mother = randomGenetics(rng, 18);
    const father = randomGenetics(rng, 18);
    for (let i = 0; i < 200; i++) {
      const child = inheritGenetics(mother, father, rng);
      expect(child.speed).toBeGreaterThanOrEqual(0.7);
      expect(child.speed).toBeLessThanOrEqual(1.35);
      expect(child.lifespan).toBeGreaterThanOrEqual(0.75);
      expect(child.lifespan).toBeLessThanOrEqual(1.3);
    }
  });

  it('a colony always draws from the same two parents (queen mates once)', () => {
    // This is really documentation of the intended usage: callers pass the
    // same `queenGenetics`/`droneGenetics` pair for every egg a colony ever
    // lays, so every worker in a colony is a full/half sibling of every other.
    const rng = mulberry32(3);
    const queen = randomGenetics(rng, 18);
    const drone = randomGenetics(rng, 18);
    const workerA = inheritGenetics(queen, drone, rng);
    const workerB = inheritGenetics(queen, drone, rng);
    // Siblings should be closer to each other on average than two unrelated
    // random ants — a loose sanity check, not a precise genetics model.
    const siblingDelta = Math.abs(workerA.speed - workerB.speed);
    expect(siblingDelta).toBeLessThan(0.6);
  });
});

describe('averageGenetics', () => {
  it('returns null for an empty list', () => {
    expect(averageGenetics([])).toBeNull();
  });

  it('averages numeric traits and circularly averages hue', () => {
    const a = { speed: 1, strength: 1, senseRadius: 1, lifespan: 1, aggression: 0.2, industriousness: 0.5, hue: 350 };
    const b = { speed: 1.2, strength: 0.8, senseRadius: 1, lifespan: 1, aggression: 0.4, industriousness: 0.5, hue: 10 };
    const avg = averageGenetics([a, b]);
    expect(avg).not.toBeNull();
    expect(avg!.speed).toBeCloseTo(1.1, 5);
    // 350 and 10 degrees are 20 degrees apart wrapping through 0 — the
    // circular mean should land at 0/360, not the naive arithmetic mean (180).
    const hue = avg!.hue;
    const distanceFromZero = Math.min(hue, 360 - hue);
    expect(distanceFromZero).toBeLessThan(1);
  });
});
