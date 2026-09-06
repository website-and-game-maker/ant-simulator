import type {
  AntSnapshot,
  ColonySnapshot,
  DeathCause,
  FoodSource,
  Genetics,
  PerformanceProfile,
  PerformanceTierName,
  WorldSnapshot,
  SimStats,
} from './types';
import type { Vec2 } from './vec2';
import { dist } from './vec2';
import type { ISimulation } from './facade';
import { EventBus } from './eventBus';
import { chance, mulberry32, pick, range, type RNG } from './rng';
import { PERFORMANCE_PROFILES, autoDetectTier } from './performanceProfiles';
import { Terrain } from './terrain';
import { PheromoneField } from './pheromones';
import { WeatherSystem } from './weather';
import { Colony } from './colony';
import { Ant, type AntTickContext, type Combatant } from './ant';
import { Predator, predatorCarcassValue, randomPredatorKind } from './predator';
import { SpatialHash } from './spatialHash';
import { DEFAULT_SPECIES, RIVAL_HUES } from './species';
import { inheritGenetics, randomGenetics } from './genetics';

const FOOD_TRAIL_EVAPORATION = 0.6;
const ALARM_TRAIL_EVAPORATION = 1.4;

function emptyDeathCounts(): Record<DeathCause, number> {
  return { oldAge: 0, starvation: 0, combat: 0, predator: 0, drowned: 0, exposure: 0, crushed: 0 };
}

const NAME_PREFIXES = ['Amber', 'Rust', 'Cinder', 'Moss', 'Thorn', 'Ember', 'Clay', 'Bramble', 'Loam', 'Fern', 'Granite', 'Umber'];
const NAME_SUFFIXES = ['hollow', 'hill', 'burrow', 'nest', 'ridge', 'mound', 'warren', 'delve', 'vale', 'crest'];

function colonyName(rng: RNG): string {
  return `${pick(rng, NAME_PREFIXES)}${pick(rng, NAME_SUFFIXES)}`;
}

/**
 * The engine. Owns every mutable piece of world state and advances it with a
 * fixed-timestep simulation loop, decoupled from render framerate via
 * `PerformanceProfile.simSubsteps`. Nothing outside this file should mutate
 * Ant/Colony/Predator/Terrain state directly — go through `ISimulation`.
 */
export class Simulation implements ISimulation {
  readonly events = new EventBus();

  private tier: PerformanceTierName;
  private profile: PerformanceProfile;
  private seed: number;
  private rng: RNG;

  private terrain!: Terrain;
  private foodTrail!: PheromoneField;
  private alarmTrail!: PheromoneField;
  private weather!: WeatherSystem;
  private colonies: Colony[] = [];
  private ants: Ant[] = [];
  private predators: Predator[] = [];
  private antsHash!: SpatialHash<Ant>;
  private predatorsHash!: SpatialHash<Predator>;
  private foodsHash!: SpatialHash<FoodSource>;

  private speedMultiplier = 1;
  private lastNonZeroSpeed = 1;
  private paused = false;
  private view: 'surface' | 'underground' = 'surface';
  private simTime = 0;
  private tick = 0;

  private selectedAntId: number | null = null;
  private selectedColonyId: number | null = null;

  private births = 0;
  private deaths = 0;
  private deathsByCause: Record<DeathCause, number> = emptyDeathCounts();
  private birthTimestamps: number[] = [];
  private deathTimestamps: number[] = [];

  private frameDtEma = 1 / 60;
  private simMsPerFrame = 0;
  private nextColonyHueIndex = 0;

  constructor(opts?: { tier?: PerformanceTierName; seed?: number }) {
    this.tier = opts?.tier ?? autoDetectTier();
    this.profile = PERFORMANCE_PROFILES[this.tier];
    this.seed = opts?.seed ?? (Date.now() >>> 0);
    this.rng = mulberry32(this.seed);
    this.initWorld();
  }

  // ---------------------------------------------------------------------
  // World (re)initialization
  // ---------------------------------------------------------------------

