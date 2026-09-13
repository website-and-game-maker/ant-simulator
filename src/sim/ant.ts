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
  /** Trophallaxis: nestmates regurgitate food to a hungry ant from the
   * communal store. Returns how much food was *actually* handed over, which
   * is 0 when the larder is empty — an ant at a starving nest gets nothing
   * and dies, exactly as it should. */
  requestTrophallaxis(amount: number): number;
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

// --- Feeding -----------------------------------------------------------------
// The energy economy. An ant burns `species.metabolism` (0.9) per second, so a
// full 100-energy tank is worth ~110 seconds of life. It refills two ways:
// trophallaxis at the nest (costs the colony's food store) and eating directly
// off a food source it's standing on. Before this existed the *only* refill was
// a successful food delivery, so an ant that never got lucky always starved.

/** Energy an ant gains per unit of food, whether fed at the nest or in the field. */
const ENERGY_PER_FOOD = 14;
/** How close to the nest entrance an ant has to be for nestmates to feed it. */
const FEED_RADIUS = 26;
/** Trophallaxis tops an ant right back up to this. */
const FEED_TARGET = 100;
/** Below this, an ant breaks off whatever it's doing and heads home to feed. */
const HUNGRY_ENERGY = 46;
/** Below this, a forager standing on food eats some of it on the spot rather
 * than hauling every crumb home — a real forager fills its own crop first. */
const FIELD_FEED_ENERGY = 55;
/** If the larder was empty when an ant came home, it goes back out and forages
 * this many seconds before trailing home to beg again (otherwise a starving
 * colony's whole workforce just mills around the nest entrance and dies). */
const REFEED_COOLDOWN = 22;
/** Crop capacity: how much food one trip hauls home. A round trip to a source
 * and back runs tens of seconds, so this is what sets the colony's whole income
 * rate — at 4 + 3·strength a forager barely covered its own metabolism. */
const CARRY_BASE = 6;
const CARRY_PER_STRENGTH = 4;
/** Seconds an ant explores without finding anything before giving up and
 * heading home to be fed. This replaced a per-frame "pull home" bias that
 * leashed foragers to the nest; giving up is now one discrete decision, and it
 * has to fire well inside the ~110s an ant's energy budget lasts so the trip
 * home and the meal at the end of it still fit. */
const EXPLORE_PATIENCE = 45;

// --- Trail -------------------------------------------------------------------
/** Pheromone laid per second by a laden ant walking home. Paired with the
 * food-trail evaporation rate in simulation.ts — together they set how long a
 * discovered food source stays advertised. */
