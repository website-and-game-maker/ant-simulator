import type { BiomeType, FoodSource, FoodType, Obstacle } from './types';
import type { Vec2 } from './vec2';
import { dist } from './vec2';
import { ValueNoise2D } from './noise';
import { chance, pick, range, rangeInt, type RNG } from './rng';

const BIOME_CELL = 40;

/** One food source per this many square world-units. Food used to be a flat 46
 * sources regardless of world size, which on the bigger tiers meant hundreds of
 * units of empty ground between specks — a forager with a 90-unit nose and a
 * ~110-second tank essentially never found any. Scaling with area keeps every
 * tier at the same (findable) density. */
const WORLD_UNITS_PER_FOOD = 46000;
/** Never generate a world with fewer than this, however small it is. */
const MIN_FOOD_SOURCES = 32;

/** How saturated the ground can get in each biome. Rain used to raise wetness
 * uniformly everywhere until the entire map was a drowning hazard; now only
 * genuinely low, soggy ground pools deep enough to drown an ant. */
const MAX_WETNESS: Record<BiomeType, number> = {
  rock: 0.22,
  sand: 0.3,
  leafLitter: 0.55,
  dirt: 0.66,
  grass: 0.76,
  puddle: 1,
};

/** Wetness above which an ant can drown. Only `puddle` ground ever gets there. */
const DROWNING_WETNESS = 0.85;

/** Cell size of the obstacle lookup grid — obstacle avoidance runs for every
 * ant every step, so it can't be a linear scan over every rock in the world. */
