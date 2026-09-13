import type { ISimulation } from '../sim/facade';
import type { Caste, DeathCause, WeatherState } from '../sim/types';

/**
 * "Colony log" — the running, plain-English story of what the colonies are
 * doing to each other. Replaces the old one-at-a-time toast feed: toasts
 * vanished before you could read them and said nothing about the deaths that
 * actually drive the sim ("I have no idea how they died").
 *
 * Spammy events (births, deaths) are aggregated into one line per burst
 * ("3 workers hatched") so a 10x-speed colony doesn't flood the panel.
 *
 * Usage from the HUD:
 *
 *   const log = new ColonyLog(sim, { resolveColonyName: (id) => ... });
 *   leftColumn.appendChild(log.element);
 *   // every frame:
 *   log.update(snapshot.stats.simTime);
 */

export type LogKind = 'neutral' | 'good' | 'bad' | 'warn';

export interface ColonyLogOptions {
  /** Turn a colony id into its display name, if the UI knows it yet. */
  resolveColonyName?: (colonyId: number) => string | null;
  /** How many lines to keep in the DOM (the panel scrolls). */
  maxEntries?: number;
}

const CASTE_SINGULAR: Record<Caste, string> = {
  larva: 'larva',
  worker: 'worker',
  soldier: 'soldier',
  queen: 'queen',
  drone: 'drone',
  alateQueen: 'winged queen',
};

const CASTE_PLURAL: Record<Caste, string> = {
  larva: 'larvae',
  worker: 'workers',
  soldier: 'soldiers',
  queen: 'queens',
  drone: 'drones',
  alateQueen: 'winged queens',
};

const WEATHER_TEXT: Record<WeatherState, { icon: string; text: string }> = {
  clear: { icon: '☀️', text: 'The skies clear — good foraging weather' },
  overcast: { icon: '☁️', text: 'Clouds roll in' },
  rain: { icon: '🌧️', text: 'Rain starts falling — trails wash out faster' },
  storm: { icon: '⛈️', text: 'A storm breaks — ants scramble for the nest' },
};

/** How each death cause reads, as "<subject> <verb phrase>". */
function deathPhrase(cause: DeathCause, subject: string, plural: boolean): string {
  switch (cause) {
    case 'oldAge':
      return `${subject} died of old age`;
    case 'starvation':
      return plural ? `${subject} starved to death` : `${subject} starved to death`;
    case 'combat':
      return plural ? `${subject} fell in battle` : `${subject} was killed in battle`;
    case 'predator':
      return plural ? `${subject} were eaten by predators` : `${subject} was eaten by a predator`;
    case 'drowned':
      return plural ? `${subject} drowned` : `${subject} drowned`;
    case 'exposure':
      return `${subject} died of exposure`;
    case 'crushed':
      return plural ? `${subject} were crushed` : `${subject} was crushed`;
  }
}