  private initWorld() {
    this.rng = mulberry32(this.seed);
    const { worldWidth, worldHeight, pheromoneCellSize, pheromoneDiffusion, spatialCellSize } = this.profile;

    this.terrain = new Terrain(worldWidth, worldHeight, this.rng);
    this.foodTrail = new PheromoneField(worldWidth, worldHeight, pheromoneCellSize, FOOD_TRAIL_EVAPORATION, pheromoneDiffusion);
    this.alarmTrail = new PheromoneField(worldWidth, worldHeight, pheromoneCellSize, ALARM_TRAIL_EVAPORATION, false);
    this.weather = new WeatherSystem(this.rng);
    this.colonies = [];
    this.ants = [];
    this.predators = [];
    this.antsHash = new SpatialHash<Ant>(spatialCellSize, (a) => a.pos);
    this.predatorsHash = new SpatialHash<Predator>(spatialCellSize, (p) => p.pos);
    this.foodsHash = new SpatialHash<FoodSource>(spatialCellSize * 1.5, (f) => f.pos);
    this.simTime = 0;
    this.tick = 0;
    this.selectedAntId = null;
    this.selectedColonyId = null;
    this.births = 0;
    this.deaths = 0;
    this.deathsByCause = emptyDeathCounts();
    this.birthTimestamps = [];
    this.deathTimestamps = [];
    this.nextColonyHueIndex = 0;

    const startingColonies = Math.min(
      this.profile.maxColonies,
      this.tier === 'low' ? 1 : this.tier === 'medium' ? 2 : this.tier === 'high' ? 3 : 4,
    );
    const existingPositions: Vec2[] = [];
    for (let i = 0; i < startingColonies; i++) {
      const site = this.terrain.findNestSite(this.rng, existingPositions, 520);
      if (!site) continue;
      existingPositions.push(site);
      this.createFoundingColony(site, null, 0);
    }
  }

  private nextHue(): number {
    const hue = RIVAL_HUES[this.nextColonyHueIndex % RIVAL_HUES.length];
    this.nextColonyHueIndex++;
    return hue;
  }

  private createFoundingColony(pos: Vec2, parentColonyId: number | null, generation: number): Colony {
    const hue = this.nextHue();
    const queenGenetics = randomGenetics(this.rng, hue);
    const droneGenetics = randomGenetics(this.rng, hue);
    const colony = Colony.foundNew({
      nestPos: pos,
      colorHue: hue,
      name: colonyName(this.rng),
      queenGenetics,
      droneGenetics,
      generation,
      parentColonyId,
      founded: this.simTime,
      queenMaxAge: DEFAULT_SPECIES.baseLifespanTicks.queen,
    });
    this.colonies.push(colony);
    this.events.emit('colonyFounded', { colonyId: colony.id, parentColonyId, pos });

    if (parentColonyId === null) {
      // Player-visible starting colonies get a small founding crew so the
      // world doesn't sit empty for the first few minutes of egg-laying.
      for (let i = 0; i < 6; i++) {
        this.spawnAnt(colony, 'worker', inheritGenetics(queenGenetics, droneGenetics, this.rng));
      }
    }
    return colony;
  }

  private spawnAnt(colony: Colony, caste: Ant['caste'], genetics: Genetics) {
    if (this.ants.length >= this.profile.maxAnts) return;
    const spread = 20;
    const pos = {
      x: colony.nestPos.x + range(this.rng, -spread, spread),
      y: colony.nestPos.y + range(this.rng, -spread, spread),
    };
    const lifespanTicks = DEFAULT_SPECIES.baseLifespanTicks[caste];
    const ant = new Ant(colony.id, caste, genetics, pos, lifespanTicks, this.rng);
    this.ants.push(ant);
    colony.notifyBirth(caste, genetics);
    this.births++;
    this.birthTimestamps.push(this.simTime);
    this.events.emit('antBorn', { colonyId: colony.id, caste });
  }

  private getColony(id: number): Colony | undefined {
    return this.colonies.find((c) => c.id === id);
  }

  private recordDeath(cause: DeathCause) {
    this.deaths++;
    this.deathsByCause[cause]++;
    this.deathTimestamps.push(this.simTime);
  }

  private handleAntDeath(ant: Ant, cause: DeathCause) {
    const colony = this.getColony(ant.colonyId);
    if (colony) colony.notifyDeath(ant.caste, ant.genetics, cause === 'combat' || cause === 'predator');
    this.terrain.addCarcass(ant.pos, 6 + ant.genetics.strength * 4);
    this.recordDeath(cause);
    this.events.emit('antDied', { colonyId: ant.colonyId, caste: ant.caste, cause, pos: { ...ant.pos } });
  }