const OBSTACLE_CELL = 96;

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
  /** How many regrowable (non-carcass) sources this world tries to keep alive. */
  readonly targetFoodSources: number;
  private wetnessCap: Float32Array;
  private obstacleGrid = new Map<number, Obstacle[]>();
  private obstacleCols: number;

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
        // Low ground that's also very wet actually holds standing water, so
        // puddles are real, localised places on the map instead of something
        // rain conjures over the entire world at once.
        else if (elevation < 0.3 && moisture > 0.68) biome = 'puddle';
        else if (moisture < 0.32) biome = 'sand';
        else if (litter > 0.62) biome = 'leafLitter';
        else if (moisture > 0.55) biome = 'grass';
        else biome = 'dirt';

        this.biome[y * this.cols + x] = this.biomeNames.indexOf(biome);
      }
    }

    this.wetnessCap = new Float32Array(this.cols * this.rows);
    for (let i = 0; i < this.wetnessCap.length; i++) {
      this.wetnessCap[i] = MAX_WETNESS[this.biomeNames[this.biome[i]]];
      // Puddle cells start with standing water in them.
      if (this.biomeNames[this.biome[i]] === 'puddle') this.wetness[i] = 0.9;
    }

    this.obstacleCols = Math.ceil(width / OBSTACLE_CELL) + 2;
    this.targetFoodSources = Math.max(MIN_FOOD_SOURCES, Math.round((width * height) / WORLD_UNITS_PER_FOOD));

    this.scatterObstacles(rng);
    this.rebuildObstacleGrid();
    this.scatterFood(rng, this.targetFoodSources);
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
    return this.wetnessAt(pos) > DROWNING_WETNESS;
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
    // Regrow rates are ~5x what they were. At the old rates a picked-over seed
    // took eight sim-minutes to refill, so any patch a colony actually found
    // was stripped permanently and the map only ever got poorer.
    if (roll < 0.55) {
      type = 'seed';
      maxAmount = range(rng, 20, 45);
      regrowRate = range(rng, 0.11, 0.3);
    } else if (roll < 0.85) {
      type = 'fruit';
      maxAmount = range(rng, 45, 90);
      regrowRate = range(rng, 0.06, 0.16);
    } else {
      type = 'nectar';
      maxAmount = range(rng, 60, 120);
      regrowRate = range(rng, 0.08, 0.19);
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

  /** Non-carcass sources with anything left in them — what `maybeSpawnFood`
   * tops back up to `targetFoodSources`. */
  get regrowableCount(): number {
    let n = 0;
    for (const f of this.foods) if (f.regrowRate > 0) n++;
    return n;
  }

  regrow(dt: number) {
    let anyEmpty = false;
    for (const f of this.foods) {
      if (f.regrowRate > 0) {
        // A source picked clean is gone for good, so leave a seed of it behind
        // to grow back from — this is what stops the world being permanently
        // stripped bare by a colony that got there first.
        if (f.amount < f.maxAmount) f.amount = Math.min(f.maxAmount, f.amount + f.regrowRate * dt);
      } else if (f.amount <= 0.05) {
        anyEmpty = true;
      }
    }
    // Only spent carcasses actually disappear; rebuilding the array every
    // single step (at every tier, with hundreds of sources) was pure waste.
    if (anyEmpty) this.foods = this.foods.filter((f) => f.regrowRate > 0 || f.amount > 0.05);
  }

  /** Occasionally drop a fresh source somewhere, but only while the world is
   * below its target density — so the map recovers from being foraged out
   * without growing without bound. */
  maybeSpawnFood(rng: RNG, chanceThisTick: number) {
    if (this.regrowableCount >= this.targetFoodSources) return;
    if (chance(rng, chanceThisTick)) {
      this.spawnFoodAt({ x: range(rng, 40, this.width - 40), y: range(rng, 40, this.height - 40) }, rng);
    }
  }

  applyRain(dt: number, intensity: number) {
    for (let i = 0; i < this.wetness.length; i++) {
      const cap = this.wetnessCap[i];
      if (this.wetness[i] >= cap) continue;
      this.wetness[i] = Math.min(cap, this.wetness[i] + intensity * 0.15 * dt);
    }
  }

  dryOut(dt: number) {
    for (let i = 0; i < this.wetness.length; i++) {
      // Puddles hold their water; everything else drains.
      const floor = this.wetnessCap[i] >= 1 ? 0.85 : 0;
      if (this.wetness[i] <= floor) continue;
      this.wetness[i] = Math.max(floor, this.wetness[i] - 0.04 * dt);
    }
  }

  /** Total food currently standing within `radius` of a point. Used to judge
   * whether a spot is worth nesting on; O(foods), so only call it when siting
   * a colony, never per-ant per-tick. */
  foodWithin(pos: Vec2, radius: number): number {
    let total = 0;
    for (const f of this.foods) {
      if (f.amount <= 0) continue;
      if (dist(f.pos, pos) <= radius) total += f.amount;
    }
    return total;
  }

  /**
   * Find a spot suitable for a new nest: not rock, not standing water, far
   * enough from every existing nest, and inside the world bounds.
   *
   * Legal ground isn't enough on its own — a colony dumped in a barren corner
   * starves through no fault of its own and the player just watches ants die.
   * So we gather every legal candidate and return the one with the most food
   * inside comfortable foraging range, falling back to the first legal spot if
   * nothing nearby has food at all.
   */
  findNestSite(rng: RNG, existing: Vec2[], minSeparation: number, near?: Vec2, nearRadius = 900, forageRadius = 620): Vec2 | null {
    let best: Vec2 | null = null;
    let bestScore = -1;
    let fallback: Vec2 | null = null;
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
      if (this.wetnessAt(pos) > 0.6) continue;
      if (existing.some((e) => dist(e, pos) < minSeparation)) continue;
      if (!fallback) fallback = pos;
      const score = this.foodWithin(pos, forageRadius);
      if (score > bestScore) {
        bestScore = score;
        best = pos;
      }
      // Plenty of food in range already — no need to keep looking.
      if (bestScore > 260) break;
    }
    return best ?? fallback;
  }

  private obstacleKey(cx: number, cy: number): number {
    return cy * this.obstacleCols + cx;
  }

  private rebuildObstacleGrid() {
    this.obstacleGrid.clear();
    for (const o of this.obstacles) {
      // A big rock overlaps several cells, so register it in every cell its
      // radius touches rather than only the one its centre falls in.
      const r = o.radius + 24;
      const minCx = Math.max(0, Math.floor((o.pos.x - r) / OBSTACLE_CELL));
      const maxCx = Math.floor((o.pos.x + r) / OBSTACLE_CELL);
      const minCy = Math.max(0, Math.floor((o.pos.y - r) / OBSTACLE_CELL));
      const maxCy = Math.floor((o.pos.y + r) / OBSTACLE_CELL);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const key = this.obstacleKey(cx, cy);
          const bucket = this.obstacleGrid.get(key);
          if (bucket) bucket.push(o);
          else this.obstacleGrid.set(key, [o]);
        }
      }
    }
  }

  /** Steering nudge away from nearby obstacles; zero vector if clear.
   * Runs once per ant per step, so it reads a grid bucket rather than
   * scanning every obstacle in the world (which on the beast tier was
   * ~450 obstacles x 9000 ants x 3 substeps every frame). */
  obstacleAvoidance(pos: Vec2, lookAhead: number): Vec2 {
    const cx = Math.floor(pos.x / OBSTACLE_CELL);
    const cy = Math.floor(pos.y / OBSTACLE_CELL);
    const bucket = this.obstacleGrid.get(this.obstacleKey(cx, cy));
    if (!bucket) return { x: 0, y: 0 };
    let px = 0;
    let py = 0;
    for (const o of bucket) {
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
