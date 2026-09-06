import type { Caste, ColonySnapshot, Genetics, SpeciesProfile } from './types';
import type { Vec2 } from './vec2';
import { averageGenetics, inheritGenetics } from './genetics';
import { chance, clamp, type RNG } from './rng';

export interface Larva {
  id: number;
  genetics: Genetics;
  progress: number; // 0..1
  matureTicks: number;
  starving: boolean;
}

let nextLarvaId = 1;
let nextColonyId = 1;

const EMPTY_CASTE_COUNTS = (): Record<Caste, number> => ({
  larva: 0,
  worker: 0,
  soldier: 0,
  queen: 0,
  drone: 0,
  alateQueen: 0,
});

const MATURE_POPULATION = 26; // population at which a colony can start producing alates
const NUPTIAL_FOOD_SURPLUS_TICKS = 40; // seconds of sustained surplus needed to trigger a flight

/**
 * A single ant colony: a queen, her larvae, and however many adult ants are
 * currently alive and roaming (those are tracked as `Ant` instances by
 * Simulation — Colony only keeps counts + the biology that doesn't need a
 * position: the queen, the brood, and the food store).
 */
export class Colony {
  readonly id = nextColonyId++;
  readonly parentColonyId: number | null;
  name: string;
  colorHue: number;
  nestPos: Vec2;
  foodStore = 40;
  generation: number;
  founded: number;
  alive = true;
  territoryRadius = 140;

  private queenGenetics: Genetics;
  private droneGenetics: Genetics;
  queenAlive = true;
  queenAge = 0;
  queenEnergy = 100;
  private queenMaxAge: number;
  private eggProgress = 0;

  larvae: Larva[] = [];
  populationByCaste = EMPTY_CASTE_COUNTS();
  private livingGenetics: Genetics[] = [];
  /** True once this colony has ever raised a worker (or any adult). While
   * false and population is 0, the queen is still "claustral" — a real
   * founding queen seals herself in and metabolizes her own fat reserves
   * rather than needing the colony's food store, so she doesn't starve
   * during the (~1-2 minute) gap before her first worker matures. */
  private hasHadWorkers = false;

  private recentDamageTimer = 0;
  private surplusTimer = 0;
  pendingNuptialFlight = false;
  /** How many alates this flight episode has produced so far. Counts up
   * regardless of how quickly they then fly off and leave the roaming
   * population (unlike `populationByCaste`, which drops back down within
   * ~10s of each alate launching) — that's what lets the flight actually end. */
  private alatesProducedThisFlight = 0;

  constructor(opts: {
    nestPos: Vec2;
    colorHue: number;
    name: string;
    queenGenetics: Genetics;
    droneGenetics: Genetics;
    generation: number;
    parentColonyId: number | null;
    founded: number;
    queenMaxAge: number;
    startingFood?: number;
  }) {
    this.nestPos = { ...opts.nestPos };
    this.colorHue = opts.colorHue;
    this.name = opts.name;
    this.queenGenetics = opts.queenGenetics;
    this.droneGenetics = opts.droneGenetics;
    this.generation = opts.generation;
    this.parentColonyId = opts.parentColonyId;
    this.founded = opts.founded;
    this.queenMaxAge = opts.queenMaxAge;
    if (opts.startingFood !== undefined) this.foodStore = opts.startingFood;
  }

  get population(): number {
    return (
      this.populationByCaste.worker +
      this.populationByCaste.soldier +
      this.populationByCaste.drone +
      this.populationByCaste.alateQueen
    );
  }

  notifyBirth(caste: Caste, genetics: Genetics) {
    this.populationByCaste[caste]++;
    this.livingGenetics.push(genetics);
    this.hasHadWorkers = true;
  }

  notifyDeath(caste: Caste, genetics: Genetics, combatRelated: boolean) {
    this.populationByCaste[caste] = Math.max(0, this.populationByCaste[caste] - 1);
    const idx = this.livingGenetics.indexOf(genetics);
    if (idx >= 0) this.livingGenetics.splice(idx, 1);
    if (combatRelated) this.recentDamageTimer = 25;
  }

  receiveForager(amount: number, _industriousness: number) {
    void _industriousness;
    this.foodStore += amount;
  }

  /** Called by Simulation when a larva finished maturing but the *global*
   * ant population cap (shared across every colony) has no room for it
   * right now. Rather than just dropping the individual the colony already
   * paid food to raise, put it right back at the door so it tries again
   * next tick — it'll hatch for real as soon as the cap frees up. */
  requeueMaturedLarva(genetics: Genetics, matureTicks: number) {
    this.larvae.push({ id: nextLarvaId++, genetics, progress: 0.999, matureTicks, starving: false });
  }

  averageGenetics(): Genetics | null {
    return averageGenetics(this.livingGenetics);
  }

  private eggFertilityRate(): number {
    if (!this.queenAlive) return 0;
    const foodFactor = clamp(this.foodStore / Math.max(6, this.population * 0.6), 0.15, 1.6);
    return this.queenGenetics.industriousness * foodFactor;
  }

  /** Decide what an about-to-mature larva becomes, based on current colony
   * composition & recent threats — caste is nutrition/need-driven, not a
   * genetic fixed trait, matching real ant biology. */
  private decideCaste(rng: RNG): Exclude<Caste, 'larva' | 'queen'> {
    const pop = Math.max(1, this.population);
    const soldierRatio = this.populationByCaste.soldier / pop;
    const wantMoreSoldiers = this.recentDamageTimer > 0 ? 0.45 : 0.16;

    if (this.pendingNuptialFlight) {
      this.alatesProducedThisFlight++;
      return chance(rng, 0.55) ? 'alateQueen' : 'drone';
    }
    if (soldierRatio < wantMoreSoldiers && chance(rng, 0.6)) return 'soldier';
    return 'worker';
  }

