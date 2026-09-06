import type { RNG } from './rng';

/**
 * Tiny value-noise generator (no external deps). Not as smooth as Perlin/
 * Simplex, but for painting biome patches and food density it's indistinguishable
 * once combined at a couple of octaves.
 */
export class ValueNoise2D {
  private perm: Uint8Array;

  constructor(rng: RNG) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private hash(x: number, y: number): number {
    return this.perm[(this.perm[x & 255] + y) & 255] / 255;
  }

  private static fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  /** Single-octave value noise in roughly [0, 1]. */
  noise(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const xf = x - x0;
    const yf = y - y0;
    const u = ValueNoise2D.fade(xf);
    const v = ValueNoise2D.fade(yf);

    const n00 = this.hash(x0, y0);
    const n10 = this.hash(x0 + 1, y0);
    const n01 = this.hash(x0, y0 + 1);
    const n11 = this.hash(x0 + 1, y0 + 1);

    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return nx0 + v * (nx1 - nx0);
  }

  /** Fractal Brownian motion: several octaves summed for richer detail. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amplitude = 0.5;
    let frequency = 1;
    let sum = 0;
    let maxAmp = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(x * frequency, y * frequency) * amplitude;
      maxAmp += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return sum / maxAmp;
  }
}
