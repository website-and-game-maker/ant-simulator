import type { ISimulation } from '../sim/facade';
import type { AntSnapshot, Caste, ColonySnapshot, DeathCause, WorldSnapshot } from '../sim/types';
import type { Vec2 } from '../sim/vec2';
import { PERFORMANCE_PROFILES, PERFORMANCE_TIER_ORDER } from '../sim/performanceProfiles';
import type { PerformanceTierName } from '../sim/types';

export type ToolMode = 'inspect' | 'placeFood' | 'spawnPredator' | 'foundColony';

const TASK_LABELS: Record<AntSnapshot['task'], string> = {
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

const CASTE_LABELS: Record<Caste, string> = {
  larva: 'Larva',
  worker: 'Worker',
  soldier: 'Soldier',
  queen: 'Queen',
  drone: 'Drone',
  alateQueen: 'Alate queen',
};

const DEATH_LABELS: Record<DeathCause, string> = {
  oldAge: 'Old age',
  starvation: 'Starvation',
  combat: 'Combat',
  predator: 'Predators',
  drowned: 'Drowned',
  exposure: 'Exposure',
  crushed: 'Crushed',
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

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toString();
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
 * inspector, tool bar, toast feed, first-run help. Plain DOM, no framework —
 * see the CSS appended to src/style.css under "UI PANEL STYLES".
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
  private colonyListEl!: HTMLElement;
  private inspectorEl!: HTMLElement;
  private toolButtons = {} as Record<ToolMode, HTMLButtonElement>;
  private toolHintEl!: HTMLElement;
  private toastContainer!: HTMLElement;
  private toastQueue: { text: string; icon: string }[] = [];
  private toastShowing = false;
  private settingsPanelEl!: HTMLElement;
  private restartBtn!: HTMLButtonElement;
  private confirmingRestart = false;
  private speedButtons: HTMLButtonElement[] = [];
  private unsubscribers: (() => void)[] = [];

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
    this.toolHintEl.textContent = TOOL_HINTS[tool];
  }

  update(snapshot: WorldSnapshot) {
    if (this.disposed) return;
    const now = performance.now();
    this.updateInspector(snapshot);
    if (now - this.lastUiUpdate < 130) return; // throttle heavier DOM writes to ~7.5Hz
    this.lastUiUpdate = now;
    this.updateStats(snapshot);
    this.updateColonyList(snapshot);
  }

  dispose() {
    this.disposed = true;
    for (const un of this.unsubscribers) un();
    this.root.querySelector('.hud-root')?.remove();
  }

  // -------------------------------------------------------------------

  private build() {
    const container = el('div', 'hud-root');
    container.style.pointerEvents = 'none';
    this.root.appendChild(container);

    container.appendChild(this.buildStatsPanel());
    container.appendChild(this.buildColonyPanel());
    container.appendChild(this.buildSettingsPanel());
    container.appendChild(this.buildInspector());
    container.appendChild(this.buildToolbar());
    container.appendChild(this.buildToastContainer());
    container.appendChild(this.buildHelpOverlay());

    this.setActiveTool('inspect');
  }

  private wireEvents() {
    const un = this.sim.events.on('colonyFounded', (e) => {
      this.pushToast(e.parentColonyId === null ? '🐣 A new colony has been founded!' : '🦋 A rogue queen founded a new colony!', '🐣');
    });
    const un2 = this.sim.events.on('colonyCollapsed', () => this.pushToast('💀 A colony has collapsed.', '💀'));
    const un3 = this.sim.events.on('nuptialFlight', (e) =>
      this.pushToast(`🦋 Nuptial flight! Colony #${e.colonyId} sends alates into the sky.`, '🦋'),
    );
    this.unsubscribers.push(un, un2, un3);

    window.addEventListener('keydown', this.onKeyDown);
    this.unsubscribers.push(() => window.removeEventListener('keydown', this.onKeyDown));
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !isTypingTarget(e.target)) {
      e.preventDefault();
      this.sim.togglePause();
    }
  };

  // --- Stats -----------------------------------------------------------

  private buildStatsPanel(): HTMLElement {
    const panel = el('div', 'hud-panel hud-stats');
    panel.style.pointerEvents = 'auto';

    const row = (key: string, icon: string, label: string) => {
      const r = el('div', 'stat-row');
      r.append(el('span', 'stat-icon', icon), el('span', 'stat-label', label), (this.statsEls[key] = el('span', 'stat-value', '—')));
      panel.appendChild(r);
      return r;
    };

    panel.appendChild(el('div', 'hud-title', '🐜 Formicarium'));
    row('ants', '🐜', 'Ants');
    row('larvae', '🥚', 'Larvae');
    row('colonies', '🏰', 'Colonies');
    row('predators', '🕷️', 'Predators');
    row('births', '📈', 'Births/min');
    row('deaths', '📉', 'Deaths/min');
    row('clock', '🕐', 'Sim time');
    row('weather', '🌤️', 'Weather');
    row('fps', '⚡', 'FPS');

    const causes = el('div', 'stat-causes');
    this.statsEls.causes = causes;
    panel.appendChild(causes);

    return panel;
  }

  private updateStats(s: WorldSnapshot) {
    this.statsEls.ants.textContent = fmt(s.stats.totalAnts);
    this.statsEls.larvae.textContent = fmt(s.stats.totalLarvae);
    this.statsEls.colonies.textContent = fmt(s.stats.totalColonies);
    this.statsEls.predators.textContent = fmt(s.stats.totalPredators);
    this.statsEls.births.textContent = fmt(s.stats.birthsPerMinute);
    this.statsEls.deaths.textContent = fmt(s.stats.deathsPerMinute);
    this.statsEls.fps.textContent = Math.round(s.stats.fps).toString();

    const day = Math.floor(s.stats.simTime / 150) + 1;
    const hh = Math.floor(s.timeOfDay * 24)
      .toString()
      .padStart(2, '0');
    const mm = Math.floor((s.timeOfDay * 24 * 60) % 60)
      .toString()
      .padStart(2, '0');
    this.statsEls.clock.textContent = `Day ${day}, ${hh}:${mm}`;

    this.statsEls.weather.textContent = `${WEATHER_ICON[s.weather] ?? ''} ${s.weather}`;

    const parts = Object.entries(s.stats.deathsByCause)
      .filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${DEATH_LABELS[k as DeathCause]}: ${v}`);
    this.statsEls.causes.textContent = parts.length ? `Deaths so far — ${parts.join(' · ')}` : '';
  }

  // --- Colony leaderboard -----------------------------------------------

  private buildColonyPanel(): HTMLElement {
    const panel = el('div', 'hud-panel hud-colonies');
    panel.style.pointerEvents = 'auto';
    panel.appendChild(el('div', 'hud-subtitle', 'Colonies'));
    this.colonyListEl = el('div', 'colony-list');
    panel.appendChild(this.colonyListEl);
    return panel;
  }

  private updateColonyList(s: WorldSnapshot) {
    const colonies = [...s.colonies].sort((a, b) => b.population - a.population);
    this.colonyListEl.textContent = '';
    if (colonies.length === 0) {
      this.colonyListEl.appendChild(el('div', 'colony-empty', 'No colonies left…'));
      return;
    }
    for (const c of colonies.slice(0, 12)) {
      const row = el('div', 'colony-row');
      const dot = el('span', 'colony-dot');
      dot.style.background = `hsl(${c.colorHue}, 75%, 55%)`;
      row.appendChild(dot);
      row.appendChild(el('span', 'colony-name', c.name));
      row.appendChild(el('span', 'colony-pop', fmt(c.population)));
      row.appendChild(el('span', 'colony-status', c.queenAlive ? '♛' : '☠'));
      row.addEventListener('click', () => this.opts.onFocusPosition?.(c.nestPos));
      this.colonyListEl.appendChild(row);
    }
  }

  // --- Settings ----------------------------------------------------------

  private buildSettingsPanel(): HTMLElement {
    const wrap = el('div', 'hud-settings-wrap');
    wrap.style.pointerEvents = 'auto';
    const toggle = el('button', 'hud-icon-btn hud-settings-toggle', '⚙️');
    const panel = el('div', 'hud-panel hud-settings hidden');
    this.settingsPanelEl = panel;
    toggle.addEventListener('click', () => panel.classList.toggle('hidden'));

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

    panel.appendChild(el('div', 'hud-subtitle', 'Speed'));
    const speedWrap = el('div', 'speed-list');
    const speeds: [number, string][] = [
      [0, '⏸'],
      [1, '1×'],
      [2, '2×'],
      [5, '5×'],
      [10, '10×'],
    ];
    for (const [mult, label] of speeds) {
      const btn = el('button', 'speed-btn', label);
      btn.addEventListener('click', () => {
        this.sim.setSpeed(mult);
        this.refreshSpeedButtons();
      });
      this.speedButtons.push(btn);
      speedWrap.appendChild(btn);
    }
    panel.appendChild(speedWrap);
    this.refreshSpeedButtons();

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

  private refreshSpeedButtons() {
    const speeds = [0, 1, 2, 5, 10];
    const current = this.sim.isPaused() ? 0 : this.sim.getSpeed();
    this.speedButtons.forEach((b, i) => b.classList.toggle('active', speeds[i] === current));
  }

  // --- Inspector -----------------------------------------------------------

  private buildInspector(): HTMLElement {
    const panel = el('div', 'hud-panel hud-inspector hidden');
    panel.style.pointerEvents = 'auto';
    this.inspectorEl = panel;
    return panel;
  }

  private updateInspector(s: WorldSnapshot) {
    void s;
    const ant = this.sim.getSelectedAnt();
    const colony = ant ? null : this.sim.getSelectedColony();
    if (!ant && !colony) {
      this.inspectorEl.classList.add('hidden');
      return;
    }
    this.inspectorEl.classList.remove('hidden');
    this.inspectorEl.textContent = '';

    const closeBtn = el('button', 'inspector-close', '✕');
    closeBtn.addEventListener('click', () => this.sim.clearSelection());
    this.inspectorEl.appendChild(closeBtn);

    if (ant) {
      this.inspectorEl.appendChild(el('div', 'hud-subtitle', CASTE_LABELS[ant.caste]));
      this.inspectorEl.appendChild(el('div', 'inspector-task', TASK_LABELS[ant.task]));
      this.inspectorEl.appendChild(meterRow('Energy', ant.energy, 100, '#7ee07e'));
      this.inspectorEl.appendChild(meterRow('Health', ant.health, 100, '#e07e7e'));
      this.inspectorEl.appendChild(el('div', 'inspector-age', `Age: ${Math.round(ant.age)}s`));
      this.inspectorEl.appendChild(el('div', 'hud-subtitle small', 'Genetics'));
      this.inspectorEl.appendChild(meterRow('Speed', ant.genetics.speed, 1.4, '#6fb7ff'));
      this.inspectorEl.appendChild(meterRow('Strength', ant.genetics.strength, 1.4, '#ff9d6f'));
      this.inspectorEl.appendChild(meterRow('Sense', ant.genetics.senseRadius, 1.3, '#c9a2ff'));
      this.inspectorEl.appendChild(meterRow('Lifespan', ant.genetics.lifespan, 1.3, '#a2ffcf'));
      this.inspectorEl.appendChild(meterRow('Aggression', ant.genetics.aggression, 1, '#ff6f6f'));
      this.inspectorEl.appendChild(meterRow('Industriousness', ant.genetics.industriousness, 1, '#ffe36f'));
    } else if (colony) {
      this.inspectorEl.appendChild(el('div', 'hud-subtitle', colony.name));
      this.inspectorEl.appendChild(el('div', 'inspector-task', colony.alive ? (colony.queenAlive ? 'Thriving' : 'Queenless') : 'Collapsed'));
      this.inspectorEl.appendChild(el('div', 'inspector-age', `Population: ${colony.population} · Food: ${Math.round(colony.foodStore)}`));
      this.inspectorEl.appendChild(el('div', 'inspector-age', `Generation ${colony.generation} · Territory ${Math.round(colony.territoryRadius)}u`));
      const casteWrap = el('div', 'caste-bars');
      (['worker', 'soldier', 'drone', 'alateQueen'] as Caste[]).forEach((c) => {
        const n = colony.populationByCaste[c] ?? 0;
        if (n === 0) return;
        casteWrap.appendChild(el('div', 'caste-row', `${CASTE_LABELS[c]}: ${n}`));
      });
      this.inspectorEl.appendChild(casteWrap);
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
      btn.innerHTML = `<span>${icon}</span>`;
      btn.title = label;
      btn.addEventListener('click', () => this.setActiveTool(mode));
      this.toolButtons[mode] = btn;
      bar.appendChild(btn);
    }
    this.toolHintEl = el('div', 'tool-hint');
    wrap.append(bar, this.toolHintEl);
    return wrap;
  }

  // --- Toasts -----------------------------------------------------------

  private buildToastContainer(): HTMLElement {
    this.toastContainer = el('div', 'hud-toasts');
    return this.toastContainer;
  }

  private pushToast(text: string, icon: string) {
    this.toastQueue.push({ text, icon });
    this.drainToasts();
  }

  private drainToasts() {
    if (this.toastShowing || this.toastQueue.length === 0) return;
    const next = this.toastQueue.shift()!;
    this.toastShowing = true;
    const toast = el('div', 'hud-toast', next.text);
    this.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => {
        toast.remove();
        this.toastShowing = false;
        this.drainToasts();
      }, 300);
    }, 3600);
  }

  // --- First-run help ------------------------------------------------------

  private buildHelpOverlay(): HTMLElement {
    const card = el('div', 'hud-help');
    if (safeGetItem('formicarium-help-seen')) {
      card.classList.add('hidden');
      return card;
    }
    card.style.pointerEvents = 'auto';
    card.appendChild(el('div', 'hud-subtitle', 'Welcome to Formicarium'));
    card.appendChild(
      el(
        'div',
        'hud-help-text',
        'Drag to pan, scroll or pinch to zoom. Use the tool bar to inspect ants, drop food, summon predators, or found a rogue colony. The gear icon opens settings.',
      ),
    );
    const dismiss = el('button', 'hud-help-dismiss', 'Got it');
    dismiss.addEventListener('click', () => {
      safeSetItem('formicarium-help-seen', '1');
      card.classList.add('hidden');
    });
    card.appendChild(dismiss);
    return card;
  }
}

function meterRow(label: string, value: number, max: number, color: string): HTMLElement {
  const row = el('div', 'meter-row');
  row.appendChild(el('span', 'meter-label', label));
  const track = el('div', 'meter-track');
  const fill = el('div', 'meter-fill');
  fill.style.width = `${Math.max(0, Math.min(100, (value / max) * 100))}%`;
  fill.style.background = color;
  track.appendChild(fill);
  row.appendChild(track);
  return row;
}

function safeGetItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing / disabled storage — the help card just reappears
    // next visit, which is a fine fallback.
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
