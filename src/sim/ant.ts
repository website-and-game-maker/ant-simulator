import type { AntSnapshot, AntTask, Caste, DeathCause, FoodSource, Genetics, SpeciesProfile, WeatherState } from './types';
import type { Vec2 } from './vec2';
import { add, angleDiff, angleOf, dist, fromAngle, sub, turnToward } from './vec2';
import { chance, clamp, gaussian, range, type RNG } from './rng';
import type { Terrain } from './terrain';
import type { PheromoneField } from './pheromones';

let nextAntId = 1;

/** Anything that can throw or take a punch: ants and predators both implement
 * this so combat code doesn't care which kind of creature it's hitting.
 * `pendingDeathCause` is how the *attacker* tells the simulation why a
 * combatant it just killed died, since the victim's own update() loop may
 * not run again this tick to record it itself. */
export interface Combatant {
  readonly pos: Vec2;
  health: number;
  readonly maxHealth: number;
  alive: boolean;
  readonly strength: number;
  readonly colonyId: number; // -1 for predators / neutral wildlife
  pendingDeathCause?: DeathCause;
}

/** What an Ant needs from the colony it belongs to. A structural interface
 * (not imported from colony.ts) so ant.ts has zero runtime dependency on
 * Colony — avoids a circular import and keeps this file testable alone. */
export interface HomeColony {
  readonly id: number;
  readonly nestPos: Vec2;
  readonly territoryRadius: number;
  receiveForager(amount: number, industriousness: number): void;
}

export interface AntTickContext {
  dt: number;
  simTime: number;
  rng: RNG;
  species: SpeciesProfile;
  terrain: Terrain;
  foodTrail: PheromoneField;
  alarmTrail: PheromoneField;
  activityMultiplier: number; // 0..1+, day/night/weather modulated
  weather: WeatherState;
  home: HomeColony;
  nearbyFoods: FoodSource[];
  nearbyAllies: Combatant[];
  nearbyEnemies: Combatant[];
  nearbyPredators: Combatant[];
  /** A world point roughly `nearRadius` from home, for alates seeking a new
   * nest site — supplied by Simulation since Ant shouldn't know about other
   * colonies' positions. */
  randomFlightTarget: () => Vec2;
}

const SENSE_BASE = 90;
const NEST_RADIUS = 16;
const ATTACK_RANGE = 11;
const ATTACK_COOLDOWN = 0.55;
const WANDER_JITTER = 1.4; // radians/sec of random heading drift while exploring
const MAX_TURN_RATE = 5.5; // radians/sec
const FLIGHT_DURATION = 10; // seconds an alate spends airborne before landing

export class Ant implements Combatant {
  readonly id = nextAntId++;
  readonly colonyId: number;
  caste: Exclude<Caste, 'larva' | 'queen'>;
  genetics: Genetics;
  pos: Vec2;
  heading: number;
  speed = 0;
  task: AntTask = 'exploring';
  carryAmount = 0;
  energy = 100;
  health = 100;
  readonly maxHealth = 100;
  age = 0;
  alive = true;
  selected = false;
  pendingDeathCause?: DeathCause;
  /** Set by Ant once a nuptial-flight ant has either finished flying (drone)
   * or landed and should attempt to found a colony (alate queen). Simulation
   * checks this after update() and handles the lifecycle transition. */
  lifecycleDone = false;
  /** Set by Simulation once it has handled a lifecycle transition (colony
   * founded, drone expired) — distinct from `alive` because this isn't a
   * death: no carcass-from-`die()`, no death-cause bookkeeping. */
  removed = false;

  private maxAge: number;
  private attackCooldown = 0;
  private target: Combatant | null = null;
  private targetFood: FoodSource | null = null;
  private homeBiasT = 0; // grows the longer an ant has been out, pulling it home
  private navError = 0; // simulated dead-reckoning drift
  private fleeUntil = 0;
  private lastFoodDirection: number | null = null;
  private flightTimer = 0;
  private flightTarget: Vec2 | null = null;
  private settleTimer = 0;

  constructor(colonyId: number, caste: Ant['caste'], genetics: Genetics, pos: Vec2, baseLifespanTicks: number, rng: RNG) {
    this.colonyId = colonyId;
    this.caste = caste;
    this.genetics = genetics;
    this.pos = { ...pos };
    this.heading = range(rng, 0, Math.PI * 2);
    this.maxAge = baseLifespanTicks * genetics.lifespan;
    if (caste === 'soldier') this.task = 'patrolling';
    else if (caste === 'drone' || caste === 'alateQueen') this.task = 'nuptialFlight';
    else this.task = 'exploring';
  }

