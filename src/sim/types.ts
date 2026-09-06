import type { Vec2 } from './vec2';

// ---------------------------------------------------------------------------
// Performance / graphics tiers
// ---------------------------------------------------------------------------

export type PerformanceTierName = 'low' | 'medium' | 'high' | 'beast';

export interface PerformanceProfile {
  name: PerformanceTierName;
  label: string;
  blurb: string;
  /** Hard cap on total living ants (across all colonies) the sim will simulate. */
  maxAnts: number;
  /** Hard cap on simultaneous colonies alive at once. */
  maxColonies: number;
  /** Hard cap on simultaneous predators. */
  maxPredators: number;
  /** World size in world-units. Bigger world on beefier tiers. */
  worldWidth: number;
  worldHeight: number;
  /** Pheromone grid cell size in world-units (smaller = higher fidelity, costlier). */
  pheromoneCellSize: number;
  /** Whether pheromone fields diffuse (blur) each step, or just evaporate. */
  pheromoneDiffusion: boolean;
  /** Simulation substeps per rendered frame (decouples sim fidelity from fps). */
  simSubsteps: number;
  /** Spatial hash cell size for neighbor queries. */
  spatialCellSize: number;
  /** Cap on devicePixelRatio used for canvas backing store. */
  maxDevicePixelRatio: number;
  render: {
    antLegAnimation: boolean;
    pheromoneGlow: boolean;
    softShadows: boolean;
    weatherParticles: boolean;
    ambientLighting: boolean;
    antiAlias: boolean;
    maxParticles: number;
    trailFade: boolean;
  };
}

// ---------------------------------------------------------------------------
// Genetics & castes
// ---------------------------------------------------------------------------

export interface Genetics {
  /** Movement speed multiplier. */
  speed: number;
  /** Combat power / carrying capacity multiplier. */
  strength: number;
  /** Multiplier on food/pheromone detection radius. */
  senseRadius: number;
  /** Multiplier on base lifespan. */
  lifespan: number;
  /** 0..1 likelihood of choosing to engage rather than flee. */
  aggression: number;
  /** 0..1 general work drive: forage persistence, egg-laying speed, etc. */
  industriousness: number;
  /** Cosmetic hue (0..360) — phenotype color variation. */
  hue: number;
}

export type Caste = 'larva' | 'worker' | 'soldier' | 'queen' | 'drone' | 'alateQueen';

export type AntTask =
  | 'exploring'
  | 'trailFollowing'
  | 'returningEmpty'
  | 'returningWithFood'
  | 'patrolling'
  | 'engaging'
  | 'fleeing'
  | 'nuptialFlight'
  | 'foundingSolo';

export type DeathCause =
  | 'oldAge'
  | 'starvation'
  | 'combat'
  | 'predator'
  | 'drowned'
  | 'exposure'
  | 'crushed';

// ---------------------------------------------------------------------------
// Species — tunable baseline biology, so the sim isn't hard-coded to one bug
// ---------------------------------------------------------------------------

export interface SpeciesProfile {
  id: string;
  name: string;
  baseColorHue: number;
  baseSpeed: number; // world units / second
  baseLifespanTicks: Record<Exclude<Caste, 'larva'>, number>;
  larvaMatureTicks: number;
  eggTicks: number;
  metabolism: number; // energy drained per second, baseline
  aggressionBase: number;
}

// ---------------------------------------------------------------------------
// World content
// ---------------------------------------------------------------------------

export type BiomeType = 'grass' | 'dirt' | 'sand' | 'rock' | 'puddle' | 'leafLitter';

export type FoodType = 'seed' | 'fruit' | 'carcass' | 'nectar';

export interface FoodSource {
  id: number;
  pos: Vec2;
  amount: number;
  maxAmount: number;
  type: FoodType;
  regrowRate: number; // units/sec, 0 for carcasses (they just deplete)
  radius: number;
}

export interface Obstacle {
  pos: Vec2;
  radius: number;
  kind: 'rock' | 'twig' | 'leaf';
}

