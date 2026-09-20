/**
 * The vertical speed dock.
 *
 * Speed used to be a row of pill buttons wedged under the tool bar at the
 * bottom of the screen — one more horizontal strip in a stack of horizontal
 * strips, easy to mistake for just another row of settings. A slider reads
 * differently: it has a position, a direction, and weight, which is a much
 * closer match for what "speed" actually is. It lives docked to the top-right
 * corner instead, under the icon buttons, where it isn't competing with the
 * tool bar for the same strip of screen.
 *
 * Hand-rolled rather than a styled `<input type="range">`. A native vertical
 * range input needs either `-webkit-appearance: slider-vertical` (WebKit/
 * Blink only, and it fights any attempt at a custom thumb/track) or a
 * `rotate(-90deg)` transform (which distorts the hit-testing box and drags
 * the focus ring off at an angle). Seven fixed stops with click-to-jump,
 * drag, and arrow-key support is little enough logic that owning it directly
 * is less code and more predictable than fighting the native control.
 */

export interface SpeedStep {
  multiplier: number;
  label: string;
}

export interface SpeedSliderOptions {
  /** Ordered slowest to fastest; index 0 is normally the pause stop. */
  steps: readonly SpeedStep[];
  onChange: (multiplier: number) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class SpeedSlider {
  readonly element: HTMLElement;

  private steps: readonly SpeedStep[];
  private track: HTMLElement;
  private fill: HTMLElement;
  private thumb: HTMLElement;
  private readout: HTMLElement;
  private loadBadge: HTMLElement;
  private index: number;
  private dragging = false;

  constructor(private opts: SpeedSliderOptions) {
    this.steps = opts.steps;
    this.index = this.steps.findIndex((s) => s.multiplier === 1);
    if (this.index < 0) this.index = 0;

    const root = el('div', 'speed-dock');
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Simulation speed');

    this.readout = el('div', 'speed-readout');
    root.appendChild(this.readout);

    const trackWrap = el('div', 'speed-track-wrap');
    trackWrap.appendChild(el('span', 'speed-endlabel', this.steps[this.steps.length - 1].label));
    this.track = el('div', 'speed-track');
    this.track.tabIndex = 0;
    this.track.setAttribute('role', 'slider');
    this.track.setAttribute('aria-orientation', 'vertical');
    this.track.setAttribute('aria-valuemin', '0');
    this.track.setAttribute('aria-valuemax', String(this.steps.length - 1));

    this.fill = el('div', 'speed-track-fill');
    this.track.appendChild(this.fill);

    // Tick dots, one per stop, evenly spaced top (fastest) to bottom
    // (slowest/pause). Each is independently clickable — a straight jump to
    // "20x" without having to land the drag precisely.
    for (let i = 0; i < this.steps.length; i++) {
      const tick = el('button', 'speed-tick');
      tick.type = 'button';
      tick.dataset.idx = String(i);
      tick.style.top = `${this.fractionFor(i) * 100}%`;
      tick.title = this.steps[i].label;
      tick.setAttribute('aria-label', this.steps[i].label);
      tick.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setIndex(i);
      });
      this.track.appendChild(tick);
    }

    this.thumb = el('div', 'speed-thumb');
    this.track.appendChild(this.thumb);

    trackWrap.appendChild(this.track);
    trackWrap.appendChild(el('span', 'speed-endlabel', this.steps[0].label));
    root.appendChild(trackWrap);

    this.loadBadge = el('div', 'speed-load hidden');
    this.loadBadge.title = 'The simulation is running slower than this setting asks for.';
    root.appendChild(this.loadBadge);

    this.wireInteraction();
    this.element = root;
    this.render();
  }

  /** 0 at the top (fastest) to 1 at the bottom (slowest) — "up" reads as
   * "more", matching every volume/throttle slider anyone has used before. */
  private fractionFor(index: number): number {
    return 1 - index / (this.steps.length - 1);
  }

  private indexFromClientY(clientY: number): number {
    const rect = this.track.getBoundingClientRect();
    const frac = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
    const clamped = Math.min(1, Math.max(0, frac));
    // frac=0 (top) should land on the last (fastest) index; invert.
    return Math.round((1 - clamped) * (this.steps.length - 1));
  }

  private wireInteraction() {
    const startDrag = (e: PointerEvent) => {
      this.dragging = true;
      this.track.setPointerCapture(e.pointerId);
      this.setIndex(this.indexFromClientY(e.clientY));
      this.track.focus();
    };
    this.track.addEventListener('pointerdown', startDrag);
    this.track.addEventListener('pointermove', (e) => {
      if (this.dragging) this.setIndex(this.indexFromClientY(e.clientY));
    });
    const endDrag = () => {
      this.dragging = false;
    };
    this.track.addEventListener('pointerup', endDrag);
    this.track.addEventListener('pointercancel', endDrag);

    this.track.addEventListener('keydown', (e) => {
      // Up = faster, matching the visual "up is more" mapping.
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        this.setIndex(this.index + 1);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        this.setIndex(this.index - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.setIndex(this.steps.length - 1);
      } else if (e.key === 'End') {
        e.preventDefault();
        this.setIndex(0);
      }
    });
  }

  private render() {
    const frac = this.fractionFor(this.index) * 100;
    this.thumb.style.top = `${frac}%`;
    // The fill grows from the bottom (slow end) up to the thumb, so it reads
    // as "how much speed is dialled in" rather than an arbitrary bar.
    this.fill.style.height = `${100 - frac}%`;
    this.readout.textContent = this.steps[this.index].label;
    this.readout.classList.toggle('paused', this.steps[this.index].multiplier === 0);
    this.track.setAttribute('aria-valuenow', String(this.index));
    this.track.setAttribute('aria-valuetext', this.steps[this.index].label);
    for (let i = 0; i < this.track.children.length; i++) {
      const child = this.track.children[i];
      if (child.classList.contains('speed-tick')) {
        child.classList.toggle('active', Number((child as HTMLElement).dataset.idx ?? -1) === this.index);
      }
    }
  }

  /** Move to a step by index, firing onChange. Used by drag, click, and
   * keyboard — the one path that actually drives the simulation. */
  setIndex(i: number) {
    const clamped = Math.min(this.steps.length - 1, Math.max(0, i));
    if (clamped === this.index) return;
    this.index = clamped;
    this.render();
    this.opts.onChange(this.steps[this.index].multiplier);
  }

  /** Sync the displayed position to match the simulation's actual speed,
   * without re-firing onChange — for when the sim's speed changed through
   * some other path (a keyboard shortcut, Space, a fresh boot). */
  syncFromMultiplier(multiplier: number) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.steps.length; i++) {
      const d = Math.abs(this.steps[i].multiplier - multiplier);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best === this.index) return;
    this.index = best;
    this.render();
  }

  get currentIndex(): number {
    return this.index;
  }

  /** Show or hide the "running slower than requested" badge. `null` hides
   * it; a number 0-100 shows the percentage actually achieved. */
  setThrottle(percent: number | null) {
    this.loadBadge.classList.toggle('hidden', percent === null);
    if (percent !== null) this.loadBadge.textContent = `⚠ ${percent}%`;
  }
}
