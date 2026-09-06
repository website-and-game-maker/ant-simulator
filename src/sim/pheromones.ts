import type { PheromoneCell } from './types';
import type { Vec2 } from './vec2';
import { clamp } from './rng';

/**
 * A single chemical-signal channel laid over the world as a coarse grid.
 *
 * Real ants navigate largely by smell: a forager that finds food walks home
 * laying a trail; every ant that later crosses that trail is more likely to
 * follow it toward the food, reinforcing it further (positive feedback —
 * this is literally the mechanism behind Ant Colony Optimization algorithms).
 * Trails also evaporate, so paths to exhausted food fade out and the colony
 * "forgets" bad routes. That's the whole model here, just discretized onto
 * a grid instead of continuous diffusion PDEs.
 *
 * We also store which colony "owns" each cell's strongest deposit (a cheap
 * proxy for colony-specific chemical signatures), so ants mostly follow their
 * own colony's trails and treat a foreign trail as far weaker/irrelevant.
 */
export class PheromoneField {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  private intensity: Float32Array;
  private owner: Int16Array;
  private scratch: Float32Array;
  private evaporationPerSecond: number;
  private diffusionEnabled: boolean;

  constructor(
    worldWidth: number,
    worldHeight: number,
    cellSize: number,
    evaporationPerSecond: number,
    diffusionEnabled: boolean,
  ) {
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(worldWidth / cellSize));
    this.rows = Math.max(1, Math.ceil(worldHeight / cellSize));
    this.intensity = new Float32Array(this.cols * this.rows);
    this.owner = new Int16Array(this.cols * this.rows).fill(-1);
    this.scratch = new Float32Array(this.cols * this.rows);
    this.evaporationPerSecond = evaporationPerSecond;
    this.diffusionEnabled = diffusionEnabled;
  }

  private idx(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  private clampCell(v: number, max: number): number {
    return v < 0 ? 0 : v >= max ? max - 1 : v;
  }

  deposit(pos: Vec2, amount: number, colonyId: number) {
    const cx = this.clampCell(Math.floor(pos.x / this.cellSize), this.cols);
    const cy = this.clampCell(Math.floor(pos.y / this.cellSize), this.rows);
    const i = this.idx(cx, cy);
    const prev = this.intensity[i];
    const next = prev + amount;
    this.intensity[i] = next > 255 ? 255 : next;
    // Ownership goes to whichever colony most recently dominated this cell.
    if (amount > 0 && (this.owner[i] === -1 || amount >= prev * 0.5)) {
      this.owner[i] = colonyId;
    }
  }

  /** Raw intensity at a world position (0 if out of bounds). */
  sampleAt(pos: Vec2, colonyId?: number): number {
    const cx = Math.floor(pos.x / this.cellSize);
    const cy = Math.floor(pos.y / this.cellSize);
    if (cx < 0 || cy < 0 || cx >= this.cols || cy >= this.rows) return 0;
    const i = this.idx(cx, cy);
    const raw = this.intensity[i];
    if (colonyId === undefined) return raw;
    // Foreign trails read as much fainter — ants mostly smell their own colony.
    return this.owner[i] === colonyId ? raw : raw * 0.12;
  }

  /**
   * Sample a small forward-facing fan of rays and return the heading with
   * the strongest trail, plus its strength. Used by ants to decide which
   * way to turn to follow a trail without doing full gradient calculus.
   */
  bestDirection(
    pos: Vec2,
    heading: number,
    colonyId: number,
    sampleDist: number,
    coneHalfAngle = Math.PI / 2.2,
    rays = 5,
  ): { heading: number; strength: number } {
    let bestHeading = heading;
    let bestStrength = -1;
    for (let i = 0; i < rays; i++) {
      const t = rays === 1 ? 0 : (i / (rays - 1)) * 2 - 1; // -1..1
      const angle = heading + t * coneHalfAngle;
      const sample = {
        x: pos.x + Math.cos(angle) * sampleDist,
        y: pos.y + Math.sin(angle) * sampleDist,
      };
      const strength = this.sampleAt(sample, colonyId);
      if (strength > bestStrength) {
        bestStrength = strength;
        bestHeading = angle;
      }
    }
    return { heading: bestHeading, strength: Math.max(0, bestStrength) };
  }

  /** Evaporate (and optionally diffuse) the whole field. Call once per sim step. */
  step(dt: number, extraEvaporationMultiplier = 1) {
    const decay = Math.exp(-this.evaporationPerSecond * extraEvaporationMultiplier * dt);
    const n = this.intensity.length;

    if (this.diffusionEnabled) {
      // Cheap 4-neighbor blur: each cell gives a small fraction to neighbors.
      // This makes trails read as soft glowing bands rather than a harsh grid.
      const blend = 0.12;
      const src = this.intensity;
      const dst = this.scratch;
      for (let y = 0; y < this.rows; y++) {
        const rowUp = y > 0 ? (y - 1) * this.cols : y * this.cols;
        const rowDown = y < this.rows - 1 ? (y + 1) * this.cols : y * this.cols;
        const row = y * this.cols;
        for (let x = 0; x < this.cols; x++) {
          const left = x > 0 ? x - 1 : x;
          const right = x < this.cols - 1 ? x + 1 : x;
          const center = src[row + x];
          const neighborAvg = (src[row + left] + src[row + right] + src[rowUp + x] + src[rowDown + x]) * 0.25;
          dst[row + x] = (center * (1 - blend) + neighborAvg * blend) * decay;
        }
      }
      this.scratch = this.intensity;
      this.intensity = dst;
    } else {
      for (let i = 0; i < n; i++) {
        const v = this.intensity[i] * decay;
        this.intensity[i] = v < 0.02 ? 0 : v;
      }
    }
  }

  /** For rendering: iterate non-trivial cells with their world rect + strength. */
  forEachCell(minStrength: number, fn: (x: number, y: number, size: number, strength01: number, colonyId: number) => void) {
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const i = this.idx(cx, cy);
        const v = this.intensity[i];
        if (v <= minStrength) continue;
        fn(cx * this.cellSize, cy * this.cellSize, this.cellSize, clamp(v / 120, 0, 1), this.owner[i]);
      }
    }
  }

  /** Same as `forEachCell` but collected into a plain array — handy for a
   * WorldSnapshot the renderer consumes without touching the engine directly. */
  snapshotCells(minStrength: number): PheromoneCell[] {
    const out: PheromoneCell[] = [];
    this.forEachCell(minStrength, (x, y, size, strength, colonyId) => out.push({ x, y, size, strength, colonyId }));
    return out;
  }
}