  get strength(): number {
    return this.genetics.strength * (this.caste === 'soldier' ? 1.6 : 1);
  }

  private die(cause: DeathCause) {
    this.alive = false;
    this.health = 0;
    this.pendingDeathCause = cause;
  }

  update(ctx: AntTickContext) {
    if (!this.alive) return;
    this.age += ctx.dt;

    if (this.age > this.maxAge) {
      const overshoot = (this.age - this.maxAge) / (this.maxAge * 0.25 + 1);
      if (chance(ctx.rng, clamp(overshoot, 0, 1) * 0.9 * ctx.dt)) {
        this.die('oldAge');
        return;
      }
    }

    if (ctx.terrain.isDrowningHazard(this.pos) && chance(ctx.rng, (0.08 / this.genetics.strength) * ctx.dt)) {
      this.die('drowned');
      return;
    }

    if (ctx.weather === 'storm' && chance(ctx.rng, 0.012 * ctx.dt)) {
      this.die('crushed');
      return;
    }

    const metabolism =
      ctx.species.metabolism * ctx.dt * (this.task === 'engaging' || this.task === 'fleeing' || this.task === 'nuptialFlight' ? 1.8 : 1);
    this.energy -= metabolism;
    if (this.energy <= 0) {
      this.die('starvation');
      return;
    }

    // Threat perception happens regardless of current task — an ant mid-forage
    // can still be jumped by a predator or an enemy patrol. Alates in flight
    // are above the fray.
    if (this.task !== 'nuptialFlight' && this.task !== 'foundingSolo') this.perceiveThreats(ctx);

    switch (this.task) {
      case 'exploring':
        this.doExploring(ctx);
        break;
      case 'returningWithFood':
        this.doReturning(ctx);
        break;
      case 'patrolling':
        this.doPatrolling(ctx);
        break;
      case 'engaging':
        this.doEngaging(ctx);
        break;
      case 'fleeing':
        this.doFleeing(ctx);
        break;
      case 'nuptialFlight':
        this.doNuptialFlight(ctx);
        break;
      case 'foundingSolo':
        this.settleTimer += ctx.dt;
        if (this.settleTimer > 1.2) this.lifecycleDone = true;
        break;
      default:
        this.doExploring(ctx);
    }

    this.attackCooldown = Math.max(0, this.attackCooldown - ctx.dt);
  }

  private senseRadius(): number {
    return SENSE_BASE * this.genetics.senseRadius;
  }

  private perceiveThreats(ctx: AntTickContext) {
    if (this.task === 'engaging' || this.task === 'fleeing') return;
    const predator = nearestAlive(ctx.nearbyPredators, this.pos);
    const enemy = nearestAlive(ctx.nearbyEnemies, this.pos);
    const threat = predator && (!enemy || dist(predator.pos, this.pos) < dist(enemy.pos, this.pos)) ? predator : enemy;
    if (!threat) return;

    const d = dist(threat.pos, this.pos);
    const alertRange = this.senseRadius() * 0.7;
    if (d > alertRange) return;

    const bold = this.caste === 'soldier' || chance(ctx.rng, this.genetics.aggression * 0.6);
    if (bold) {
      this.target = threat;
      this.task = 'engaging';
      ctx.alarmTrail.deposit(this.pos, 90, this.colonyId);
    } else if (d < alertRange * 0.5) {
      this.fleeUntil = ctx.simTime + range(ctx.rng, 1.5, 3.5);
      this.target = threat;
      this.task = 'fleeing';
    }
  }