const TRAIL_DEPOSIT_RATE = 130;
/** Trail strength an exploring ant considers worth committing to. */
const TRAIL_FOLLOW_MIN = 8;
/** Below this a follower decides it has lost the trail and goes back to exploring. */
const TRAIL_LOST = 3;
/** Longest a single trail-following excursion runs before the ant gives up. */
const TRAIL_PATIENCE = 55;

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
  /** Site fidelity: where this ant last actually found food. Real foragers
   * remember a productive patch and go straight back to it, which — combined
   * with the pheromone trail they lay on the way home — is what turns one
   * lucky discovery into a visible two-way column of ants. */
  private memoryFoodPos: Vec2 | null = null;
  /** Confidence in `memoryFoodPos`; spent down each time the ant gets there
   * and finds nothing, so exhausted patches are eventually forgotten. */
  private memoryTrust = 0;
  /** Sim time before which this ant won't bother walking home to beg again
   * (set when it came home to an empty larder). */
  private refeedBlockedUntil = 0;
  private trailTimer = 0;
  /** Per-ant willingness to abandon its own search and join a trail. Low
   * values keep a minority of ants scouting even when a highway exists. */
  private readonly trailAffinity: number;

  constructor(colonyId: number, caste: Ant['caste'], genetics: Genetics, pos: Vec2, baseLifespanTicks: number, rng: RNG) {
    this.colonyId = colonyId;
    this.caste = caste;
    this.genetics = genetics;
    this.pos = { ...pos };
    this.heading = range(rng, 0, Math.PI * 2);
    this.maxAge = baseLifespanTicks * genetics.lifespan;
    this.trailAffinity = clamp(0.2 + genetics.industriousness * 0.75, 0.08, 1);
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

    if (ctx.terrain.isDrowningHazard(this.pos) && chance(ctx.rng, (0.03 / this.genetics.strength) * ctx.dt)) {
      this.die('drowned');
      return;
    }

    // A storm is a real but occasional hazard. At the old rate (0.012/sec) an
    // ant had a ~50% chance of being crushed by any storm lasting a minute,
    // which wiped colonies out for no reason the player could see or act on.
    if (ctx.weather === 'storm' && chance(ctx.rng, 0.0006 * ctx.dt)) {
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

    // Hunger outranks ordinary work. An ant running low breaks off searching
    // and walks home to be fed rather than wandering until it drops. (An ant
    // already hauling food is heading home anyway, and one in a fight has
    // bigger problems.)
    if (
      this.isHungry() &&
      ctx.simTime >= this.refeedBlockedUntil &&
      (this.task === 'exploring' || this.task === 'trailFollowing' || this.task === 'patrolling')
    ) {
      this.task = 'returningEmpty';
      this.navError = 0;
    }

    switch (this.task) {
      case 'exploring':
        this.doExploring(ctx);
        break;
      case 'trailFollowing':
        this.doTrailFollowing(ctx);
        break;
      case 'returningEmpty':
        this.doReturningEmpty(ctx);
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

  /** How far from the nest this ant is willing to range before it turns back. */
  private foragingRange(): number {
    return this.senseRadius() * 9;
  }

  isHungry(): boolean {
    return this.energy < HUNGRY_ENERGY;
  }

  /**
   * Trophallaxis: beg a top-up from the colony's communal store. Returns how
   * much food the colony could actually spare. If the larder is (nearly)
   * empty the ant marks itself off-limits for begging for a while and goes
   * back out to forage — a starving colony sends its workers out, it doesn't
   * queue them at an empty pantry.
   */
  private feedAtNest(ctx: AntTickContext): number {
    if (this.energy >= FEED_TARGET - 0.5) return 0;
    const want = (FEED_TARGET - this.energy) / ENERGY_PER_FOOD;
    const got = ctx.home.requestTrophallaxis(want);
    if (got > 0) this.energy = Math.min(100, this.energy + got * ENERGY_PER_FOOD);
    if (got < want * 0.5) this.refeedBlockedUntil = ctx.simTime + REFEED_COOLDOWN;
    return got;
  }

  /**
   * If there's a food source in sense range, close on it; once in reach, eat
   * (if hungry) and fill the crop for the colony. Returns true once the ant
   * has actually picked up a load and switched to carrying it home.
   *
   * Eating on the spot is what stops the old absurdity of an ant starving to
   * death while standing on a fruit.
   */
  private tryHarvest(ctx: AntTickContext): boolean {
    if (!this.targetFood || this.targetFood.amount <= 0.05) {
      this.targetFood = nearestFood(ctx.nearbyFoods, this.pos, this.senseRadius());
    }
    const food = this.targetFood;
    if (!food) return false;
    if (dist(food.pos, this.pos) >= food.radius + 5) return false;

    if (this.energy < FIELD_FEED_ENERGY) {
      const selfFeed = Math.min(food.amount, (FEED_TARGET - this.energy) / ENERGY_PER_FOOD);
      if (selfFeed > 0) {
        food.amount -= selfFeed;
        this.energy = Math.min(100, this.energy + selfFeed * ENERGY_PER_FOOD);
      }
    }

    const bite = Math.min(food.amount, CARRY_BASE + CARRY_PER_STRENGTH * this.genetics.strength);
    if (bite <= 0.05) {
      this.targetFood = null;
      return false;
    }
    food.amount -= bite;
    this.carryAmount = bite;
    this.memoryFoodPos = { ...food.pos };
    this.memoryTrust = 1;
    this.lastFoodDirection = this.heading;
    this.targetFood = null;
    this.task = 'returningWithFood';
    this.homeBiasT = 0;
    this.trailTimer = 0;
    return true;
  }

  /** Where to go after a visit to the nest: back to a remembered patch if it
   * still looks promising, otherwise out to search again. */
  private resumeForaging() {
    this.trailTimer = 0;
    if (this.caste === 'soldier') {
      this.task = 'patrolling';
    } else if (this.memoryFoodPos && this.memoryTrust > 0) {
      this.task = 'trailFollowing';
    } else {
      this.task = 'exploring';
    }
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
    if (this.tryHarvest(ctx)) return;

    let desired: number;
    if (this.targetFood) {
      desired = angleOf(sub(this.targetFood.pos, this.pos));
    } else {
      // 2) Otherwise, sniff around for a trail worth following. Committing to
      // the trail as a *task* (rather than nudging the heading for one frame)
      // is what makes recruitment legible: a discovered source pulls a stream
      // of ants out of the nest along the same line.
      const trail = ctx.foodTrail.bestDirection(this.pos, this.heading, this.colonyId, 26 + this.senseRadius() * 0.3);
      if (trail.strength > TRAIL_FOLLOW_MIN && chance(ctx.rng, clamp(this.trailAffinity * 7 * ctx.dt, 0, 1))) {
        this.task = 'trailFollowing';
        this.trailTimer = 0;
        this.doTrailFollowing(ctx);
        return;
      }
      // 3) Pure exploration: a correlated random walk, pushed outward while
      // still close to home so ants actually leave the doorstep.
      //
      // This used to blend a "pull home" term into the heading every frame,
      // with a weight that started growing after 1.4 seconds — which meant an
      // exploring ant was being steered back at the nest within seconds of
      // leaving and orbited it for its whole life. With food typically 100-200
      // units out, most foragers physically could not reach any. Giving up is
      // now a discrete decision (hand off to `returningEmpty`, which knows how
      // to get home and get fed) instead of a permanent leash.
      this.homeBiasT += ctx.dt;
      const distFromNest = dist(this.pos, ctx.home.nestPos);
      const maxRange = this.foragingRange();
      if (this.homeBiasT > EXPLORE_PATIENCE || distFromNest > maxRange) {
        this.homeBiasT = 0;
        this.task = 'returningEmpty';
        return;
      }
      desired = this.heading + gaussian(ctx.rng, 0, WANDER_JITTER * ctx.dt);
      if (distFromNest < maxRange * 0.55 && distFromNest > 1) {
        const outward = angleOf(sub(this.pos, ctx.home.nestPos));
        desired = lerpAngle(desired, outward, clamp(0.8 * ctx.dt, 0, 1));
      }
      if (this.lastFoodDirection !== null && chance(ctx.rng, 0.6 * ctx.dt)) {
        // Loyalty: occasionally re-try the direction that paid off last time.
        desired = lerpAngle(desired, this.lastFoodDirection, 0.4);
      }
    }

    this.moveToward(ctx, desired, 1);
  }

  /**
   * Walking the highway: out along a remembered patch and/or the colony's own
   * scent trail, harvesting whatever it reaches. This plus `doReturning`'s
   * deposit is the positive-feedback loop — more ants on the trail means more
   * food coming home means a stronger trail means more ants.
   */
  private doTrailFollowing(ctx: AntTickContext) {
    if (this.tryHarvest(ctx)) return;
    if (this.targetFood) {
      this.moveToward(ctx, angleOf(sub(this.targetFood.pos, this.pos)), 1);
      return;
    }

    this.trailTimer += ctx.dt;
    const distFromNest = dist(this.pos, ctx.home.nestPos);
    if (this.trailTimer > TRAIL_PATIENCE || distFromNest > this.foragingRange() * 1.25) {
      this.memoryTrust -= 0.5;
      if (this.memoryTrust <= 0) this.memoryFoodPos = null;
      this.task = 'exploring';
      this.trailTimer = 0;
      return;
    }

    // Sample the trail in a cone centred on "away from the nest" while still
    // near home, so recruits stream outward instead of oscillating on the
    // stretch of trail right outside the door.
    const coneCenter = distFromNest < 70 ? angleOf(sub(this.pos, ctx.home.nestPos)) : this.heading;
    const trail = ctx.foodTrail.bestDirection(this.pos, coneCenter, this.colonyId, 22 + this.senseRadius() * 0.25);

    let desired: number;
    if (this.memoryFoodPos) {
      const toMemory = angleOf(sub(this.memoryFoodPos, this.pos));
      if (dist(this.pos, this.memoryFoodPos) < 32) {
        // Standing on the remembered patch with nothing in sense range: it's
        // spent. Spend some confidence and go back to searching.
        this.memoryTrust -= 0.5;
        if (this.memoryTrust <= 0) this.memoryFoodPos = null;
        this.task = 'exploring';
        this.trailTimer = 0;
        return;
      }
      desired = trail.strength > TRAIL_LOST ? lerpAngle(toMemory, trail.heading, 0.3) : toMemory;
    } else if (trail.strength > TRAIL_LOST) {
      desired = trail.heading;
    } else {
      this.task = 'exploring';
      this.trailTimer = 0;
      return;
    }

    desired += gaussian(ctx.rng, 0, WANDER_JITTER * 0.25 * ctx.dt);
    this.moveToward(ctx, desired, 1.02);
  }

  /** Heading home empty-handed to be fed. Still keeps an eye out — food on the
   * way is food, and a hungry ant that finds some eats it right there. */
  private doReturningEmpty(ctx: AntTickContext) {
    if (this.tryHarvest(ctx)) return;
    if (this.targetFood) {
      this.moveToward(ctx, angleOf(sub(this.targetFood.pos, this.pos)), 1.05);
      return;
    }

    const d = dist(this.pos, ctx.home.nestPos);
    if (d < FEED_RADIUS) {
      this.feedAtNest(ctx);
      this.homeBiasT = 0;
      this.navError = 0;
      this.resumeForaging();
      return;
    }
    this.moveToward(ctx, angleOf(sub(ctx.home.nestPos, this.pos)), 1.1);
  }

  private doReturning(ctx: AntTickContext) {
    // Path integration home, with a bit of accumulated dead-reckoning error
    // so the walk home looks organic instead of laser-straight.
    this.navError += gaussian(ctx.rng, 0, 0.05 * ctx.dt);
    this.navError = clamp(this.navError, -0.35, 0.35);
    const homeAngle = angleOf(sub(ctx.home.nestPos, this.pos)) + this.navError;

    // Trail strength scales with the size of the haul: a big find recruits
    // harder than a crumb, which is how real colonies triage food sources.
    const haulFactor = clamp(this.carryAmount / 6, 0.4, 2);
    ctx.foodTrail.deposit(
      this.pos,
      TRAIL_DEPOSIT_RATE * (0.55 + 0.45 * this.genetics.industriousness) * haulFactor * ctx.dt,
      this.colonyId,
    );

    const d = dist(this.pos, ctx.home.nestPos);
    if (d < NEST_RADIUS) {
      ctx.home.receiveForager(this.carryAmount, this.genetics.industriousness);
      this.carryAmount = 0;
      this.feedAtNest(ctx);
      this.navError = 0;
      this.resumeForaging();
      return;
    }

    this.moveToward(ctx, homeAngle, 1.05);
  }

  private doPatrolling(ctx: AntTickContext) {
    const d = dist(this.pos, ctx.home.nestPos);
    // Soldiers don't forage, so the nest is their only food: top up whenever
    // a patrol loop brings them back past the entrance.
    if (d < FEED_RADIUS && this.energy < FEED_TARGET - 10) this.feedAtNest(ctx);
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
      carryAmount: this.carryAmount,
      hungry: this.isHungry(),
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
