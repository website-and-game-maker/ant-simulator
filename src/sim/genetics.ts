import type { Genetics } from './types';
import { chance, clamp, gaussian, type RNG } from './rng';

const TRAIT_KEYS = ['speed', 'strength', 'senseRadius', 'lifespan', 'aggression', 'industriousness'] as const;
type TraitKey = (typeof TRAIT_KEYS)[number];

const TRAIT_RANGE: Record<TraitKey, [number, number]> = {
  speed: [0.7, 1.35],
  strength: [0.7, 1.4],
  senseRadius: [0.7, 1.3],
  lifespan: [0.75, 1.3],
  aggression: [0.05, 0.95],
  industriousness: [0.3, 1],
};

export function randomGenetics(rng: RNG, baseHue: number): Genetics {
  return {
    speed: rangeMid(rng, TRAIT_RANGE.speed),
    strength: rangeMid(rng, TRAIT_RANGE.strength),
    senseRadius: rangeMid(rng, TRAIT_RANGE.senseRadius),
    lifespan: rangeMid(rng, TRAIT_RANGE.lifespan),
    aggression: rangeMid(rng, TRAIT_RANGE.aggression),
    industriousness: rangeMid(rng, TRAIT_RANGE.industriousness),
    hue: (baseHue + gaussian(rng, 0, 6) + 360) % 360,
  };
}

function rangeMid(rng: RNG, [lo, hi]: [number, number]): number {
  // Bias toward the middle of the range (most individuals are "average"),
  // via a mini gaussian centered at the midpoint.
  const mid = (lo + hi) / 2;
  const spread = (hi - lo) / 4;
  return clamp(gaussian(rng, mid, spread), lo, hi);
}

/**
 * Real ant colonies are haplodiploid and the queen mates once, in her single
 * nuptial flight, then stores that sperm for the rest of her life (potentially
 * a decade-plus). Every worker she ever produces is a genetic mix of *her*
 * genetics and that *one* stored mate's genetics — not a fresh random pair
 * each time. So a colony's `queenGenetics` + `droneGenetics` are fixed once
 * founded, and every egg draws from that same pair with mutation.
 *
 * Caste itself is epigenetic (larval nutrition), not decided here — see
 * colony.ts for how a larva becomes worker/soldier/queen.
 */
export function inheritGenetics(
  mother: Genetics,
  father: Genetics,
  rng: RNG,
  mutationRate = 0.06,
): Genetics {
  const child: Partial<Genetics> = {};
  for (const key of TRAIT_KEYS) {
    const blend = (mother[key] + father[key]) / 2;
    const mutated = chance(rng, mutationRate)
      ? blend + gaussian(rng, 0, (TRAIT_RANGE[key][1] - TRAIT_RANGE[key][0]) * 0.15)
      : blend + gaussian(rng, 0, (TRAIT_RANGE[key][1] - TRAIT_RANGE[key][0]) * 0.03);
    child[key] = clamp(mutated, TRAIT_RANGE[key][0], TRAIT_RANGE[key][1]);
  }
  const hueBlend = chance(rng, 0.5) ? mother.hue : father.hue;
  child.hue = (hueBlend + gaussian(rng, 0, 4) + 360) % 360;
  return child as Genetics;
}

export function averageGenetics(list: Genetics[]): Genetics | null {
  if (list.length === 0) return null;
  const sum: Genetics = { speed: 0, strength: 0, senseRadius: 0, lifespan: 0, aggression: 0, industriousness: 0, hue: 0 };
  let sinHue = 0;
  let cosHue = 0;
  for (const g of list) {
    sum.speed += g.speed;
    sum.strength += g.strength;
    sum.senseRadius += g.senseRadius;
    sum.lifespan += g.lifespan;
    sum.aggression += g.aggression;
    sum.industriousness += g.industriousness;
    const rad = (g.hue * Math.PI) / 180;
    sinHue += Math.sin(rad);
    cosHue += Math.cos(rad);
  }
  const n = list.length;
  const hue = (Math.atan2(sinHue / n, cosHue / n) * 180) / Math.PI;
  return {
    speed: sum.speed / n,
    strength: sum.strength / n,
    senseRadius: sum.senseRadius / n,
    lifespan: sum.lifespan / n,
    aggression: sum.aggression / n,
    industriousness: sum.industriousness / n,
    hue: (hue + 360) % 360,
  };
}