  private doExploring(ctx: AntTickContext) {
    // 1) Direct sight of food beats everything.
    if (!this.targetFood || this.targetFood.amount <= 0) {
      this.targetFood = nearestFood(ctx.nearbyFoods, this.pos, this.senseRadius());
    }

    let desired: number;
    if (this.targetFood) {
      desired = angleOf(sub(this.targetFood.pos, this.pos));
      if (dist(this.targetFood.pos, this.pos) < this.targetFood.radius + 4) {
        const bite = Math.min(this.targetFood.amount, 1.5 + this.strength);
        this.targetFood.amount -= bite;
        this.carryAmount = bite;
        this.lastFoodDirection = this.heading;
        this.task = 'returningWithFood';
        this.targetFood = null;
        this.homeBiasT = 0;
        return;
      }
    } else {
      // 2) Otherwise, sniff around for a trail worth following.
      const trail = ctx.foodTrail.bestDirection(this.pos, this.heading, this.colonyId, 26 + this.senseRadius() * 0.3);
      const followChance = 0.35 + this.genetics.industriousness * 0.4;
      if (trail.strength > 4 && chance(ctx.rng, followChance)) {
        desired = trail.heading;
      } else {
        // 3) Pure exploration: wander, softly pulled outward from the nest at
        // first and increasingly pulled home the longer the trip runs (an ant
        // that hasn't found anything eventually gives up and resets).
        this.homeBiasT += ctx.dt / 45;
        const distFromNest = dist(this.pos, ctx.home.nestPos);
        const maxRange = this.senseRadius() * 9;
        const outwardBias = distFromNest < maxRange * 0.3 ? angleOf(sub(this.pos, ctx.home.nestPos)) : this.heading;
        const homeBias = angleOf(sub(ctx.home.nestPos, this.pos));
        const jitter = gaussian(ctx.rng, 0, WANDER_JITTER * ctx.dt);
        const pullToHome = clamp(this.homeBiasT + (distFromNest > maxRange ? 1 : 0), 0, 1);
        desired = this.heading + jitter;
        if (pullToHome > 0.02) {
          desired = lerpAngle(desired, homeBias, pullToHome * 0.5);
        } else if (this.lastFoodDirection !== null && chance(ctx.rng, 0.02)) {
          // Loyalty: occasionally re-try the direction that paid off last time.
          desired = lerpAngle(desired, this.lastFoodDirection, 0.4);
        } else {
          desired = lerpAngle(desired, outwardBias, 0.05);
        }
        if (pullToHome > 0.95 && distFromNest < NEST_RADIUS * 2) this.homeBiasT = 0;
      }
    }

    this.moveToward(ctx, desired, 1);
  }

  private doReturning(ctx: AntTickContext) {
    // Path integration home, with a bit of accumulated dead-reckoning error
    // so the walk home looks organic instead of laser-straight.
    this.navError += gaussian(ctx.rng, 0, 0.05 * ctx.dt);
    this.navError = clamp(this.navError, -0.35, 0.35);
    const homeAngle = angleOf(sub(ctx.home.nestPos, this.pos)) + this.navError;

    ctx.foodTrail.deposit(this.pos, 55 * this.genetics.industriousness * ctx.dt * 10, this.colonyId);

    const d = dist(this.pos, ctx.home.nestPos);
    if (d < NEST_RADIUS) {
      ctx.home.receiveForager(this.carryAmount, this.genetics.industriousness);
      this.carryAmount = 0;
      this.energy = Math.min(100, this.energy + 18);
      this.task = 'exploring';
      this.navError = 0;
      return;
    }

    this.moveToward(ctx, homeAngle, 1.05);
  }

  private doPatrolling(ctx: AntTickContext) {
    const d = dist(this.pos, ctx.home.nestPos);
    let desired: number;
    if (d > ctx.home.territoryRadius) {
      desired = angleOf(sub(ctx.home.nestPos, this.pos));
    } else {
      desired = this.heading + gaussian(ctx.rng, 0, WANDER_JITTER * 0.6 * ctx.dt);
    }
    // Soldiers converge on alarm signals to reinforce a fight in progress.
    const alarm = ctx.alarmTrail.bestDirection(this.pos, this.heading, this.colonyId, 60);
    if (alarm.strength > 8) desired = lerpAngle(desired, alarm.heading, 0.6);
    this.moveToward(ctx, desired, 0.9);
  }