const DEATH_ICON: Record<DeathCause, string> = {
  oldAge: '🕯️',
  starvation: '🍽️',
  combat: '⚔️',
  predator: '🕷️',
  drowned: '💧',
  exposure: '🥶',
  crushed: '🪨',
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function clock(simTime: number): string {
  const t = Math.max(0, Math.floor(simTime));
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}`;
}

interface Bucket {
  count: number;
  colonies: Set<number>;
  firstAt: number;
}

interface PendingName {
  el: HTMLElement;
  colonyId: number;
  render: (name: string) => string;
  addedAt: number;
}

/** Bursts are held this long (ms of wall clock) before being flushed as one
 * aggregated line, so a wave of hatchings reads as "5 workers hatched". */
const BURST_MS = 1800;
const BURST_MAX = 15;

export class ColonyLog {
  /** The finished panel element — append it wherever you want it. */
  readonly element: HTMLElement;

  private listEl: HTMLElement;
  private emptyEl: HTMLElement;
  private simTime = 0;
  private maxEntries: number;
  private resolveName: (colonyId: number) => string | null;
  private unsubscribers: (() => void)[] = [];
  private births = new Map<Caste, Bucket>();
  private deaths = new Map<string, Bucket>();
  private pendingNames: PendingName[] = [];

  constructor(sim: ISimulation, opts: ColonyLogOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 30;
    this.resolveName = opts.resolveColonyName ?? (() => null);

    const panel = document.createElement('div');
    panel.className = 'hud-panel hud-log';
    panel.style.pointerEvents = 'auto';
    const title = document.createElement('div');
    title.className = 'hud-subtitle';
    title.textContent = 'Colony log';
    panel.appendChild(title);

    this.listEl = document.createElement('div');
    this.listEl.className = 'log-list';
    panel.appendChild(this.listEl);

    this.emptyEl = document.createElement('div');
    this.emptyEl.className = 'log-empty';
    this.emptyEl.textContent = 'Watching… births, deaths and wars show up here.';
    this.listEl.appendChild(this.emptyEl);

    this.element = panel;
    this.subscribe(sim);
  }

  /** Call once per frame with the current sim time (drives timestamps and
   * flushes aggregated bursts). */
  update(simTime: number): void {
    this.simTime = simTime;
    const now = performance.now();
    this.flushBursts(now);
    this.resolvePendingNames(now);
  }

  /** Add a line from the UI itself (e.g. "you dropped food here"). */
  push(icon: string, text: string, kind: LogKind = 'neutral'): void {
    this.addEntry(icon, text, kind);
  }

  dispose(): void {
    for (const un of this.unsubscribers) un();
    this.unsubscribers = [];
  }

  // -------------------------------------------------------------------

  private subscribe(sim: ISimulation) {
    const u: (() => void)[] = [];

    u.push(
      sim.events.on('antBorn', (e) => {
        const b = this.births.get(e.caste);
        if (b) {
          b.count++;
          b.colonies.add(e.colonyId);
        } else {
          this.births.set(e.caste, { count: 1, colonies: new Set([e.colonyId]), firstAt: performance.now() });
        }
      }),
    );

    u.push(
      sim.events.on('antDied', (e) => {
        const key = `${e.caste}|${e.cause}`;
        const b = this.deaths.get(key);
        if (b) {
          b.count++;
          b.colonies.add(e.colonyId);
        } else {
          this.deaths.set(key, { count: 1, colonies: new Set([e.colonyId]), firstAt: performance.now() });
        }
      }),
    );

    u.push(
      sim.events.on('colonyFounded', (e) => {
        const rogue = e.parentColonyId !== null;
        this.addEntry(
          rogue ? '🦋' : '🐣',
          rogue ? 'A wandering queen founded a new colony' : 'A new colony was founded',
          'good',
          e.colonyId,
          (name) => (rogue ? `A wandering queen founded ${name}` : `${capitalize(name)} was founded`),
        );
      }),
    );

    u.push(
      sim.events.on('colonyCollapsed', (e) => {
        this.addEntry('💀', 'A colony has collapsed — no ants left', 'bad', e.colonyId, (name) => `${capitalize(name)} has collapsed — no ants left`);
      }),
    );

    u.push(
      sim.events.on('nuptialFlight', (e) => {
        const n = Math.max(1, Math.round(e.count));
        const tail = n === 1 ? '1 winged queen took off' : `${n} alates took off`;
        this.addEntry('🦋', `Nuptial flight — ${tail}`, 'good', e.colonyId, (name) => `Nuptial flight — ${tail} from ${name}`);
      }),
    );

    u.push(
      sim.events.on('weatherChanged', (e) => {
        const w = WEATHER_TEXT[e.weather];
        if (w) this.addEntry(w.icon, w.text, 'neutral');
      }),
    );

    u.push(
      sim.events.on('dayNightChanged', (e) => {
        this.addEntry(
          e.isDay ? '🌅' : '🌙',
          e.isDay ? 'Sunrise — foraging picks up' : 'Nightfall — most ants head home',
          'neutral',
        );
      }),
    );

    u.push(
      sim.events.on('colonyPlacementFailed', () => {
        this.addEntry('🚫', 'No room for a colony there — try open ground', 'warn');
      }),
    );

    this.unsubscribers = u;
  }

  private flushBursts(now: number) {
    for (const [caste, b] of [...this.births]) {
      if (now - b.firstAt < BURST_MS && b.count < BURST_MAX) continue;
      this.births.delete(caste);
      const subject = b.count === 1 ? `A ${CASTE_SINGULAR[caste]}` : `${b.count} ${CASTE_PLURAL[caste]}`;
      const verb = caste === 'alateQueen' || caste === 'drone' ? 'took wing in the nest' : 'hatched';
      this.addEntry('🥚', `${subject} ${verb}${this.colonySuffix(b)}`, 'good');
    }

    for (const [key, b] of [...this.deaths]) {
      if (now - b.firstAt < BURST_MS && b.count < BURST_MAX) continue;
      this.deaths.delete(key);
      const [caste, cause] = key.split('|') as [Caste, DeathCause];
      const plural = b.count !== 1;
      const subject = plural ? `${b.count} ${CASTE_PLURAL[caste]}` : `A ${CASTE_SINGULAR[caste]}`;
      this.addEntry(DEATH_ICON[cause] ?? '💀', `${deathPhrase(cause, subject, plural)}${this.colonySuffix(b)}`, 'bad');
    }
  }

  /** " in Ashfall" — only when the whole burst came from one known colony,
   * otherwise the line would be a lie. */
  private colonySuffix(b: Bucket): string {
    if (b.colonies.size !== 1) return '';
    const id = [...b.colonies][0];
    const name = this.resolveName(id);
    return name ? ` in ${name}` : '';
  }

  private resolvePendingNames(now: number) {
    if (this.pendingNames.length === 0) return;
    this.pendingNames = this.pendingNames.filter((p) => {
      const name = this.resolveName(p.colonyId);
      if (name) {
        const textEl = p.el.querySelector('.log-text');
        if (textEl) textEl.textContent = p.render(name);
        return false;
      }
      // A colony that never shows up in a snapshot (collapsed instantly) keeps
      // its generic wording rather than being retried forever.
      return now - p.addedAt < 4000;
    });
  }

  private addEntry(icon: string, text: string, kind: LogKind, colonyId?: number, render?: (name: string) => string) {
    this.emptyEl.remove();

    const row = document.createElement('div');
    row.className = `log-row log-${kind}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = clock(this.simTime);

    const ic = document.createElement('span');
    ic.className = 'log-icon';
    ic.textContent = icon;

    const body = document.createElement('span');
    body.className = 'log-text';
    body.textContent = text;

    row.append(time, ic, body);
    this.listEl.prepend(row);

    if (colonyId !== undefined && render) {
      const name = this.resolveName(colonyId);
      if (name) body.textContent = render(name);
      else this.pendingNames.push({ el: row, colonyId, render, addedAt: performance.now() });
    }

    while (this.listEl.childElementCount > this.maxEntries) {
      this.listEl.lastElementChild?.remove();
    }
  }
}