  private pickMateGenetics(excludeColonyId: number): Genetics {
    const pool = this.ants.filter(
      (a) => a.alive && a.caste === 'drone' && a.task === 'nuptialFlight' && a.colonyId !== excludeColonyId,
    );
    if (pool.length > 0) return pick(this.rng, pool).genetics;
    // No eligible suitor in the air right now — a wild drone from beyond the
    // simulated area steps in, so founding queens are never stuck sterile.
    return randomGenetics(this.rng, RIVAL_HUES[Math.floor(this.rng() * RIVAL_HUES.length)]);
  }

  private handleLifecycleTransition(ant: Ant, parentColony: Colony) {
    parentColony.notifyDeath(ant.caste, ant.genetics, false);
    ant.removed = true;

    if (ant.caste === 'alateQueen') {
      const existing = this.colonies.map((c) => c.nestPos);
      const site = this.colonies.length < this.profile.maxColonies ? this.terrain.findNestSite(this.rng, existing, 420, ant.pos, 520) : null;
      if (site) {
        const mate = this.pickMateGenetics(parentColony.id);
        const newColony = Colony.foundNew({
          nestPos: site,
          colorHue: this.nextHue(),
          name: colonyName(this.rng),
          queenGenetics: ant.genetics,
          droneGenetics: mate,
          generation: parentColony.generation + 1,
          parentColonyId: parentColony.id,
          founded: this.simTime,
          queenMaxAge: DEFAULT_SPECIES.baseLifespanTicks.queen,
        });
        this.colonies.push(newColony);
        this.events.emit('colonyFounded', { colonyId: newColony.id, parentColonyId: parentColony.id, pos: site });
        this.events.emit('nuptialFlight', { colonyId: parentColony.id, count: 1 });
      } else {
        // No room for a new colony (map full, or nowhere safe to land).
        this.terrain.addCarcass(ant.pos, 8);
        this.recordDeath('exposure');
      }
    } else {
      // Drones die shortly after mating, as in reality — their contribution
      // lives on only in whatever queen they mated with.
      this.terrain.addCarcass(ant.pos, 4);
    }
  }

  // ---------------------------------------------------------------------
  // Fixed-timestep simulation
  // ---------------------------------------------------------------------