  private doEngaging(ctx: AntTickContext) {
    if (!this.target || !this.target.alive) {
      this.target = nearestAlive(ctx.nearbyEnemies, this.pos) ?? nearestAlive(ctx.nearbyPredators, this.pos);
    }
    if (!this.target || !this.target.alive) {
      this.task = this.caste === 'soldier' ? 'patrolling' : 'exploring';
      return;
    }
    const d = dist(this.pos, this.target.pos);
    if (d > this.senseRadius() * 1.4) {
      this.target = null;
      this.task = this.caste === 'soldier' ? 'patrolling' : 'exploring';
      return;
    }

    if (d <= ATTACK_RANGE) {
      if (this.attackCooldown <= 0) {
        const dmg = this.strength * range(ctx.rng, 6, 11);
        this.target.health -= dmg;
        this.attackCooldown = ATTACK_COOLDOWN;
        if (this.target.health <= 0 && this.target.alive) {
          this.target.alive = false;
          if (this.target.colonyId !== -1) this.target.pendingDeathCause = 'combat';
          this.task = this.caste === 'soldier' ? 'patrolling' : 'exploring';
          this.target = null;
        }
      }
      // Low-aggression non-soldiers may bail out of a losing fight.
      if (this.caste !== 'soldier' && this.health < 35 && chance(ctx.rng, (1 - this.genetics.aggression) * ctx.dt)) {
        this.fleeUntil = ctx.simTime + 2;
        this.task = 'fleeing';
      }
      return;
    }
    this.moveToward(ctx, angleOf(sub(this.target.pos, this.pos)), 1.15);
  }

  private doFleeing(ctx: AntTickContext) {
    if (ctx.simTime > this.fleeUntil || !this.target || !this.target.alive) {
      this.target = null;
      this.task = this.caste === 'soldier' ? 'patrolling' : 'exploring';
      return;
    }
    const away = angleOf(sub(this.pos, this.target.pos));
    this.moveToward(ctx, away, 1.3);
  }

  private doNuptialFlight(ctx: AntTickContext) {
    this.flightTimer += ctx.dt;
    if (!this.flightTarget || dist(this.pos, this.flightTarget) < 20) {
      this.flightTarget = ctx.randomFlightTarget();
    }
    const desired = angleOf(sub(this.flightTarget, this.pos));
    this.heading = turnToward(this.heading, desired, MAX_TURN_RATE * 0.6 * ctx.dt);
    this.speed = ctx.species.baseSpeed * 2.1 * ctx.activityMultiplier;
    const next = add(this.pos, fromAngle(this.heading, this.speed * ctx.dt));
    this.pos.x = clamp(next.x, 2, ctx.terrain.width - 2);
    this.pos.y = clamp(next.y, 2, ctx.terrain.height - 2);

    if (this.flightTimer > FLIGHT_DURATION) {
      if (this.caste === 'alateQueen') {
        this.task = 'foundingSolo';
      } else {
        this.lifecycleDone = true; // drone's job is done
      }
    }
  }

  private moveToward(ctx: AntTickContext, desiredHeading: number, speedFactor: number) {
    const avoid = ctx.terrain.obstacleAvoidance(this.pos, 14);
    let finalHeading = desiredHeading;
    if (avoid.x !== 0 || avoid.y !== 0) {
      finalHeading = lerpAngle(desiredHeading, angleOf(avoid), 0.7);
    }
    this.heading = turnToward(this.heading, finalHeading, MAX_TURN_RATE * ctx.dt);

    const friction = ctx.terrain.frictionAt(this.pos);
    const carryPenalty = this.carryAmount > 0 ? 0.85 : 1;
    this.speed = ctx.species.baseSpeed * this.genetics.speed * friction * carryPenalty * speedFactor * ctx.activityMultiplier;

    const delta = fromAngle(this.heading, this.speed * ctx.dt);
    const next = add(this.pos, delta);
    this.pos.x = clamp(next.x, 2, ctx.terrain.width - 2);
    this.pos.y = clamp(next.y, 2, ctx.terrain.height - 2);
  }

  toSnapshot(): AntSnapshot {
    return {
      id: this.id,
      colonyId: this.colonyId,
      caste: this.caste,
      pos: { ...this.pos },
      heading: this.heading,
      speed: this.speed,
      task: this.task,
      carrying: this.carryAmount > 0,
      energy: this.energy,
      health: this.health,
      age: this.age,
      genetics: this.genetics,
      selected: this.selected,
    };
  }
}

function nearestFood(foods: FoodSource[], pos: Vec2, maxRange: number): FoodSource | null {
  let best: FoodSource | null = null;
  let bestD = maxRange;
  for (const f of foods) {
    if (f.amount <= 0) continue;
    const d = dist(f.pos, pos);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

function nearestAlive<T extends Combatant>(list: T[], pos: Vec2): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const c of list) {
    if (!c.alive) continue;
    const d = dist(c.pos, pos);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t;
}