export type WeatherState = 'clear' | 'overcast' | 'rain' | 'storm';

// ---------------------------------------------------------------------------
// Snapshots — cheap plain-data views handed to the renderer/UI each frame.
// Keeping these separate from live engine classes means the UI never holds
// references into mutable sim internals.
// ---------------------------------------------------------------------------

export interface AntSnapshot {
  id: number;
  colonyId: number;
  caste: Caste;
  pos: Vec2;
  heading: number;
  speed: number;
  task: AntTask;
  carrying: boolean;
  energy: number; // 0..100
  health: number; // 0..100
  age: number; // seconds
  genetics: Genetics;
  selected?: boolean;
}

export interface LarvaSnapshot {
  id: number;
  colonyId: number;
  pos: Vec2;
  progress: number; // 0..1
}

export interface ColonySnapshot {
  id: number;
  name: string;
  nestPos: Vec2;
  colorHue: number;
  foodStore: number;
  population: number;
  populationByCaste: Record<Caste, number>;
  queenAlive: boolean;
  queenAge: number;
  queenEnergy: number;
  generation: number;
  territoryRadius: number;
  founded: number; // sim time
  alive: boolean;
  avgGenetics: Genetics | null;
}

export interface PredatorSnapshot {
  id: number;
  kind: 'beetle' | 'spider' | 'bird';
  pos: Vec2;
  heading: number;
  health: number;
  maxHealth: number;
  state: 'wander' | 'hunt' | 'attack' | 'retreat' | 'dead';
}

export interface SimStats {
  simTime: number; // seconds of sim time elapsed
  tick: number;
  totalAnts: number;
  totalLarvae: number;
  totalColonies: number;
  totalPredators: number;
  births: number;
  deaths: number;
  deathsByCause: Record<DeathCause, number>;
  birthsPerMinute: number;
  deathsPerMinute: number;
  timeOfDay: number; // 0..1
  weather: WeatherState;
  fps: number;
  simMsPerFrame: number;
}

/** Live (uncopied) references to the terrain's biome/wetness grids — see
 * `Terrain.getGridData()`. Renderers use `biome` to bake a static ground
 * layer and re-sample `wetness` each frame for dynamic puddles. Treat both
 * arrays as read-only. */
export interface TerrainGridData {
  cols: number;
  rows: number;
  cellSize: number;
  biome: Uint8Array;
  wetness: Float32Array;
}

export interface PheromoneCell {
  x: number;
  y: number;
  size: number;
  strength: number; // 0..1
  colonyId: number;
}

export interface WorldSnapshot {
  width: number;
  height: number;
  foods: FoodSource[];
  obstacles: Obstacle[];
  terrainGrid: TerrainGridData;
  pheromone: { food: PheromoneCell[]; alarm: PheromoneCell[] };
  ants: AntSnapshot[];
  larvae: LarvaSnapshot[];
  colonies: ColonySnapshot[];
  predators: PredatorSnapshot[];
  stats: SimStats;
  timeOfDay: number;
  weather: WeatherState;
  rainIntensity: number;
}

// ---------------------------------------------------------------------------
// Events — for a lightweight pub/sub between engine, renderer, UI, and audio.
// ---------------------------------------------------------------------------

export interface SimEventMap {
  antBorn: { colonyId: number; caste: Caste };
  antDied: { colonyId: number; caste: Caste; cause: DeathCause; pos: Vec2 };
  colonyFounded: { colonyId: number; parentColonyId: number | null; pos: Vec2 };
  colonyCollapsed: { colonyId: number; pos: Vec2 };
  foodDepleted: { foodId: number; pos: Vec2 };
  combat: { pos: Vec2; a: 'ant' | 'predator'; b: 'ant' | 'predator' };
  weatherChanged: { weather: WeatherState };
  dayNightChanged: { isDay: boolean };
  nuptialFlight: { colonyId: number; count: number };
}

export type SimEventName = keyof SimEventMap;
