import { describe, expect, it } from 'vitest';
import { Simulation } from '../simulation';

/** Drive `frames` frames of a steady 60fps at a given multiplier. */
function drive(speed: number, frames: number, seed = 4242) {
  const sim = new Simulation({ tier: 'medium', seed });
  sim.setSpeed(speed);
  for (let i = 0; i < frames; i++) sim.update(1 / 60);
  const stats = sim.getSnapshot().stats;
  return {
    simTime: stats.simTime,
    ants: stats.totalAnts,
    colonies: stats.totalColonies,
    load: sim.getStepLoad(),
    nominal: (frames / 60) * speed,
  };
}

describe('speed multipliers', () => {
  /**
   * The step size used to be `simDt / simSubsteps`, so raising the multiplier
   * raised the step with it: at 10x an ant advanced a sixth of a second per
   * step, far enough to stride over food and through rocks. "10x" was a
   * coarser, different simulation rather than the same one running faster.
   */
  it('delivers its nominal sim time up to 20x', () => {
    for (const speed of [1, 2, 5, 10, 20]) {
      const r = drive(speed, 300);
      expect(r.simTime).toBeGreaterThan(r.nominal * 0.97);
      expect(r.load.taken).toBe(r.load.requested);
    }
  }, 120000);

  /**
   * 50x is budget-limited on most machines — deliberately. The contract is
   * not "exactly 50x" but "substantially faster than 10x, and honest about
   * the shortfall", which is what `getStepLoad` is for.
   */
  it('runs much faster than 10x at 50x, and reports any shortfall', () => {
    const ten = drive(10, 300);
    const fifty = drive(50, 300);
    expect(fifty.simTime).toBeGreaterThan(ten.simTime * 2.5);
    if (fifty.load.taken < fifty.load.requested) {
      expect(fifty.simTime).toBeLessThan(fifty.nominal);
    }
  }, 120000);

  it('reaches a comparable colony state at 10x and 50x', () => {
    const slow = drive(10, 360);
    const fast = drive(50, 72); // same nominal sim time, different step counts
    expect(fast.colonies).toBe(slow.colonies);
    // Different step sizes draw differently from the RNG, so exact equality
    // isn't the bar — staying in the same population band is.
    expect(Math.abs(fast.ants - slow.ants)).toBeLessThanOrEqual(10);
  }, 120000);

  it('does not starve the world out at 50x', () => {
    // The real failure mode of an oversized step is foragers striding past
    // food until every colony starves. Survivors are the signal.
    const fast = drive(50, 600, 99);
    expect(fast.colonies).toBeGreaterThan(0);
    expect(fast.ants).toBeGreaterThan(0);
  }, 120000);

  it('takes no steps at all while paused', () => {
    const sim = new Simulation({ tier: 'medium', seed: 1 });
    sim.setSpeed(0);
    for (let i = 0; i < 60; i++) sim.update(1 / 60);
    expect(sim.getSnapshot().stats.simTime).toBe(0);
    expect(sim.getStepLoad()).toEqual({ taken: 0, requested: 0 });
  });
});