  tick(dt: number, rng: RNG, species: SpeciesProfile, simTime: number): { spawn: { caste: Caste; genetics: Genetics }[] } {
    const spawns: { caste: Caste; genetics: Genetics }[] = [];
    this.recentDamageTimer = Math.max(0, this.recentDamageTimer - dt);

    // --- Queen -------------------------------------------------------------
    const claustral = this.population === 0 && !this.hasHadWorkers;
    if (this.queenAlive) {
      this.queenAge += dt;
      if (!claustral) {
        // An established queen depends on foragers: she draws down the
        // colony's food store and her energy tracks how well-fed she is.
        this.queenEnergy -= species.metabolism * 0.5 * dt;
        if (this.foodStore > 1) {
          this.foodStore -= Math.min(this.foodStore, 0.6 * dt);
          this.queenEnergy = Math.min(100, this.queenEnergy + 1.2 * dt);
        }
      }
      // While claustral, her energy simply holds — she's living off fat
      // reserves, not the colony larder, so she can't die of "starvation"
      // before her first worker ever hatches.
      if (this.queenEnergy <= 0 || this.queenAge > this.queenMaxAge) {
        const senescence = this.queenAge > this.queenMaxAge ? clamp((this.queenAge - this.queenMaxAge) / this.queenMaxAge, 0, 1) : 0;
        if (this.queenEnergy <= 0 || chance(rng, senescence * dt * 0.5)) {
          this.queenAlive = false;
        }
      }

      const fertility = this.eggFertilityRate();
      this.eggProgress += dt * fertility;
      const eggCost = species.eggTicks;
      if (this.eggProgress >= eggCost && this.foodStore > 4) {
        this.eggProgress = 0;
        this.foodStore -= 4;
        const genetics = inheritGenetics(this.queenGenetics, this.droneGenetics, rng);
        this.larvae.push({
          id: nextLarvaId++,
          genetics,
          progress: 0,
          matureTicks: species.larvaMatureTicks * (0.8 + rng() * 0.4),
          starving: false,
        });
      }
    }

    // --- Nuptial flight readiness -------------------------------------------
    const foodPerAnt = this.foodStore / Math.max(1, this.population);
    if (!this.pendingNuptialFlight && this.population >= MATURE_POPULATION && foodPerAnt > 1.4) {
      this.surplusTimer += dt;
      if (this.surplusTimer > NUPTIAL_FOOD_SURPLUS_TICKS) {
        this.pendingNuptialFlight = true;
        this.surplusTimer = 0;
      }
    } else if (foodPerAnt <= 1.4) {
      this.surplusTimer = Math.max(0, this.surplusTimer - dt * 0.5);
    }
    // Only keep producing alates for a short window per flight so colonies
    // don't turn 100% into reproductives. Gated on a monotonically
    // increasing counter, not live alate population — alates fly off and
    // leave the roaming population within ~10s of hatching, faster than a
    // new egg can even be laid, so a live-population check would never
    // trip and the colony would stay in flight mode forever.
    if (this.pendingNuptialFlight && this.alatesProducedThisFlight >= 6) {
      this.pendingNuptialFlight = false;
      this.alatesProducedThisFlight = 0;
    }

    // --- Larvae --------------------------------------------------------------
    const foodAvailableForBrood = this.foodStore > 0.5;
    for (const larva of this.larvae) {
      const feedRate = foodAvailableForBrood ? 1 : 0.15;
      larva.starving = !foodAvailableForBrood;
      if (foodAvailableForBrood) this.foodStore -= Math.min(this.foodStore, 0.08 * dt);
      larva.progress += (dt / larva.matureTicks) * feedRate;
    }

    const survivors: Larva[] = [];
    for (const larva of this.larvae) {
      if (larva.starving && chance(rng, 0.01 * dt)) continue; // starved to death, silently culled
      if (larva.progress >= 1) {
        const caste = this.decideCaste(rng);
        spawns.push({ caste, genetics: larva.genetics });
        continue;
      }
      survivors.push(larva);
    }
    this.larvae = survivors;

    // Territory grows (slowly) with population — a bigger colony patrols further.
    this.territoryRadius = 110 + Math.sqrt(this.population) * 18;

    if (!this.queenAlive && this.population === 0 && this.larvae.length === 0) {
      this.alive = false;
    }

    void simTime;
    return { spawn: spawns };
  }

  toSnapshot(): ColonySnapshot {
    return {
      id: this.id,
      name: this.name,
      nestPos: { ...this.nestPos },
      colorHue: this.colorHue,
      foodStore: this.foodStore,
      population: this.population,
      populationByCaste: { ...this.populationByCaste, larva: this.larvae.length, queen: this.queenAlive ? 1 : 0 },
      queenAlive: this.queenAlive,
      queenAge: this.queenAge,
      queenEnergy: this.queenEnergy,
      generation: this.generation,
      territoryRadius: this.territoryRadius,
      founded: this.founded,
      alive: this.alive,
      avgGenetics: this.averageGenetics(),
    };
  }

  static foundNew(opts: {
    nestPos: Vec2;
    colorHue: number;
    name: string;
    queenGenetics: Genetics;
    droneGenetics: Genetics;
    generation: number;
    parentColonyId: number | null;
    founded: number;
    queenMaxAge: number;
  }): Colony {
    // A founding queen starts claustral: sealed in with only her own fat
    // reserves (modeled here as a food head-start) until her first workers
    // hatch and can forage for her. Her personal upkeep doesn't touch this
    // store while claustral (see `tick`) — it only funds egg-laying and
    // feeding the brood, so this just needs to outlast one larva's
    // maturation, not her entire metabolism.
    return new Colony({ ...opts, startingFood: 34 });
  }
}
