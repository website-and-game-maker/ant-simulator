import type { BiomeType, FoodSource, FoodType, Obstacle } from './types';
import type { Vec2 } from './vec2';
import { dist } from './vec2';
import { ValueNoise2D } from './noise';
import { chance, pick, range, rangeInt, type RNG } from './rng';

const BIOME_CELL = 40;

/**
 * The physical world an ant crawls around in: a procedurally generated patch
 * of ground (grass/dirt/sand/rock/leaf-litter), scattered food, and small
 * obstacles ants have to steer around. Also owns the "wetness" field that
 * rain fills in and that dries back out — puddles are a real hazard, not
 * just decoration.
 */
export class Terrain {
  readonly width: number;
  readonly height: number;
  readonly cellSize = BIOME_CELL;
  private cols: number;
  private rows: number;
  private biome: Uint8Array;
  private wetness: Float32Array;
  private biomeNames: BiomeType[] = ['grass', 'dirt', 'sand', 'rock', 'puddle', 'leafLitter'];

  foods: FoodSource[] = [];
  obstacles: Obstacle[] = [];
  private nextFoodId = 1;

  constructor(width: number, height: number, rng: RNG) {
    this.width = width;
    this.height = height;
    this.cols = Math.ceil(width / BIOME_CELL);
    this.rows = Math.ceil(height / BIOME_CELL);
    this.biome = new Uint8Array(this.cols * this.rows);
    this.wetness = new Float32Array(this.cols * this.rows);

    const elevationNoise = new ValueNoise2D(rng);
    const moistureNoise = new ValueNoise2D(rng);
    const litterNoise = new ValueNoise2D(rng);

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const elevation = elevationNoise.fbm(x * 0.06, y * 0.06, 4);
        const moisture = moistureNoise.fbm(x * 0.05 + 100, y * 0.05 + 100, 3);
        const litter = litterNoise.fbm(x * 0.15 + 500, y * 0.15 + 500, 2);

        let biome: BiomeType;
        if (elevation > 0.72) biome = 'rock';
        else if (moisture < 0.32) biome = 'sand';
        else if (litter > 0.62) biome = 'leafLitter';
        else if (moisture > 0.55) biome = 'grass';
        else biome = 'dirt';

        this.biome[y * this.cols + x] = this.biomeNames.indexOf(biome);
      }
    }

    this.scatterObstacles(rng);
    this.scatterFood(rng, 46);
  }

  private cellIndex(pos: Vec2): number {
    const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(pos.x / BIOME_CELL)));
    const cy = Math.min(this.rows - 1, Math.max(0, Math.floor(pos.y / BIOME_CELL)));
    return cy * this.cols + cx;
  }

  biomeAt(pos: Vec2): BiomeType {
    return this.biomeNames[this.biome[this.cellIndex(pos)]];
  }

  /** Grid dimensions of the biome/wetness lattice, for renderers that want to
   * bake the terrain once instead of point-sampling it per pixel. */
  get gridCols(): number {
    return this.cols;
  }
  get gridRows(): number {
    return this.rows;
  }
  biomeAtCell(cx: number, cy: number): BiomeType {
    return this.biomeNames[this.biome[cy * this.cols + cx]];
  }
  wetnessAtCell(cx: number, cy: number): number {
    return this.wetness[cy * this.cols + cx];
  }

  /** Live (not copied) references to the grid data, for a renderer that wants
   * to bake the biome layer once and re-sample wetness per frame without
   * going through per-cell method calls. Caller must treat these as
   * read-only — mutating them would desync the simulation. */
  getGridData() {
    return { cols: this.cols, rows: this.rows, cellSize: this.cellSize, biome: this.biome, wetness: this.wetness };
  }

  wetnessAt(pos: Vec2): number {
    return this.wetness[this.cellIndex(pos)];
  }

  /** Movement speed multiplier for the ground at this position. */
  frictionAt(pos: Vec2): number {
    const wet = this.wetnessAt(pos);
    if (wet > 0.65) return 0.45; // deep puddle — dangerous & slow
    switch (this.biomeAt(pos)) {
      case 'sand':
        return 0.72;
      case 'leafLitter':
        return 0.88;
      case 'rock':
        return 0.6;
      default:
        return 1 - wet * 0.4;
    }
  }

  isDrowningHazard(pos: Vec2): boolean {
    return this.wetnessAt(pos) > 0.8;
  }

  private scatterObstacles(rng: RNG) {
    const count = Math.floor((this.width * this.height) / 90000);
    for (let i = 0; i < count; i++) {
      const pos = { x: range(rng, 0, this.width), y: range(rng, 0, this.height) };
      const biome = this.biomeAt(pos);
      if (biome === 'rock' && chance(rng, 0.7)) {
        this.obstacles.push({ pos, radius: range(rng, 14, 34), kind: 'rock' });
      } else if (chance(rng, 0.25)) {
        this.obstacles.push({
          pos,
          radius: range(rng, 5, 12),
          kind: chance(rng, 0.5) ? 'twig' : 'leaf',
        });
      }
    }
  }

  private scatterFood(rng: RNG, count: number) {
    for (let i = 0; i < count; i++) {
      this.spawnFoodAt({ x: range(rng, 40, this.width - 40), y: range(rng, 40, this.height - 40) }, rng);
    }
  }

  spawnFoodAt(pos: Vec2, rng: RNG) {
    const roll = rng();
    let type: FoodType;
    let maxAmount: number;
    let regrowRate: number;
    if (roll < 0.55) {
      type = 'seed';
      maxAmount = range(rng, 20, 45);
      regrowRate = range(rng, 0.02, 0.06);
    } else if (roll < 0.85) {
      type = 'fruit';
      maxAmount = range(rng, 45, 90);
      regrowRate = range(rng, 0.01, 0.03);
    } else {
      type = 'nectar';
      maxAmount = range(rng, 60, 120);
      regrowRate = range(rng, 0.015, 0.035);
    }
    this.foods.push({
      id: this.nextFoodId++,
      pos,
      amount: maxAmount,
      maxAmount,
      type,
      regrowRate,
      radius: 8 + Math.sqrt(maxAmount),
    });
  }

  /** A dead ant, predator, or other bug becomes a food source — closing the
   * loop between death and the colony's survival, just like real ant colonies
   * that scavenge their own dead and prey. */
  addCarcass(pos: Vec2, amount: number) {
    this.foods.push({
      id: this.nextFoodId++,
      pos: { ...pos },
      amount,
      maxAmount: amount,
      type: 'carcass',
      regrowRate: 0,
      radius: 6 + Math.sqrt(amount),
    });
  }

  regrow(dt: number) {
    for (const f of this.foods) {
      if (f.regrowRate > 0 && f.amount < f.maxAmount) {
        f.amount = Math.min(f.maxAmount, f.amount + f.regrowRate * dt);
      }
    }
    // Carcasses & fully depleted regrowables eventually vanish.
    this.foods = this.foods.filter((f) => f.amount > 0.05);
  }

  maybeSpawnFood(rng: RNG, chanceThisTick: number) {
    if (chance(rng, chanceThisTick)) {
      this.spawnFoodAt({ x: range(rng, 40, this.width - 40), y: range(rng, 40, this.height - 40) }, rng);
    }
  }

  applyRain(dt: number, intensity: number) {
    for (let i = 0; i < this.wetness.length; i++) {
      this.wetness[i] = Math.min(1, this.wetness[i] + intensity * 0.15 * dt);
    }
  }

  dryOut(dt: number) {
    for (let i = 0; i < this.wetness.length; i++) {
      this.wetness[i] = Math.max(0, this.wetness[i] - 0.04 * dt);
    }
  }

  /** Find a spot suitable for a new nest: not rock, not currently a puddle,
   * far enough from every existing nest, and inside the world bounds. */
  findNestSite(rng: RNG, existing: Vec2[], minSeparation: number, near?: Vec2, nearRadius = 900): Vec2 | null {
    for (let attempt = 0; attempt < 60; attempt++) {
      const pos = near
        ? {
            x: near.x + range(rng, -nearRadius, nearRadius),
            y: near.y + range(rng, -nearRadius, nearRadius),
          }
        : { x: range(rng, 60, this.width - 60), y: range(rng, 60, this.height - 60) };
      if (pos.x < 40 || pos.y < 40 || pos.x > this.width - 40 || pos.y > this.height - 40) continue;
      const biome = this.biomeAt(pos);
      if (biome === 'rock' || biome === 'puddle') continue;
      if (existing.some((e) => dist(e, pos) < minSeparation)) continue;
      return pos;
    }
    return null;
  }

  /** Steering nudge away from nearby obstacles; zero vector if clear. */
  obstacleAvoidance(pos: Vec2, lookAhead: number): Vec2 {
    let px = 0;
    let py = 0;
    for (const o of this.obstacles) {
      const dx = pos.x - o.pos.x;
      const dy = pos.y - o.pos.y;
      const d = Math.hypot(dx, dy);
      const margin = o.radius + lookAhead;
      if (d < margin && d > 0.001) {
        const push = (margin - d) / margin;
        px += (dx / d) * push;
        py += (dy / d) * push;
      }
    }
    return { x: px, y: py };
  }

  randomPointNear(rng: RNG, center: Vec2, radius: number): Vec2 {
    const angle = range(rng, 0, Math.PI * 2);
    const r = Math.sqrt(rng()) * radius;
    return {
      x: Math.min(this.width - 10, Math.max(10, center.x + Math.cos(angle) * r)),
      y: Math.min(this.height - 10, Math.max(10, center.y + Math.sin(angle) * r)),
    };
  }
}

export function randomFoodTypeLabel(type: FoodType): string {
  switch (type) {
    case 'seed':
      return 'seed';
    case 'fruit':
      return 'fruit chunk';
    case 'nectar':
      return 'nectar drop';
    case 'carcass':
      return 'carcass';
  }
}

export const pickObstacleKind = (rng: RNG) => pick(rng, ['rock', 'twig', 'leaf'] as const);
export const randomSmallInt = (rng: RNG, a: number, b: number) => rangeInt(rng, a, b);