  private step(dt: number) {
    this.simTime += dt;
    this.tick++;

    const { dayNightFlipped, weatherChanged } = this.weather.step(dt, this.terrain);
    if (dayNightFlipped) this.events.emit('dayNightChanged', { isDay: this.weather.isDaytime });
    if (weatherChanged) this.events.emit('weatherChanged', { weather: this.weather.weather });

    this.terrain.regrow(dt);
    this.terrain.maybeSpawnFood(this.rng, dt * 0.008);

    this.antsHash.rebuild(this.ants);
    this.predatorsHash.rebuild(this.predators);
    this.foodsHash.rebuild(this.terrain.foods);

    this.foodTrail.step(dt, this.weather.evaporationMultiplier);
    this.alarmTrail.step(dt, this.weather.evaporationMultiplier);

    for (const colony of this.colonies) {
      if (!colony.alive) continue;
      const wasAlive = colony.alive;
      const { spawn } = colony.tick(dt, this.rng, DEFAULT_SPECIES, this.simTime);
      for (const s of spawn) {
        if (this.ants.length >= this.profile.maxAnts) break;
        this.spawnAnt(colony, s.caste as Ant['caste'], s.genetics);
      }
      if (wasAlive && !colony.alive) {
        this.events.emit('colonyCollapsed', { colonyId: colony.id, pos: colony.nestPos });
      }
    }

    const activityMultiplier = this.weather.activityMultiplier;
    const weatherState = this.weather.weather;

    for (const ant of this.ants) {
      if (!ant.alive) continue;
      const colony = this.getColony(ant.colonyId);
      if (!colony) {
        ant.removed = true;
        continue;
      }
      const sense = 90 * ant.genetics.senseRadius * 1.6;
      const nearbyFoods = this.foodsHash.queryNear(ant.pos, sense);
      const nearbyAllies: Combatant[] = [];
      const nearbyEnemies: Combatant[] = [];
      this.antsHash.forEachNear(ant.pos, sense, (other) => {
        if (other === ant || !other.alive) return;
        if (other.colonyId === ant.colonyId) nearbyAllies.push(other);
        else nearbyEnemies.push(other);
      });
      const nearbyPredators: Combatant[] = this.predatorsHash.queryNear(ant.pos, sense);

      const ctx: AntTickContext = {
        dt,
        simTime: this.simTime,
        rng: this.rng,
        species: DEFAULT_SPECIES,
        terrain: this.terrain,
        foodTrail: this.foodTrail,
        alarmTrail: this.alarmTrail,
        activityMultiplier,
        weather: weatherState,
        home: colony,
        nearbyFoods,
        nearbyAllies,
        nearbyEnemies,
        nearbyPredators,
        randomFlightTarget: () => this.terrain.randomPointNear(this.rng, colony.nestPos, 700),
      };
      ant.update(ctx);

      if (ant.lifecycleDone) this.handleLifecycleTransition(ant, colony);
    }

    for (const predator of this.predators) {
      if (!predator.alive) continue;
      const nearbyAnts: Combatant[] = this.antsHash.queryNear(predator.pos, 260);
      predator.update(dt, this.rng, this.terrain, nearbyAnts, this.simTime);
    }

    for (const ant of this.ants) {
      if (!ant.alive && !ant.removed) this.handleAntDeath(ant, ant.pendingDeathCause ?? 'combat');
    }
    this.ants = this.ants.filter((a) => a.alive && !a.removed);

    for (const predator of this.predators) {
      if (!predator.alive) this.terrain.addCarcass(predator.pos, predatorCarcassValue(predator.kind));
    }
    this.predators = this.predators.filter((p) => p.alive);

    this.colonies = this.colonies.filter((c) => c.alive || c.population > 0 || c.larvae.length > 0);

    if (this.predators.length < this.profile.maxPredators && chance(this.rng, dt * 0.006 * (1 + this.colonies.length * 0.15))) {
      const center = { x: this.terrain.width / 2, y: this.terrain.height / 2 };
      this.spawnPredatorAt(this.terrain.randomPointNear(this.rng, center, Math.max(this.terrain.width, this.terrain.height) / 2));
    }

    const cutoff = this.simTime - 60;
    while (this.birthTimestamps.length && this.birthTimestamps[0] < cutoff) this.birthTimestamps.shift();
    while (this.deathTimestamps.length && this.deathTimestamps[0] < cutoff) this.deathTimestamps.shift();
  }

  // ---------------------------------------------------------------------
  // ISimulation
  // ---------------------------------------------------------------------

  update(realDtSeconds: number): void {
    const t0 = performance.now();
    this.frameDtEma += (realDtSeconds - this.frameDtEma) * 0.08;
    if (!this.paused && this.speedMultiplier > 0) {
      const simDt = Math.min(realDtSeconds, 0.25) * this.speedMultiplier;
      const substeps = this.profile.simSubsteps;
      const stepDt = simDt / substeps;
      for (let i = 0; i < substeps; i++) this.step(stepDt);
    }
    this.simMsPerFrame = performance.now() - t0;
  }

  setTier(tier: PerformanceTierName): void {
    this.tier = tier;
    this.profile = PERFORMANCE_PROFILES[tier];
    this.initWorld();
  }
  getTier(): PerformanceTierName {
    return this.tier;
  }
  getProfile(): PerformanceProfile {
    return this.profile;
  }
  restart(seed?: number): void {
    this.seed = seed ?? (Date.now() >>> 0);
    this.initWorld();
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = Math.max(0, multiplier);
    if (this.speedMultiplier > 0) {
      this.lastNonZeroSpeed = this.speedMultiplier;
      this.paused = false;
    } else {
      this.paused = true;
    }
  }
  getSpeed(): number {
    return this.speedMultiplier;
  }
  togglePause(): void {
    if (this.paused) {
      this.paused = false;
      this.speedMultiplier = this.lastNonZeroSpeed;
    } else {
      this.paused = true;
      this.speedMultiplier = 0;
    }
  }
  isPaused(): boolean {
    return this.paused;
  }

