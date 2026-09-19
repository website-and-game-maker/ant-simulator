/**
 * Toasts: the loud channel.
 *
 * The colony log on the left is the quiet, complete record — every birth,
 * death and founding, scrolling past. That is the right home for detail and
 * the wrong one for drama: the genuinely rare moments (a colony wiped out, a
 * nuptial flight, a milestone earned) scroll away in the same grey type as the
 * two hundred routine lines around them, so nobody ever notices them happen.
 *
 * This is the other half: a handful of events a run, big enough to catch the
 * eye in peripheral vision, gone on their own a few seconds later.
 *
 * Styling lives in src/style.css under "--- Toasts ---".
 */

export type ToastTone = 'event' | 'good' | 'bad' | 'milestone';

export interface ToastSpec {
  icon: string;
  title: string;
  body?: string;
  tone?: ToastTone;
  /** Milliseconds on screen. Milestones linger; routine drama doesn't. */
  ttl?: number;
  /** Collapses repeats: a second toast with the same key bumps a counter on
   * the live one instead of stacking. Five colonies collapsing during a war
   * should be one card reading "×5", not five cards burying the screen. */
  key?: string;
}

interface LiveToast {
  el: HTMLElement;
  key?: string;
  count: number;
  countEl: HTMLElement;
  timer: number;
}

/** Past this, older cards are retired early — a toast you can't read because
 * four more are stacked on it is worse than no toast. */
const MAX_VISIBLE = 4;

export class Toasts {
  readonly element: HTMLElement;
  private live: LiveToast[] = [];

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'toast-stack';
    // Purely informational; it must never eat a click aimed at the world.
    this.element.style.pointerEvents = 'none';
    this.element.setAttribute('role', 'status');
    this.element.setAttribute('aria-live', 'polite');
  }

  show(spec: ToastSpec) {
    if (spec.key) {
      const existing = this.live.find((t) => t.key === spec.key);
      if (existing) {
        existing.count++;
        existing.countEl.textContent = `×${existing.count}`;
        existing.countEl.classList.remove('hidden');
        // Restart the clock so a repeating event keeps its card alive.
        window.clearTimeout(existing.timer);
        existing.timer = window.setTimeout(() => this.dismiss(existing), spec.ttl ?? 5200);
        existing.el.classList.remove('bump');
        // Force a reflow so the bump animation can retrigger.
        void existing.el.offsetWidth;
        existing.el.classList.add('bump');
        return;
      }
    }

    const tone = spec.tone ?? 'event';
    const el = document.createElement('div');
    el.className = `toast toast-${tone}`;

    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.textContent = spec.icon;

    const text = document.createElement('div');
    text.className = 'toast-text';
    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = spec.title;
    text.appendChild(title);
    if (spec.body) {
      const body = document.createElement('div');
      body.className = 'toast-body';
      body.textContent = spec.body;
      text.appendChild(body);
    }

    const countEl = document.createElement('div');
    countEl.className = 'toast-count hidden';

    el.append(icon, text, countEl);
    this.element.appendChild(el);

    const entry: LiveToast = {
      el,
      key: spec.key,
      count: 1,
      countEl,
      timer: window.setTimeout(() => this.dismiss(entryRef), spec.ttl ?? (tone === 'milestone' ? 7000 : 5200)),
    };
    const entryRef = entry;
    this.live.push(entry);

    while (this.live.length > MAX_VISIBLE) {
      const oldest = this.live[0];
      this.dismiss(oldest);
    }
  }

  private dismiss(entry: LiveToast) {
    const i = this.live.indexOf(entry);
    if (i < 0) return;
    this.live.splice(i, 1);
    window.clearTimeout(entry.timer);
    entry.el.classList.add('leaving');
    // Let the exit animation finish, then remove. `animationend` alone would
    // strand the node if animations are disabled (reduced motion, background
    // tab), so the timeout is the one that actually guarantees cleanup.
    window.setTimeout(() => entry.el.remove(), 320);
  }

  clear() {
    for (const t of [...this.live]) this.dismiss(t);
  }

  dispose() {
    for (const t of this.live) window.clearTimeout(t.timer);
    this.live = [];
    this.element.remove();
  }
}
