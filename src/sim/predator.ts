import type { PredatorSnapshot } from './types';
import type { Vec2 } from './vec2';
import { add, angleOf, dist, fromAngle, sub, turnToward } from './vec2';
import { chance, range, type RNG } from './rng';
import type { Combatant } from './ant';
import type { Terrain } from './terrain';

let nextPredatorId = 1;

export type PredatorKind = 'beetle' | 'spider' | 'bird';

const PREDATOR_STATS: Record<PredatorKind, { speed: number; health: number; strength: number; senseRadius: number }> = {
  beetle: { speed: 22, health: 220, strength: 2.2, senseRadius: 90 },
  spider: { speed: 46, health: 130, strength: 2.6, senseRadius: 150 },
  bird: { speed: 90, health: 400, strength: 4.5, senseRadius: 260 },
};

/**
 * Wildlife that hunts ants. Predators wander until an ant strays into sense
 * range, then chase and attack; enough soldier retaliation drives them off
 * (or kills them — a dead predator becomes a large carcass, feeding whoever
 * gets there first).
 */
export class Predator implements Combatant {
  readonly id = nextPredatorId++;
  readonly kind: PredatorKind;
  readonly colonyId = -1;
  pos: Vec2;
  heading: number;
  health: number;
  readonly maxHealth: number;
  readonly strength: number;
  alive = true;
  state: 'wander' | 'hunt' | 'attack' | 'retreat' = 'wander';
  private target: Combatant | null = null;
  private attackCooldown = 0;
  private retreatUntil = 0;
  private wanderHeading: number;

  constructor(kind: PredatorKind, pos: Vec2, rng: RNG) {
    this.kind = kind;
    this.pos = { ...pos };
    const stats = PREDATOR_STATS[kind];
    this.health = stats.health;
    this.maxHealth = stats.health;
    this.strength = stats.strength;
    this.heading = range(rng, 0, Math.PI * 2);
    this.wanderHeading = this.heading;
  }

  update(dt: number, rng: RNG, terrain: Terrain, nearbyAnts: Combatant[], simTime: number) {
    if (!this.alive) return;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    const stats = PREDATOR_STATS[this.kind];

    if (this.state === 'retreat') {
      if (simTime > this.retreatUntil) this.state = 'wander';
    } else {
      const alive = nearbyAnts.filter((a) => a.alive);
      let nearest: Combatant | null = null;
      let bestD = stats.senseRadius;
      for (const a of alive) {
        const d = dist(a.pos, this.pos);
        if (d < bestD) {
          bestD = d;
          nearest = a;
        }
      }
      if (this.health < this.maxHealth * 0.3 && chance(rng, 0.4 * dt)) {
        this.state = 'retreat';
        this.retreatUntil = simTime + range(rng, 4, 8);
      } else if (nearest) {
        this.target = nearest;
        this.state = bestD < 16 ? 'attack' : 'hunt';
      } else {
        this.state = 'wander';
      }
    }

    let desiredHeading: number;
    let speedFactor = 1;
    switch (this.state) {
      case 'hunt':
        desiredHeading = this.target ? angleOf(sub(this.target.pos, this.pos)) : this.wanderHeading;
        speedFactor = 1.1;
        break;
      case 'attack':
        if (this.target && this.target.alive) {
          desiredHeading = angleOf(sub(this.target.pos, this.pos));
          if (dist(this.target.pos, this.pos) <= 16 && this.attackCooldown <= 0) {
            this.target.health -= this.strength * range(rng, 7, 13);
            this.attackCooldown = 0.7;
            if (this.target.health <= 0 && this.target.alive) {
              this.target.alive = false;
              this.target.pendingDeathCause = 'predator';
              this.state = 'wander';
              this.target = null;
            }
          }
        } else {
          this.state = 'wander';
          desiredHeading = this.wanderHeading;
        }
        speedFactor = 0.6;
        break;
      case 'retreat':
        desiredHeading = this.target ? angleOf(sub(this.pos, this.target.pos)) : this.wanderHeading;
        speedFactor = 1.3;
        break;
      default:
        if (chance(rng, 0.3 * dt)) this.wanderHeading += range(rng, -1, 1);
        desiredHeading = this.wanderHeading;
        speedFactor = 0.5;
    }

    const avoid = terrain.obstacleAvoidance(this.pos, 20);
    if (avoid.x !== 0 || avoid.y !== 0) desiredHeading = angleOf(avoid);

    this.heading = turnToward(this.heading, desiredHeading, 3.2 * dt);
    const speed = stats.speed * speedFactor * terrain.frictionAt(this.pos);
    const next = add(this.pos, fromAngle(this.heading, speed * dt));
    this.pos.x = Math.min(terrain.width - 2, Math.max(2, next.x));
    this.pos.y = Math.min(terrain.height - 2, Math.max(2, next.y));
  }

  toSnapshot(): PredatorSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      pos: { ...this.pos },
      heading: this.heading,
      health: this.health,
      state: this.alive ? this.state : 'dead',
    };
  }
}

export function randomPredatorKind(rng: RNG): PredatorKind {
  const roll = rng();
  if (roll < 0.5) return 'beetle';
  if (roll < 0.85) return 'spider';
  return 'bird';
}

export function predatorCarcassValue(kind: PredatorKind): number {
  return PREDATOR_STATS[kind].health * 0.6;
}