  setView(view: 'surface' | 'underground'): void {
    this.view = view;
  }
  getView(): 'surface' | 'underground' {
    return this.view;
  }

  placeFoodAt(pos: Vec2): void {
    this.terrain.spawnFoodAt(pos, this.rng);
  }

  spawnPredatorAt(pos: Vec2): void {
    if (this.predators.length >= this.profile.maxPredators) return;
    const kind = randomPredatorKind(this.rng);
    this.predators.push(new Predator(kind, pos, this.rng));
  }

  foundColonyAt(pos: Vec2): boolean {
    if (this.colonies.length >= this.profile.maxColonies) return false;
    const site = this.terrain.findNestSite(this.rng, this.colonies.map((c) => c.nestPos), 260, pos, 40) ?? pos;
    this.createFoundingColony(site, null, 0);
    return true;
  }

  selectAt(pos: Vec2): void {
    let bestAnt: Ant | null = null;
    let bestD = 26;
    for (const ant of this.ants) {
      const d = dist(ant.pos, pos);
      if (d < bestD) {
        bestD = d;
        bestAnt = ant;
      }
    }
    if (bestAnt) {
      this.selectedAntId = bestAnt.id;
      this.selectedColonyId = null;
      return;
    }
    let bestColony: Colony | null = null;
    let bestCD = 44;
    for (const c of this.colonies) {
      const d = dist(c.nestPos, pos);
      if (d < bestCD) {
        bestCD = d;
        bestColony = c;
      }
    }
    if (bestColony) {
      this.selectedColonyId = bestColony.id;
      this.selectedAntId = null;
      return;
    }
    this.clearSelection();
  }
  clearSelection(): void {
    this.selectedAntId = null;
    this.selectedColonyId = null;
  }
  getSelectedAnt(): AntSnapshot | null {
    const ant = this.ants.find((a) => a.id === this.selectedAntId);
    if (!ant) return null;
    const snap = ant.toSnapshot();
    snap.selected = true;
    return snap;
  }
  getSelectedColony(): ColonySnapshot | null {
    const c = this.colonies.find((c2) => c2.id === this.selectedColonyId);
    return c ? c.toSnapshot() : null;
  }

  getSnapshot(): WorldSnapshot {
    const stats: SimStats = {
      simTime: this.simTime,
      tick: this.tick,
      totalAnts: this.ants.length,
      totalLarvae: this.colonies.reduce((s, c) => s + c.larvae.length, 0),
      totalColonies: this.colonies.filter((c) => c.alive).length,
      totalPredators: this.predators.length,
      births: this.births,
      deaths: this.deaths,
      deathsByCause: { ...this.deathsByCause },
      birthsPerMinute: this.birthTimestamps.length,
      deathsPerMinute: this.deathTimestamps.length,
      timeOfDay: this.weather.timeOfDay,
      weather: this.weather.weather,
      fps: this.frameDtEma > 0 ? 1 / this.frameDtEma : 0,
      simMsPerFrame: this.simMsPerFrame,
    };

    return {
      width: this.terrain.width,
      height: this.terrain.height,
      foods: this.terrain.foods,
      obstacles: this.terrain.obstacles,
      terrainGrid: this.terrain.getGridData(),
      pheromone: this.profile.render.pheromoneGlow
        ? { food: this.foodTrail.snapshotCells(6), alarm: this.alarmTrail.snapshotCells(6) }
        : { food: [], alarm: [] },
      ants: this.ants.map((a) => {
        const snap = a.toSnapshot();
        snap.selected = a.id === this.selectedAntId;
        return snap;
      }),
      larvae: this.colonies.flatMap((c) =>
        c.larvae.map((l) => ({
          id: l.id,
          colonyId: c.id,
          pos: { x: c.nestPos.x + Math.cos(l.id) * 10, y: c.nestPos.y + Math.sin(l.id) * 10 },
          progress: l.progress,
        })),
      ),
      colonies: this.colonies.map((c) => c.toSnapshot()),
      predators: this.predators.map((p) => p.toSnapshot()),
      stats,
      timeOfDay: this.weather.timeOfDay,
      weather: this.weather.weather,
      rainIntensity: this.weather.rainIntensity,
    };
  }
}
