import type { ISimulation } from '../sim/facade';
import type { AntSnapshot, AntTask, Caste, ColonySnapshot, DeathCause, WorldSnapshot } from '../sim/types';
import type { Vec2 } from '../sim/vec2';
import { PERFORMANCE_PROFILES, PERFORMANCE_TIER_ORDER } from '../sim/performanceProfiles';
import type { PerformanceTierName } from '../sim/types';
import { DEFAULT_SPECIES } from '../sim/species';
import { DAY_LENGTH_SECONDS } from '../sim/weather';
import { ColonyLog } from './colonyLog';
import { Intro, hasSeenIntro } from './intro';
import { FeedbackPanel } from './feedback';
import { Toasts } from './toasts';
import { MILESTONES, MilestoneTracker } from './milestones';
import { SpeedSlider } from './speedSlider';

export type ToolMode = 'inspect' | 'placeFood' | 'spawnPredator' | 'foundColony';

const TASK_LABELS: Record<AntTask, string> = {
  exploring: 'Exploring for food',
  trailFollowing: 'Following a scent trail',
  returningEmpty: 'Heading home',
  returningWithFood: 'Carrying food home',
  patrolling: 'Patrolling the nest',
  engaging: 'Fighting',
  fleeing: 'Fleeing danger',
  nuptialFlight: 'On its nuptial flight',
  foundingSolo: 'Founding a new colony',
};

/** One plain sentence per task, so the inspector reads as a story instead of
 * a state machine dump ("I have no idea what they were doing"). */
const TASK_STORY: Record<AntTask, string> = {
  exploring: 'Wandering more or less at random, hunting for anything edible. No trail to follow yet.',
  trailFollowing: "Locked onto another ant's scent trail, betting that it leads to food.",
  returningEmpty: 'Came up empty and is walking back to the nest to be fed.',
  returningWithFood: 'Hauling food home, laying a scent trail behind it so nestmates can find the same spot.',
  patrolling: 'Circling the nest on guard duty, watching for rivals and predators.',
  engaging: 'In a fight right now — mandibles locked with an enemy.',
  fleeing: 'Running from something bigger than it is.',
  nuptialFlight: 'Airborne on its nuptial flight, looking for ground to start a colony of its own.',
  foundingSolo: 'Digging in alone to found a new colony — the longest odds in the world.',
};

const CASTE_LABELS: Record<Caste, string> = {
  larva: 'Larva',
  worker: 'Worker',
  soldier: 'Soldier',
  queen: 'Queen',
  drone: 'Drone',
  alateQueen: 'Winged queen',
};

const CASTE_BLURB: Record<Caste, string> = {
  larva: 'A grub in the nest, being fed until it matures.',
  worker: 'The colony workhorse: forages, hauls, feeds the brood.',
  soldier: 'Bigger jaws, shorter life. Guards the nest and fights rivals.',
  queen: 'The colony mother. If she dies, no new ants are born.',
  drone: 'A male. Lives only to join a nuptial flight.',
  alateQueen: 'A future queen, waiting for a nuptial flight to found her own colony.',
};

const DEATH_LABELS: Record<DeathCause, string> = {
  oldAge: 'Old age',
  starvation: 'Starvation',
  combat: 'Combat',
  predator: 'Predators',
  drowned: 'Drowning',
  exposure: 'Exposure',
  crushed: 'Crushed',
};

const DEATH_ICONS: Record<DeathCause, string> = {
  oldAge: '🕯️',
  starvation: '🍽️',
  combat: '⚔️',
  predator: '🕷️',
  drowned: '💧',
  exposure: '🥶',
  crushed: '🪨',
};

const WEATHER_ICON: Record<string, string> = { clear: '☀️', overcast: '☁️', rain: '🌧️', storm: '⛈️' };
const TOOL_HINTS: Record<ToolMode, string> = {
  inspect: 'Click an ant or a nest to inspect it.',
  placeFood: 'Click the ground to drop food.',
  spawnPredator: 'Click open ground to summon a predator.',
  foundColony: 'Click open ground to start a rogue colony.',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * The speed ladder, with the key that selects each rung.
 *
 * 20x and 50x are new. They were previously impossible to offer honestly:
 * the engine scaled its step size with the multiplier, so a high setting
 * silently degraded the simulation rather than speeding it up. Now that the
 * step is capped, an hour of colony history in a minute is a real option —
 * and at 150 sim-seconds to the day, that is what it takes to watch a colony
 * boom, overshoot and crash inside a lunch break.
 */
const SPEED_STEPS: readonly [number, string][] = [
  [0, '⏸'],
  [1, '1×'],
  [2, '2×'],
  [5, '5×'],
  [10, '10×'],
  [20, '20×'],
  [50, '50×'],
];

/**
 * Keyboard layout.
 *
 * Digits belong to the tools: they are badged 1-4 on the bar, and a number
 * row that picks a tool is the convention every game with a hotbar already
 * taught the player. Speed steps along the ladder on `-` and `=` instead,
 * which also reads better than jumping to a specific multiplier — you nudge
 * it until the pace looks right rather than picking a number.
 */
const TOOL_ORDER: readonly ToolMode[] = ['inspect', 'placeFood', 'spawnPredator', 'foundColony'];

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toString();
}

