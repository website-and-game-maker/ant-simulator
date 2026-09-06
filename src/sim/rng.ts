/**
 * Deterministic PRNG utilities.
 *
 * The whole simulation is driven by a single seeded generator so a run is
 * reproducible from its seed. We use mulberry32: tiny, fast, and good enough
 * statistical quality for a simulation (not cryptography).
 */

export type RNG = () => number;

export function mulberry32(seed: number): RNG {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStringToSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform float in [min, max). */
export function range(rng: RNG, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Uniform integer in [min, max]. */
export function rangeInt(rng: RNG, min: number, max: number): number {
  return Math.floor(range(rng, min, max + 1));
}

/** true with the given probability (0..1). */
export function chance(rng: RNG, probability: number): boolean {
  return rng() < probability;
}

/** Pick a random element from an array. */
export function pick<T>(rng: RNG, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** Approximately-normal random value via sum of uniforms (Irwin-Hall/CLT trick). */
export function gaussian(rng: RNG, mean = 0, stdDev = 1): number {
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += rng();
  return mean + (sum - 3) * stdDev;
}

/** Clamp a value between lo and hi. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
