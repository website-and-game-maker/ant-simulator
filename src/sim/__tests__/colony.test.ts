import { describe, expect, it } from 'vitest';
import { Colony } from '../colony';
import { randomGenetics } from '../genetics';
import { DEFAULT_SPECIES } from '../species';
import { mulberry32 } from '../rng';

function foundSoloColony() {
  const rng = mulberry32(123);
  const queenGenetics = randomGenetics(rng, 18);
  const droneGenetics = randomGenetics(rng, 18);
  const colony = Colony.foundNew({
    nestPos: { x: 0, y: 0 },
    colorHue: 18,
    name: 'Testburrow',
    queenGenetics,
    droneGenetics,
    generation: 1,
    parentColonyId: 1,
    founded: 0,
    queenMaxAge: DEFAULT_SPECIES.baseLifespanTicks.queen,
  });
  return { colony, rng };
}

describe('claustral colony founding', () => {
  it('a solo-founded queen survives to raise her first worker', () => {
    // Regression test for a real bug: a nuptial-flight queen used to start
    // with zero workers and pay her own "fed by foragers" upkeep out of a
    // small starting food reserve, so she starved to death well before her
    // first larva could mature — autonomous colony expansion always died out.
    const { colony, rng } = foundSoloColony();
    const dt = 0.5;
    let spawnedWorker = false;
    for (let t = 0; t < 240 && colony.queenAlive && !spawnedWorker; t += dt) {
      const { spawn } = colony.tick(dt, rng, DEFAULT_SPECIES, t);
      if (spawn.length > 0) spawnedWorker = true;
    }
    expect(colony.queenAlive).toBe(true);
    expect(spawnedWorker).toBe(true);
  });

  it('an established queen (already has workers) still depends on the food store', () => {
    const { colony, rng } = foundSoloColony();
    colony.notifyBirth('worker', colony.averageGenetics() ?? randomGenetics(rng, 18));
    // Drain the food store to nothing and starve out any safety margin.
    for (let i = 0; i < 500 && colony.queenAlive; i++) {
      colony.tick(1, rng, DEFAULT_SPECIES, i);
    }
    // With no food and an established (non-claustral) queen, she should
    // eventually run out of energy — claustral protection must not leak
    // into a colony that has already left the founding phase.
    expect(colony.queenAlive).toBe(false);
  });
});