function clockStr(seconds: number): string {
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}`;
}

function hungerWord(energy: number): { word: string; color: string } {
  if (energy < 25) return { word: 'Starving', color: '#e0605c' };
  if (energy < 55) return { word: 'Hungry', color: '#e0a95c' };
  return { word: 'Fed', color: '#7ee07e' };
}

function healthWord(health: number): { word: string; color: string } {
  if (health < 30) return { word: 'Badly hurt', color: '#e0605c' };
  if (health < 75) return { word: 'Hurt', color: '#e0a95c' };
  return { word: 'Healthy', color: '#7ee07e' };
}

function lifeStage(fraction: number): string {
  if (fraction < 0.15) return 'newly hatched';
  if (fraction < 0.5) return 'in its prime';
  if (fraction < 0.8) return 'getting old';
  return 'very old';
}

/** Expected lifespan in sim-seconds for this ant, from the species baseline
 * scaled by its own lifespan gene. Read-only use of the sim's species table. */
function expectedLifespan(ant: AntSnapshot): number {
  const base =
    ant.caste === 'larva' ? DEFAULT_SPECIES.larvaMatureTicks : DEFAULT_SPECIES.baseLifespanTicks[ant.caste];
  return Math.max(1, base * (ant.genetics.lifespan || 1));
}

interface Meter {
  row: HTMLElement;
  fill: HTMLElement;
  value: HTMLElement;
}

function buildMeter(label: string): Meter {
  const row = el('div', 'meter-row');
  row.appendChild(el('span', 'meter-label', label));
  const track = el('div', 'meter-track');
  const fill = el('div', 'meter-fill');
  track.appendChild(fill);
  row.appendChild(track);
  const value = el('span', 'meter-value', '');
  row.appendChild(value);
  return { row, fill, value };
}

function setMeter(m: Meter, value: number, max: number, color: string, text: string) {
  const pct = `${Math.max(0, Math.min(100, (value / max) * 100)).toFixed(1)}%`;
  if (m.fill.style.width !== pct) m.fill.style.width = pct;
  if (m.fill.dataset.color !== color) {
    m.fill.style.background = color;
    m.fill.dataset.color = color;
  }
  if (m.value.textContent !== text) m.value.textContent = text;
}

/** Live DOM handles for one row of the colony leaderboard. Rows are created
 * once and mutated in place — rebuilding them every tick destroyed the node
 * under the cursor, which made hover strobe and swallowed clicks. */
interface ColonyRowRefs {
  root: HTMLElement;
  dot: HTMLElement;
  name: HTMLElement;
  pop: HTMLElement;
  status: HTMLElement;
  /** Always the newest snapshot for this colony, so the click handler bound at
   * creation time can never act on stale data. */
  data: ColonySnapshot;
  lastName: string;
  lastPop: number;
  lastStatus: string;
  lastHue: number;
}

interface DeathRowRefs {
  root: HTMLElement;
  bar: HTMLElement;
  count: HTMLElement;
  lastCount: number;
}

interface HudOptions {
  onFocusPosition?: (pos: Vec2) => void;
  /** Called right after a tier switch or restart regenerates the world —
   * the renderer needs to re-apply the new tier's DPR cap and re-frame the
   * camera on the (possibly very differently sized) new world. */
  onWorldReset?: () => void;
}

/**
 * The whole HUD: settings, live stats, colony leaderboard, ant/colony
 * inspector, tool bar, colony log, and the how-it-works intro. Plain DOM, no
 * framework — see the CSS appended to src/style.css under "UI PANEL STYLES".
 *
 * Two rules keep this thing from fighting the 60fps loop:
 *  1. nothing that the pointer can touch is ever rebuilt from scratch while
 *     it is on screen — rows, meters and log lines are reconciled in place;
 *  2. heavy text writes are throttled to ~7.5Hz (see `update`).
 */
export class HUD {
  private root: HTMLElement;
  private sim: ISimulation;
  private opts: HudOptions;
  private activeTool: ToolMode = 'inspect';

  private lastUiUpdate = 0;
  private disposed = false;

  // DOM refs
  private statsEls: Record<string, HTMLElement> = {};
  private deathListEl!: HTMLElement;
  private deathTotalEl!: HTMLElement;
  private deathRows = new Map<DeathCause, DeathRowRefs>();
  private colonyListEl!: HTMLElement;
  private colonyEmptyEl!: HTMLElement;
  private colonyRows = new Map<number, ColonyRowRefs>();
  private focusedColonyId: number | null = null;
  private colonyListHot = false;
  private inspectorEl!: HTMLElement;
  private toolButtons = {} as Record<ToolMode, HTMLButtonElement>;
  private toolHintEl!: HTMLElement;
  private toolHintTimer = 0;
  private settingsPanelEl!: HTMLElement;
  private settingsWrapEl!: HTMLElement;
  private restartBtn!: HTMLButtonElement;
  private confirmingRestart = false;
  private speedSlider!: SpeedSlider;
  private unsubscribers: (() => void)[] = [];

  private log!: ColonyLog;
  private intro!: Intro;
  private feedback!: FeedbackPanel;
  readonly toasts = new Toasts();
  readonly milestones = new MilestoneTracker();
  private milestoneGridEl!: HTMLElement;
  private milestoneCountEl!: HTMLElement;
  private lastMilestoneCount = -1;
  /** Colony names survive here after a colony dies, so the log can still say
   * who collapsed. */
  private colonyNames = new Map<number, string>();

  // Inspector state (built once, reconciled every frame)
  private insp!: {
    antView: HTMLElement;
    colonyView: HTMLElement;
    caste: HTMLElement;
    casteBlurb: HTMLElement;
    antColonyDot: HTMLElement;
    antColonyName: HTMLElement;
    task: HTMLElement;
    story: HTMLElement;
    carrying: HTMLElement;
    energy: Meter;
    health: Meter;
    life: Meter;
    lifeNote: HTMLElement;
    genetics: Record<string, Meter>;
    colonyName: HTMLElement;
    colonyStatus: HTMLElement;
    colonyFacts: HTMLElement;
    colonyCastes: HTMLElement;
  };

  constructor(root: HTMLElement, sim: ISimulation, opts: HudOptions = {}) {
    this.root = root;
    this.sim = sim;
    this.opts = opts;
    this.build();
    this.wireEvents();
  }

  getActiveTool(): ToolMode {
    return this.activeTool;
  }
  setActiveTool(tool: ToolMode) {
    this.activeTool = tool;
    for (const [key, btn] of Object.entries(this.toolButtons)) btn.classList.toggle('active', key === tool);
    this.setToolHint(TOOL_HINTS[tool]);
  }

  /** Open the how-it-works overlay (also wired to the "?" button). */
  /** Open the feedback panel from outside the HUD (the `f` shortcut lives on
   * the HUD's own handler; this is for anything else that wants to invite a
   * report, such as an error boundary). */
  showFeedback() {
    this.openFeedback();
  }

  /** Two modals at once is never right: reading the intro and then reaching
   * for the feedback button is a normal thing to do, so the intro steps
   * aside rather than trapping the click. */
  private openFeedback() {
    this.intro.close();
    this.feedback.open();
  }

  showIntro(pane = 0) {
    this.intro.open(pane);
  }

  update(snapshot: WorldSnapshot) {
    if (this.disposed) return;
    const now = performance.now();
    for (const c of snapshot.colonies) this.colonyNames.set(c.id, c.name);
    this.updateInspector(snapshot);
    this.log.update(snapshot.stats.simTime);
    if (now - this.lastUiUpdate < 130) return; // throttle heavier DOM writes to ~7.5Hz
    this.lastUiUpdate = now;
    this.updateStats(snapshot);
    this.updateColonyList(snapshot);
  }

  dispose() {
    this.disposed = true;
    for (const un of this.unsubscribers) un();
    this.log?.dispose();
    this.intro?.dispose();
    this.feedback?.dispose();
    this.toasts?.dispose();
    this.root.querySelector('.hud-root')?.remove();
  }

  // -------------------------------------------------------------------

  private build() {
    const container = el('div', 'hud-root');
    container.style.pointerEvents = 'none';
    this.root.appendChild(container);

    // Left column: one flex stack so panels can never sit on top of each
    // other no matter how tall their contents get (the old hard-coded
    // `top: 230px` let the colony box cover the bottom of the stats box).
    const left = el('div', 'hud-left');
    this.log = new ColonyLog(this.sim, { resolveColonyName: (id) => this.colonyNames.get(id) ?? null });
    left.append(this.buildStatsPanel(), this.log.element, this.buildColonyPanel());
    container.appendChild(left);

    container.appendChild(this.buildTopRight());
    container.appendChild(this.buildInspector());
    container.appendChild(this.buildToolbar());

    this.intro = new Intro();
    container.appendChild(this.intro.element);
    this.feedback = new FeedbackPanel(this.sim);
    container.appendChild(this.feedback.element);
    container.appendChild(this.toasts.element);
    if (!hasSeenIntro()) this.intro.open();

    this.setActiveTool('inspect');
  }

  private wireEvents() {
    // The log owns the narration now; the HUD only reacts to the one event
    // that needs immediate, in-place feedback where the player is looking.
    const un = this.sim.events.on('colonyPlacementFailed', () =>
      this.setToolHint('🚫 No room for a colony there — try open ground, away from the edge.', 'warn', 3200),
    );
    this.unsubscribers.push(un);

    window.addEventListener('keydown', this.onKeyDown);
    this.unsubscribers.push(() => window.removeEventListener('keydown', this.onKeyDown));

    const onDocPointerDown = (e: PointerEvent) => {
      if (this.settingsPanelEl.classList.contains('hidden')) return;
      if (!this.settingsWrapEl.contains(e.target as Node)) this.settingsPanelEl.classList.add('hidden');
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    this.unsubscribers.push(() => document.removeEventListener('pointerdown', onDocPointerDown));
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      this.sim.togglePause();
      this.syncSpeedUI();
    } else if (e.key === '?') {
      e.preventDefault();
      this.intro.open();
    } else if (e.key.toLowerCase() === 'f') {
      e.preventDefault();
      this.openFeedback();
    } else if (e.key >= '1' && e.key <= '4') {
      const tool = TOOL_ORDER[Number(e.key) - 1];
      if (tool) {
        e.preventDefault();
        this.setActiveTool(tool);
      }
    } else if (e.key === '-' || e.key === '_' || e.key === '=' || e.key === '+') {
      e.preventDefault();
      this.nudgeSpeed(e.key === '=' || e.key === '+' ? 1 : -1);
    }
  };

  /**
   * Step one rung along the speed ladder.
   *
   * Pause is rung zero, so stepping down from 1x pauses and stepping up from
   * a pause resumes at 1x — which is what "slower" and "faster" mean at the
   * ends of the range.
   */
  private nudgeSpeed(direction: 1 | -1) {
    const current = this.sim.getSpeed();
    let i = SPEED_STEPS.findIndex((sp) => sp[0] === current);
    // A speed set from elsewhere may not sit exactly on a rung; snap to the
    // nearest one before stepping so the first press isn't a no-op.
    if (i < 0) {
      i = SPEED_STEPS.reduce(
        (best, sp, idx) =>
          Math.abs(sp[0] - current) < Math.abs(SPEED_STEPS[best][0] - current) ? idx : best,
        0,
      );
    }
    const next = Math.min(SPEED_STEPS.length - 1, Math.max(0, i + direction));
    this.sim.setSpeed(SPEED_STEPS[next][0]);
    this.syncSpeedUI();
  }

  // --- Stats -----------------------------------------------------------

  private buildStatsPanel(): HTMLElement {
    const panel = el('div', 'hud-panel hud-stats');
    panel.style.pointerEvents = 'auto';

    const titleRow = el('div', 'hud-title-row');
    titleRow.appendChild(el('div', 'hud-title', '🐜 Formicarium'));
    // FPS used to sit in the stats list as a full labelled row, level with
    // "Ants" and "Colonies" — a frame-rate counter given the same visual
    // weight as the thing the game is actually about. It's still worth
    // having on screen (a slow machine wants to know why), just tucked into
    // the corner where a diagnostic belongs rather than the scoreboard.
    this.statsEls['fps'] = el('span', 'hud-fps', '—');
    titleRow.appendChild(this.statsEls['fps']);
    panel.appendChild(titleRow);

    // The headline number: not a row among rows, a scoreboard digit. This is
    // the one figure a glance at the panel should answer first.
    const headline = el('div', 'stat-headline');
    this.statsEls['ants'] = el('span', 'stat-headline-value', '—');
    headline.append(this.statsEls['ants'], el('span', 'stat-headline-label', 'ants alive'));
    panel.appendChild(headline);

    // Everything else: a compact 2-up grid of small stat chips instead of a
    // tall single-column list of icon/label/value rows. Same information,
    // roughly half the height, and it reads as a stat card rather than a
    // console dump.
    const grid = el('div', 'stat-grid');
    const chip = (key: string, icon: string, label: string) => {
      const c = el('div', 'stat-chip');
      const value = el('span', 'stat-chip-value', '—');
      this.statsEls[key] = value;
      c.append(el('span', 'stat-chip-icon', icon), value);
      c.title = label;
      grid.appendChild(c);
      return c;
    };
    chip('larvae', '🥚', 'Larvae in the nest');
    chip('colonies', '🏰', 'Colonies alive');
    chip('predators', '🕷️', 'Predators on the map');
    chip('netgrowth', '📈', 'Births minus deaths per minute');
    panel.appendChild(grid);

    const timeRow = el('div', 'stat-timerow');
    this.statsEls['clock'] = el('span', 'stat-time', '—');
    this.statsEls['weather'] = el('span', 'stat-weather', '—');
    timeRow.append(this.statsEls['clock'], this.statsEls['weather']);
    panel.appendChild(timeRow);

    const head = el('div', 'hud-subtitle small deaths-head');
    head.appendChild(el('span', undefined, 'How they died'));
    this.deathTotalEl = el('span', 'deaths-total', '0');
    head.appendChild(this.deathTotalEl);
    panel.appendChild(head);

    this.deathListEl = el('div', 'death-list');
    this.deathListEl.appendChild(el('div', 'death-empty', 'Nobody has died yet.'));
    panel.appendChild(this.deathListEl);

    panel.appendChild(this.buildMilestoneShelf());

    return panel;
  }

  /**
   * A visible shelf of what there is to find.
   *
   * The toasts announce a milestone the moment it lands, then vanish — which
   * is the right behaviour for a notification and the wrong one for a
   * collection. Locked entries are shown as silhouettes with their hint
   * readable but their name hidden: enough to suggest there is something
   * there to go after, not so much that it is a checklist to grind.
   */
  private buildMilestoneShelf(): HTMLElement {
    const wrap = el('div', 'ms-wrap');
    const head = el('div', 'hud-subtitle small deaths-head');
    head.appendChild(el('span', undefined, 'Milestones'));
    this.milestoneCountEl = el('span', 'deaths-total', `0/${this.milestones.total}`);
    head.appendChild(this.milestoneCountEl);
    wrap.appendChild(head);

    this.milestoneGridEl = el('div', 'ms-grid');
    wrap.appendChild(this.milestoneGridEl);
    this.renderMilestoneShelf();
    return wrap;
  }

  private renderMilestoneShelf() {
    const unlocked = this.milestones.unlockedIds;
    if (this.lastMilestoneCount === unlocked.size && this.milestoneGridEl.childElementCount > 0) return;
    this.lastMilestoneCount = unlocked.size;

    this.milestoneGridEl.textContent = '';
    for (const m of MILESTONES) {
      const got = unlocked.has(m.id);
      // Locked cells used to show a literal "?" — which reads as an error
      // state or an unfinished feature, not a thing waiting to be found. An
      // empty dashed slot is the same "not yet" without looking broken —
      // it's the trophy-case convention, not the placeholder-text one.
      const cell = el('div', `ms-cell${got ? ' got' : ''}`, got ? m.icon : '');
      cell.title = got ? `${m.title} — ${m.blurb}` : 'Not yet found';
      cell.setAttribute('aria-label', got ? m.title : 'Locked milestone');
      this.milestoneGridEl.appendChild(cell);
    }
    this.milestoneCountEl.textContent = `${unlocked.size}/${this.milestones.total}`;
  }

  private updateStats(s: WorldSnapshot) {
    const set = (key: string, text: string) => {
      const e = this.statsEls[key];
      if (e && e.textContent !== text) e.textContent = text;
    };
    set('ants', fmt(s.stats.totalAnts));
    set('larvae', fmt(s.stats.totalLarvae));
    set('colonies', fmt(s.stats.totalColonies));
    set('predators', fmt(s.stats.totalPredators));
    // Births and deaths per minute used to be two separate full rows. One net
    // figure, signed, says the same thing a glance actually needs — "is the
    // colony growing" — without asking for mental subtraction.
    const net = Math.round(s.stats.birthsPerMinute - s.stats.deathsPerMinute);
    set('netgrowth', `${net > 0 ? '+' : ''}${net}/min`);
    set('fps', `⚡${Math.round(s.stats.fps)}`);

    // The clock starts at midday, so the day number has to be offset by half a
    // cycle — without it the date rolled over at noon and you'd watch "Day 2"
    // appear in the middle of the afternoon.
    const day = Math.floor((s.stats.simTime + DAY_LENGTH_SECONDS / 2) / DAY_LENGTH_SECONDS) + 1;
    const hh = Math.floor(s.timeOfDay * 24)
      .toString()
      .padStart(2, '0');
    const mm = Math.floor((s.timeOfDay * 24 * 60) % 60)
      .toString()
      .padStart(2, '0');
    set('clock', `Day ${day}, ${hh}:${mm}`);
    set('weather', `${WEATHER_ICON[s.weather] ?? ''} ${s.weather}`);

    // Honest speed badge: if the engine hit its per-frame budget it is not
    // actually delivering the multiplier on the button, and saying so beats
    // letting someone wonder why 50x looks like 20x.
    // Milestones are evaluated here rather than on the event bus because most
    // of them are thresholds on world state ("fifty ants at once"), not
    // moments — there is no event for "the population just crossed 50".
    for (const earned of this.milestones.update(s, 1 / 60)) {
      this.toasts.show({
        icon: earned.icon,
        title: earned.title,
        body: earned.blurb,
        tone: 'milestone',
      });
      this.renderMilestoneShelf();
    }

    const load = this.sim.getStepLoad();
    const throttled = load.requested > 0 && load.taken < load.requested * 0.9;
    this.speedSlider.setThrottle(throttled ? Math.round((load.taken / load.requested) * 100) : null);
    // Cheap and self-correcting: keeps the slider truthful even if the
    // simulation's speed is ever changed by something other than the slider
    // or the keyboard shortcuts.
    this.syncSpeedUI();

    this.updateDeathList(s);
  }

  /** Deaths-by-cause used to be a single line of 10px grey text tucked under
   * everything else (and, thanks to the old layout, usually covered). It is
   * now a ranked mini-chart: "they starved" should be obvious at a glance. */
  private updateDeathList(s: WorldSnapshot) {
    const causes = Object.entries(s.stats.deathsByCause).filter(([, v]) => v > 0) as [DeathCause, number][];
    const total = causes.reduce((sum, [, v]) => sum + v, 0);
    if (this.deathTotalEl.textContent !== String(total)) this.deathTotalEl.textContent = String(total);

    const empty = this.deathListEl.querySelector('.death-empty');
    if (causes.length === 0) {
      if (!empty) this.deathListEl.appendChild(el('div', 'death-empty', 'Nobody has died yet.'));
      for (const [cause, refs] of this.deathRows) {
        refs.root.remove();
        this.deathRows.delete(cause);
      }
      return;
    }
    empty?.remove();

    causes.sort((a, b) => b[1] - a[1]);
    const max = causes[0][1];

    for (const [cause, count] of causes) {
      let refs = this.deathRows.get(cause);
      if (!refs) {
        const root = el('div', 'death-row');
        root.append(el('span', 'death-icon', DEATH_ICONS[cause]), el('span', 'death-cause', DEATH_LABELS[cause]));
        const track = el('span', 'death-track');
        const bar = el('i', 'death-bar');
        track.appendChild(bar);
        const countEl = el('span', 'death-count', '0');
        root.append(track, countEl);
        refs = { root, bar, count: countEl, lastCount: -1 };
        this.deathRows.set(cause, refs);
        this.deathListEl.appendChild(root);
      }
      if (refs.lastCount !== count) {
        refs.count.textContent = String(count);
        refs.lastCount = count;
      }
      refs.bar.style.width = `${Math.max(6, (count / max) * 100)}%`;
      refs.root.title = `${DEATH_LABELS[cause]}: ${count} of ${total} deaths`;
    }

    for (const [cause, refs] of this.deathRows) {
      if (!causes.some(([c]) => c === cause)) {
        refs.root.remove();
        this.deathRows.delete(cause);
      }
    }

    // Rank order, moved (not rebuilt) so nothing under the cursor disappears.
    causes.forEach(([cause], i) => {
      const refs = this.deathRows.get(cause)!;
      const at = this.deathListEl.children[i];
      if (at !== refs.root) this.deathListEl.insertBefore(refs.root, at ?? null);
    });
  }

  // --- Colony leaderboard -----------------------------------------------

  private buildColonyPanel(): HTMLElement {
    const panel = el('div', 'hud-panel hud-colonies');
    panel.style.pointerEvents = 'auto';
    const head = el('div', 'hud-subtitle', 'Colonies');
    panel.appendChild(head);
    panel.appendChild(el('div', 'panel-hint', 'Click one to centre the camera on its nest.'));
    this.colonyListEl = el('div', 'colony-list');
    this.colonyEmptyEl = el('div', 'colony-empty', 'No colonies left…');

    // While the pointer is inside the list we stop re-ranking rows: a row that
    // slides out from under the cursor mid-click is the other half of why
    // clicking a colony felt broken.
    this.colonyListEl.addEventListener('pointerenter', () => (this.colonyListHot = true));
    this.colonyListEl.addEventListener('pointerleave', () => (this.colonyListHot = false));

    panel.appendChild(this.colonyListEl);
    return panel;
  }

  private updateColonyList(s: WorldSnapshot) {
    const colonies = [...s.colonies].sort((a, b) => b.population - a.population || a.id - b.id).slice(0, 12);

    // 1. Create-or-update, never rebuild.
    const keep = new Set<number>();
    for (const c of colonies) {
      keep.add(c.id);
      let refs = this.colonyRows.get(c.id);
      if (!refs) {
        refs = this.createColonyRow(c);
        this.colonyRows.set(c.id, refs);
        this.colonyListEl.appendChild(refs.root);
      }
      refs.data = c;
      if (refs.lastName !== c.name) {
        refs.name.textContent = c.name;
        refs.root.title = `${c.name} — click to centre the camera on its nest`;
        refs.lastName = c.name;
      }
      const pop = Math.round(c.population);
      if (refs.lastPop !== pop) {
        refs.pop.textContent = fmt(pop);
        refs.lastPop = pop;
      }
      const status = !c.alive ? '☠' : c.queenAlive ? '♛' : '⚠';
      if (refs.lastStatus !== status) {
        refs.status.textContent = status;
        refs.status.title = !c.alive ? 'Collapsed' : c.queenAlive ? 'Queen alive' : 'No queen — this colony is doomed';
        refs.status.classList.toggle('warn', c.alive && !c.queenAlive);
        refs.lastStatus = status;
      }
      if (refs.lastHue !== c.colorHue) {
        refs.dot.style.background = `hsl(${c.colorHue}, 75%, 55%)`;
        refs.lastHue = c.colorHue;
      }
      refs.root.classList.toggle('active', this.focusedColonyId === c.id);
    }

    // 2. Drop rows for colonies that are gone.
    for (const [id, refs] of this.colonyRows) {
      if (keep.has(id)) continue;
      refs.root.remove();
      this.colonyRows.delete(id);
    }

    // 3. Empty state as a sibling node, so reordering only ever sees rows.
    if (colonies.length === 0) {
      if (!this.colonyEmptyEl.isConnected) this.colonyListEl.appendChild(this.colonyEmptyEl);
      return;
    }
    this.colonyEmptyEl.remove();

    // 4. Re-rank by moving existing nodes — but never while the pointer is in
    //    the list, or the row the player is aiming at walks away mid-click.
    if (this.colonyListHot || this.colonyListEl.matches(':hover')) return;
    colonies.forEach((c, i) => {
      const refs = this.colonyRows.get(c.id)!;
      const at = this.colonyListEl.children[i];
      if (at !== refs.root) this.colonyListEl.insertBefore(refs.root, at ?? null);
    });
  }

  private createColonyRow(c: ColonySnapshot): ColonyRowRefs {
    const root = el('div', 'colony-row');
    root.setAttribute('role', 'button');
    root.tabIndex = 0;
    const dot = el('span', 'colony-dot');
    const name = el('span', 'colony-name');
    const pop = el('span', 'colony-pop');
    const status = el('span', 'colony-status');
    root.append(dot, name, pop, status);

    const refs: ColonyRowRefs = {
      root,
      dot,
      name,
      pop,
      status,
      data: c,
      lastName: '',
      lastPop: -1,
      lastStatus: '',
      lastHue: -1,
    };

    // Bound once, at creation. It reads `refs.data`, which `updateColonyList`
    // keeps fresh, so the handler can never close over a stale snapshot.
    const activate = () => this.focusColony(refs.data);
    root.addEventListener('click', activate);
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        activate();
      }
    });
    return refs;
  }

  private focusColony(c: ColonySnapshot) {
    this.focusedColonyId = c.id;
    this.opts.onFocusPosition?.(c.nestPos);
    for (const [id, refs] of this.colonyRows) refs.root.classList.toggle('active', id === c.id);
    // Handy for tests and for anyone wiring extra behaviour to the selection.
    this.colonyListEl.dataset.focusedColony = String(c.id);
    this.colonyListEl.dataset.focusCount = String((Number(this.colonyListEl.dataset.focusCount) || 0) + 1);
  }

  // --- Top-right cluster: help + settings ---------------------------------

  private buildTopRight(): HTMLElement {
    const wrap = el('div', 'hud-topright');
    wrap.style.pointerEvents = 'auto';

    const icons = el('div', 'hud-topright-icons');

    const help = el('button', 'hud-help-btn');
    help.type = 'button';
    help.innerHTML = '<span class="hud-help-mark">?</span><span class="hud-help-label">How it works</span>';
    help.title = 'What am I looking at? (press ?)';
    help.setAttribute('aria-label', 'How it works');
    help.addEventListener('click', () => this.intro.open());

    // Deliberately a peer of "How it works" rather than buried in settings.
    // Feedback nobody can find is feedback nobody sends.
    const feedbackBtn = el('button', 'hud-icon-btn hud-feedback-btn', '💬');
    feedbackBtn.type = 'button';
    feedbackBtn.title = 'Send feedback — an idea, a bug, or what you thought';
    feedbackBtn.setAttribute('aria-label', 'Send feedback');
    feedbackBtn.addEventListener('click', () => this.openFeedback());

    icons.append(help, feedbackBtn, this.buildSettingsPanel());

    // The speed control docks under the icon row rather than in the bottom
    // toolbar. A vertical slider has a position and a direction — "up" is
    // unmistakably "faster" — which a row of pill buttons never quite
    // communicated, and it frees the bottom bar to be just the four tools.
    this.speedSlider = new SpeedSlider({
      steps: SPEED_STEPS.map(([multiplier, label]) => ({ multiplier, label })),
      onChange: (multiplier) => this.sim.setSpeed(multiplier),
    });

    wrap.append(icons, this.speedSlider.element);
    return wrap;
  }

  // --- Settings ----------------------------------------------------------

  private buildSettingsPanel(): HTMLElement {
    const wrap = el('div', 'hud-settings-wrap');
    this.settingsWrapEl = wrap;
    const toggle = el('button', 'hud-icon-btn hud-settings-toggle', '⚙️');
    toggle.title = 'Speed, view and graphics settings';
    const panel = el('div', 'hud-panel hud-settings hidden');
    this.settingsPanelEl = panel;
    toggle.addEventListener('click', () => panel.classList.toggle('hidden'));

    panel.appendChild(el('div', 'hud-subtitle', 'View'));
    const viewWrap = el('div', 'view-toggle');
    const surfaceBtn = el('button', 'view-btn', 'Surface');
    const undergroundBtn = el('button', 'view-btn', 'Underground');
    const refreshView = () => {
      surfaceBtn.classList.toggle('active', this.sim.getView() === 'surface');
      undergroundBtn.classList.toggle('active', this.sim.getView() === 'underground');
    };
    surfaceBtn.addEventListener('click', () => {
      this.sim.setView('surface');
      refreshView();
    });
    undergroundBtn.addEventListener('click', () => {
      this.sim.setView('underground');
      refreshView();
    });
    refreshView();
    viewWrap.append(surfaceBtn, undergroundBtn);
    panel.appendChild(viewWrap);
    panel.appendChild(el('div', 'panel-hint', 'Underground shows the nest chambers, queen and larvae.'));

    panel.appendChild(el('div', 'hud-subtitle', 'Processing power'));
    const tierWrap = el('div', 'tier-list');
    for (const tier of PERFORMANCE_TIER_ORDER) {
      const p = PERFORMANCE_PROFILES[tier];
      const btn = el('button', 'tier-btn');
      btn.appendChild(el('div', 'tier-label', p.label));
      btn.appendChild(el('div', 'tier-blurb', p.blurb));
      btn.addEventListener('click', () => {
        this.sim.setTier(tier);
        this.refreshTierButtons(tierWrap);
        this.opts.onWorldReset?.();
      });
      btn.dataset.tier = tier;
      tierWrap.appendChild(btn);
    }
    panel.appendChild(tierWrap);
    this.refreshTierButtons(tierWrap);

    this.restartBtn = el('button', 'restart-btn', 'Restart simulation');
    this.restartBtn.addEventListener('click', () => {
      if (!this.confirmingRestart) {
        this.confirmingRestart = true;
        this.restartBtn.textContent = 'Click again to confirm';
        setTimeout(() => {
          this.confirmingRestart = false;
          this.restartBtn.textContent = 'Restart simulation';
        }, 3000);
        return;
      }
      this.sim.restart();
      this.confirmingRestart = false;
      this.restartBtn.textContent = 'Restart simulation';
      this.opts.onWorldReset?.();
    });
    panel.appendChild(this.restartBtn);

    wrap.append(toggle, panel);
    return wrap;
  }

  private refreshTierButtons(wrap: HTMLElement) {
    const active = this.sim.getTier();
    wrap.querySelectorAll<HTMLButtonElement>('.tier-btn').forEach((b) => b.classList.toggle('active', b.dataset.tier === active));
  }

  /** The simulation's speed is the single source of truth; this pulls the
   * slider's displayed position into line with it. Called after anything
   * that can change speed through a path other than dragging the slider
   * itself — Space, the -/= shortcuts, or a fresh boot. */
  private syncSpeedUI() {
    this.speedSlider.syncFromMultiplier(this.sim.getSpeed());
  }

  // --- Inspector -----------------------------------------------------------

  private buildInspector(): HTMLElement {
    const panel = el('div', 'hud-panel hud-inspector hidden');
    panel.style.pointerEvents = 'auto';
    this.inspectorEl = panel;

    const closeBtn = el('button', 'inspector-close', '✕');
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => this.sim.clearSelection());
    panel.appendChild(closeBtn);

    // --- ant view ---
    const antView = el('div', 'inspector-view hidden');
    const caste = el('div', 'hud-subtitle');
    const casteBlurb = el('div', 'insp-blurb');
    const colonyLine = el('div', 'insp-colony');
    const antColonyDot = el('span', 'colony-dot');
    const antColonyName = el('span', 'insp-colony-name');
    colonyLine.append(antColonyDot, antColonyName);
    const task = el('div', 'inspector-task');
    const story = el('div', 'insp-story');
    const carrying = el('div', 'insp-carry hidden');
    const energy = buildMeter('Hunger');
    const health = buildMeter('Health');
    const life = buildMeter('Life');
    const lifeNote = el('div', 'insp-note');
    antView.append(caste, casteBlurb, colonyLine, task, story, carrying, energy.row, health.row, life.row, lifeNote);

    antView.appendChild(el('div', 'hud-subtitle small', 'Genetics'));
    const genetics: Record<string, Meter> = {};
    for (const [key, label] of [
      ['speed', 'Speed'],
      ['strength', 'Strength'],
      ['senseRadius', 'Sense'],
      ['lifespan', 'Lifespan'],
      ['aggression', 'Aggression'],
      ['industriousness', 'Work drive'],
    ] as [string, string][]) {
      const m = buildMeter(label);
      genetics[key] = m;
      antView.appendChild(m.row);
    }
    panel.appendChild(antView);

    // --- colony view ---
    const colonyView = el('div', 'inspector-view hidden');
    const colonyName = el('div', 'hud-subtitle');
    const colonyStatus = el('div', 'inspector-task');
    const colonyFacts = el('div', 'insp-facts');
    const colonyCastes = el('div', 'caste-bars');
    colonyView.append(colonyName, colonyStatus, colonyFacts, colonyCastes);
    panel.appendChild(colonyView);

    this.insp = {
      antView,
      colonyView,
      caste,
      casteBlurb,
      antColonyDot,
      antColonyName,
      task,
      story,
      carrying,
      energy,
      health,
      life,
      lifeNote,
      genetics,
      colonyName,
      colonyStatus,
      colonyFacts,
      colonyCastes,
    };
    return panel;
  }

  private updateInspector(s: WorldSnapshot) {
    const ant = this.sim.getSelectedAnt();
    const colony = ant ? null : this.sim.getSelectedColony();
    if (!ant && !colony) {
      this.inspectorEl.classList.add('hidden');
      return;
    }
    this.inspectorEl.classList.remove('hidden');
    const i = this.insp;
    i.antView.classList.toggle('hidden', !ant);
    i.colonyView.classList.toggle('hidden', !!ant);

    const setText = (e: HTMLElement, text: string) => {
      if (e.textContent !== text) e.textContent = text;
    };

    if (ant) {
      setText(i.caste, CASTE_LABELS[ant.caste]);
      setText(i.casteBlurb, CASTE_BLURB[ant.caste]);

      const home = s.colonies.find((c) => c.id === ant.colonyId);
      const hue = home ? home.colorHue : ant.genetics.hue;
      const dotColor = `hsl(${hue}, 75%, 55%)`;
      if (i.antColonyDot.dataset.color !== dotColor) {
        i.antColonyDot.style.background = dotColor;
        i.antColonyDot.dataset.color = dotColor;
      }
      setText(i.antColonyName, home ? `${home.name} · ${home.population} ants` : 'Colonyless');

      setText(i.task, TASK_LABELS[ant.task]);
      setText(i.story, TASK_STORY[ant.task]);

      const carryAmount = ant.carryAmount;
      const carryText = ant.carrying
        ? `🌰 Carrying food${carryAmount ? ` (${carryAmount.toFixed(1)} units)` : ''} back to the nest.`
        : '';
      i.carrying.classList.toggle('hidden', !ant.carrying);
      if (ant.carrying) setText(i.carrying, carryText);

      const hunger = hungerWord(ant.energy);
      setMeter(i.energy, ant.energy, 100, hunger.color, `${hunger.word} ${Math.round(ant.energy)}%`);
      const hp = healthWord(ant.health);
      setMeter(i.health, ant.health, 100, hp.color, `${hp.word} ${Math.round(ant.health)}%`);

      const expected = expectedLifespan(ant);
      const frac = ant.age / expected;
      setMeter(i.life, frac, 1, frac > 0.8 ? '#e0a95c' : '#8fd166', `${clockStr(ant.age)} / ~${clockStr(expected)}`);
      setText(
        i.lifeNote,
        `${clockStr(ant.age)} old — ${lifeStage(frac)}. A ${CASTE_LABELS[ant.caste].toLowerCase()} lives about ${clockStr(expected)} of sim time.`,
      );

      const g = ant.genetics;
      setMeter(i.genetics.speed, g.speed, 1.4, '#6fb7ff', g.speed.toFixed(2));
      setMeter(i.genetics.strength, g.strength, 1.4, '#ff9d6f', g.strength.toFixed(2));
      setMeter(i.genetics.senseRadius, g.senseRadius, 1.3, '#c9a2ff', g.senseRadius.toFixed(2));
      setMeter(i.genetics.lifespan, g.lifespan, 1.3, '#a2ffcf', g.lifespan.toFixed(2));
      setMeter(i.genetics.aggression, g.aggression, 1, '#ff6f6f', g.aggression.toFixed(2));
      setMeter(i.genetics.industriousness, g.industriousness, 1, '#ffe36f', g.industriousness.toFixed(2));
    } else if (colony) {
      setText(i.colonyName, colony.name);
      setText(i.colonyStatus, colony.alive ? (colony.queenAlive ? 'Thriving — the queen is laying' : 'Queenless — no new ants will hatch') : 'Collapsed');
      const facts = [
        `Population ${colony.population} · Food store ${Math.round(colony.foodStore)}`,
        `Generation ${colony.generation} · Territory ${Math.round(colony.territoryRadius)}u`,
        `Founded at ${clockStr(colony.founded)}`,
      ];
      if (colony.foodCollected !== undefined) facts.push(`Food hauled home so far: ${Math.round(colony.foodCollected)}`);
      setText(i.colonyFacts, facts.join('\n'));

      const parts = (['queen', 'worker', 'soldier', 'drone', 'alateQueen'] as Caste[])
        .map((c) => [c, colony.populationByCaste[c] ?? 0] as const)
        .filter(([, n]) => n > 0)
        .map(([c, n]) => `${CASTE_LABELS[c]}: ${n}`);
      setText(i.colonyCastes, parts.join('  ·  '));
    }
  }

  // --- Tool bar -----------------------------------------------------------

  private buildToolbar(): HTMLElement {
    const wrap = el('div', 'hud-toolbar-wrap');
    wrap.style.pointerEvents = 'auto';
    const bar = el('div', 'hud-toolbar');
    const tools: [ToolMode, string, string][] = [
      ['inspect', '🔍', 'Inspect'],
      ['placeFood', '🌰', 'Food'],
      ['spawnPredator', '🕷️', 'Predator'],
      ['foundColony', '👑', 'Colony'],
    ];
    for (const [mode, icon, label] of tools) {
      const btn = el('button', 'tool-btn');
      btn.type = 'button';
      btn.innerHTML = `<span class="tool-icon">${icon}</span><span class="tool-label">${label}</span>`;
      btn.title = `${label} (press ${tools.indexOf(tools.find((t) => t[0] === mode)!) + 1}) — ${TOOL_HINTS[mode]}`;
      btn.setAttribute('aria-label', label);
      btn.dataset.tool = mode;
      btn.addEventListener('click', () => this.setActiveTool(mode));
      this.toolButtons[mode] = btn;
      bar.appendChild(btn);
    }
    // Number-key hints on the tools, so the shortcuts are discoverable
    // without reading a manual.
    tools.forEach(([mode], i) => {
      const btn = this.toolButtons[mode];
      if (btn) btn.appendChild(el('span', 'tool-key', String(i + 1)));
    });

    this.toolHintEl = el('div', 'tool-hint');
    wrap.append(bar, this.toolHintEl);
    return wrap;
  }

  /** The hint line under the tool bar doubles as the place for transient
   * feedback ("no room for a colony there"), right where the player just
   * clicked — no floating toast to chase or to cover the panels. */
  private setToolHint(text: string, kind: 'normal' | 'warn' = 'normal', revertAfterMs = 0) {
    window.clearTimeout(this.toolHintTimer);
    this.toolHintEl.textContent = text;
    this.toolHintEl.classList.toggle('warn', kind === 'warn');
    if (revertAfterMs > 0) {
      this.toolHintTimer = window.setTimeout(() => {
        this.toolHintEl.textContent = TOOL_HINTS[this.activeTool];
        this.toolHintEl.classList.remove('warn');
      }, revertAfterMs);
    }
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
