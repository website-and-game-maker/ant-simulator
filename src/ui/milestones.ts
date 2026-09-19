/**
 * Milestones: unlockable cards that give a run a shape.
 *
 * A simulation with no goal is a screensaver. Nothing here changes the
 * simulation — every milestone is a *description* of something the colony did
 * on its own — but naming those things turns "ants are wandering around" into
 * "I'm four ants away from Swarm". It also does a quieter job: each one points
 * at a mechanic the player might not have noticed existed, which is why the
 * descriptions say what happened rather than just congratulating.
 *
 * Unlocks persist per browser, so coming back tomorrow resumes a collection
 * rather than starting over.
 */

import type { WorldSnapshot } from '../sim/types';

const STORAGE_KEY = 'formicarium-milestones-v1';

export interface Milestone {
  id: string;
  icon: string;
  title: string;
  /** What the player actually did. Present tense, concrete. */
  blurb: string;
  /** Returns true the moment it has been earned. */
  test: (snap: WorldSnapshot, ctx: MilestoneContext) => boolean;
}

export interface MilestoneContext {
  /** Peak living population seen this run, across all colonies. */
  peakAnts: number;
  /** Peak population of any single colony. */
  peakColonyAnts: number;
  /** Colonies that have collapsed this run. */
  collapses: number;
  /** Colonies founded by a nuptial flight (not by the player's tool). */
  wildFoundings: number;
  /** Nuptial flights seen. */
  flights: number;
}

const DAY_SECONDS = 150;

export const MILESTONES: readonly Milestone[] = [
  {
    id: 'first-blood',
    icon: '🥀',
    title: 'Circle of life',
    blurb: 'Your first ant died. They live about fifteen minutes; the colony outlives them all.',
    test: (s) => s.stats.deaths >= 1,
  },
  {
    id: 'brood',
    icon: '🥚',
    title: 'The queen is laying',
    blurb: 'Five larvae in the nest at once. Every one costs food the foragers had to carry home.',
    test: (s) => s.stats.totalLarvae >= 5,
  },
  {
    id: 'fifty',
    icon: '🐜',
    title: 'Fifty strong',
    blurb: 'Fifty ants alive at once — enough that the trails start to look like traffic.',
    test: (_s, c) => c.peakAnts >= 50,
  },
  {
    id: 'swarm',
    icon: '🌊',
    title: 'Swarm',
    blurb: 'Two hundred ants at once. Try the higher processing tiers if the frame rate dips.',
    test: (_s, c) => c.peakAnts >= 200,
  },
  {
    id: 'megacolony',
    icon: '🏙️',
    title: 'Megacolony',
    blurb: 'A single colony hit two hundred ants. That is a serious foraging operation.',
    test: (_s, c) => c.peakColonyAnts >= 200,
  },
  {
    id: 'week',
    icon: '📅',
    title: 'One week in',
    blurb: 'Seven days of simulated time survived. Try 50× — a week takes under three minutes.',
    test: (s) => s.stats.simTime >= DAY_SECONDS * 7,
  },
  {
    id: 'month',
    icon: '🗓️',
    title: 'A month of ants',
    blurb: 'Thirty days. Colonies have boomed, overshot their food and recovered by now.',
    test: (s) => s.stats.simTime >= DAY_SECONDS * 30,
  },
  {
    id: 'flight',
    icon: '🦋',
    title: 'Nuptial flight',
    blurb: 'A rich colony raised winged queens and sent them off to start their own.',
    test: (_s, c) => c.flights >= 1,
  },
  {
    id: 'dynasty',
    icon: '👑',
    title: 'Dynasty',
    blurb: 'A colony founded by one of your queens, not by you. That is the whole life cycle closing.',
    test: (_s, c) => c.wildFoundings >= 1,
  },
  {
    id: 'war',
    icon: '⚔️',
    title: 'Last colony standing',
    blurb: 'A rival colony was wiped out while yours kept going.',
    test: (s, c) => c.collapses >= 1 && s.colonies.some((x) => x.alive),
  },
  {
    id: 'hoard',
    icon: '🌰',
    title: 'Full larder',
    blurb: 'A colony banked 500 food. Surplus is what pays for winged queens.',
    test: (s) => s.colonies.some((c) => c.foodStore >= 500),
  },
  {
    id: 'crowded',
    icon: '🏰',
    title: 'Crowded map',
    blurb: 'Five colonies alive at the same time. Territory disputes are now inevitable.',
    test: (s) => s.colonies.filter((c) => c.alive).length >= 5,
  },
];

function loadUnlocked(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    // Storage disabled or corrupt: a fresh collection is a fine failure mode.
    return new Set();
  }
}

function saveUnlocked(ids: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* non-fatal — unlocks just won't survive the session */
  }
}

export class MilestoneTracker {
  private unlocked = loadUnlocked();
  private ctx: MilestoneContext = {
    peakAnts: 0,
    peakColonyAnts: 0,
    collapses: 0,
    wildFoundings: 0,
    flights: 0,
  };
  /** Checked on a timer rather than every frame: twelve predicates over every
   * colony, sixty times a second, for events that happen once a run. */
  private sinceCheck = 0;

  get unlockedIds(): ReadonlySet<string> {
    return this.unlocked;
  }

  get total(): number {
    return MILESTONES.length;
  }

  noteCollapse() {
    this.ctx.collapses++;
  }

  noteFlight() {
    this.ctx.flights++;
  }

  /** `parentColonyId` distinguishes a colony founded by a nuptial flight from
   * one the player dropped with the Colony tool — only the former is a dynasty. */
  noteFounding(parentColonyId: number | null) {
    if (parentColonyId !== null) this.ctx.wildFoundings++;
  }

  /** Advance and return anything newly earned this tick. */
  update(snap: WorldSnapshot, dt: number): Milestone[] {
    this.ctx.peakAnts = Math.max(this.ctx.peakAnts, snap.stats.totalAnts);
    for (const c of snap.colonies) {
      this.ctx.peakColonyAnts = Math.max(this.ctx.peakColonyAnts, c.population);
    }

    this.sinceCheck += dt;
    if (this.sinceCheck < 0.5) return [];
    this.sinceCheck = 0;

    const earned: Milestone[] = [];
    for (const m of MILESTONES) {
      if (this.unlocked.has(m.id)) continue;
      let hit = false;
      try {
        hit = m.test(snap, this.ctx);
      } catch {
        // A predicate must never be able to take the frame down with it.
        hit = false;
      }
      if (hit) {
        this.unlocked.add(m.id);
        earned.push(m);
      }
    }
    if (earned.length) saveUnlocked(this.unlocked);
    return earned;
  }

  /** Wipe progress — offered in the settings panel so a run can be replayed
   * fresh rather than starting already complete. */
  reset() {
    this.unlocked.clear();
    this.ctx = { peakAnts: 0, peakColonyAnts: 0, collapses: 0, wildFoundings: 0, flights: 0 };
    saveUnlocked(this.unlocked);
  }

  /** Called on a world restart: run-scoped counters reset, unlocks persist. */
  resetRun() {
    this.ctx = { peakAnts: 0, peakColonyAnts: 0, collapses: 0, wildFoundings: 0, flights: 0 };
  }
}
