/**
 * First-run introduction / "How it works" overlay.
 *
 * A newcomer opening Formicarium sees a field of coloured dots and has no way
 * to know what any of it means. This is a short, skimmable, multi-pane
 * explainer that answers "what am I looking at", "why do the ants walk in
 * lines", "what is happening to them" and "what can I do", plus a legend they
 * can come back to at any time via the HUD's "?" button.
 *
 * Plain DOM, no framework — styling lives in src/style.css under
 * "--- Intro / how-it-works overlay ---".
 *
 * Usage from the HUD:
 *
 *   const intro = new Intro({ onClose: () => ... });
 *   hudRoot.appendChild(intro.element);
 *   if (!Intro.hasBeenSeen()) intro.open();      // first visit
 *   helpButton.addEventListener('click', () => intro.open());
 */

const STORAGE_KEY = 'formicarium-intro-seen-v2';

/** A colony hue for the sample ants, so the little glyphs read as "two
 * different colonies" exactly the way the world does. */
const HUE_A = 18;
const HUE_B = 210;

export interface IntroOptions {
  /** Fired whenever the overlay closes (Skip, Got it, Esc, backdrop click). */
  onClose?: () => void;
  /** Fired whenever the overlay opens. */
  onOpen?: () => void;
}

export function hasSeenIntro(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Private browsing / storage disabled: treat as "not seen". Worst case the
    // intro greets them again next visit, which is a fine failure mode.
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    /* see above — non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Small inline SVG glyphs. These deliberately mirror how the renderer draws
// the real thing (body + head ellipses, mandibles on soldiers, translucent
// wings on alates) so the legend actually matches the screen.
// ---------------------------------------------------------------------------

function antGlyph(hue: number, opts: { soldier?: boolean; winged?: boolean; carrying?: boolean; big?: boolean } = {}): string {
  const body = `hsl(${hue}, 68%, 52%)`;
  const dark = 'rgba(20,12,6,0.55)';
  const scale = opts.big ? 1.18 : 1;
  const wings = opts.winged
    ? `<g fill="rgba(255,255,255,0.34)"><ellipse cx="15" cy="5.4" rx="8" ry="2.4" transform="rotate(-12 15 5.4)"/><ellipse cx="15" cy="12.6" rx="8" ry="2.4" transform="rotate(12 15 12.6)"/></g>`
    : '';
  const mandibles = opts.soldier
    ? `<g stroke="rgba(0,0,0,0.55)" stroke-width="1.2" fill="none"><path d="M23 7.2 L26.5 5.4"/><path d="M23 10.8 L26.5 12.6"/></g>`
    : '';
  const load = opts.carrying ? `<circle cx="26" cy="9" r="2.6" fill="#e6c65c"/>` : '';
  const legs = `<g stroke="rgba(20,15,10,0.6)" stroke-width="1" fill="none">
      <path d="M12 7 L9 3.2"/><path d="M12 11 L9 14.8"/>
      <path d="M15 6.8 L15 2.6"/><path d="M15 11.2 L15 15.4"/>
      <path d="M18 7 L21 3.2"/><path d="M18 11 L21 14.8"/>
    </g>`;
  return `<svg class="glyph" viewBox="0 0 30 18" width="${30 * scale}" height="${18 * scale}" aria-hidden="true">
    ${legs}${wings}
    <ellipse cx="13" cy="9" rx="6.4" ry="4.2" fill="${body}" stroke="${dark}" stroke-width="0.9"/>
    <ellipse cx="21" cy="9" rx="3.4" ry="2.8" fill="${body}" stroke="${dark}" stroke-width="0.9"/>
    <ellipse cx="11" cy="7.6" rx="2.1" ry="1.05" fill="rgba(255,255,255,0.25)" transform="rotate(-20 11 7.6)"/>
    ${mandibles}${load}
  </svg>`;
}

function larvaGlyph(): string {
  return `<svg class="glyph" viewBox="0 0 30 18" width="30" height="18" aria-hidden="true">
    <ellipse cx="15" cy="9" rx="7" ry="4.4" fill="#eee3c0"/>
    <ellipse cx="12" cy="7.6" rx="2.4" ry="1.3" fill="rgba(255,255,255,0.55)"/>
  </svg>`;
}

function nestGlyph(hue = HUE_A): string {
  return `<svg class="glyph" viewBox="0 0 30 18" width="30" height="18" aria-hidden="true">
    <circle cx="15" cy="9" r="8.4" fill="none" stroke="hsla(${hue},70%,60%,0.28)" stroke-width="1"/>
    <circle cx="15" cy="9" r="5.4" fill="hsl(${hue}, 40%, 26%)" stroke="hsl(${hue}, 80%, 65%)" stroke-width="1.6"/>
    <circle cx="15" cy="9" r="1.6" fill="rgba(0,0,0,0.55)"/>
  </svg>`;
}

function foodGlyph(): string {
  return `<svg class="glyph" viewBox="0 0 30 18" width="30" height="18" aria-hidden="true">
    <circle cx="11" cy="9" r="4.6" fill="#c9a24b" stroke="#7a5b1e" stroke-width="1"/>
    <circle cx="20" cy="11" r="3" fill="#e0644a" stroke="#8f2c1c" stroke-width="1"/>
  </svg>`;
}

function predatorGlyph(): string {
  return `<svg class="glyph" viewBox="0 0 30 18" width="30" height="18" aria-hidden="true">
    <g stroke="#2a2a2a" stroke-width="1.1" fill="none">
      <path d="M13 9 L8 3"/><path d="M13 9 L6 8"/><path d="M13 9 L8 15"/><path d="M13 9 L7 12"/>
      <path d="M17 9 L22 3"/><path d="M17 9 L24 8"/><path d="M17 9 L22 15"/><path d="M17 9 L23 12"/>
    </g>
    <ellipse cx="14" cy="9" rx="5" ry="3.6" fill="#2a2a2a"/>
    <ellipse cx="20" cy="9" rx="2.6" ry="2.2" fill="#2a2a2a"/>
  </svg>`;
}

function trailGlyph(hue: number): string {
  const id = `tg${Math.round(hue)}`;
  return `<svg class="glyph" viewBox="0 0 30 18" width="30" height="18" aria-hidden="true">
    <defs><linearGradient id="${id}" x1="0" x2="1">
      <stop offset="0" stop-color="hsla(${hue},90%,60%,0.05)"/>
      <stop offset="1" stop-color="hsla(${hue},90%,60%,0.75)"/>
    </linearGradient></defs>
    <rect x="2" y="5" width="26" height="8" rx="4" fill="url(#${id})"/>
  </svg>`;
}

/** The centrepiece of pane 2: nest → trail → food, with the trail getting
 * visibly stronger toward the food and a couple of ants walking it. */
function trailDiagram(): string {
  return `<svg class="intro-diagram" viewBox="0 0 320 104" role="img"
    aria-label="Diagram: ants walk from the nest to a food pile along a scent trail that grows stronger as more ants use it">
    <defs>
      <linearGradient id="introTrail" x1="0" x2="1">
        <stop offset="0" stop-color="hsla(${HUE_A},90%,60%,0.75)"/>
        <stop offset="0.55" stop-color="hsla(${HUE_A},90%,60%,0.45)"/>
        <stop offset="1" stop-color="hsla(${HUE_A},90%,60%,0.10)"/>
      </linearGradient>
    </defs>
    <path d="M52 62 C 120 20, 190 96, 268 46" stroke="url(#introTrail)" stroke-width="15" fill="none" stroke-linecap="round"/>
    <path d="M52 62 C 120 20, 190 96, 268 46" stroke="hsla(${HUE_A},95%,70%,0.28)" stroke-width="2" fill="none" stroke-dasharray="4 7"/>

    <circle cx="46" cy="66" r="20" fill="none" stroke="hsla(${HUE_A},70%,60%,0.22)"/>
    <circle cx="46" cy="66" r="12" fill="hsl(${HUE_A}, 40%, 24%)" stroke="hsl(${HUE_A}, 80%, 65%)" stroke-width="2"/>
    <circle cx="46" cy="66" r="3" fill="rgba(0,0,0,0.5)"/>
    <text x="46" y="98" text-anchor="middle" class="intro-diagram-label">Nest</text>

    <circle cx="278" cy="42" r="11" fill="#c9a24b" stroke="#7a5b1e" stroke-width="1.5"/>
    <circle cx="292" cy="54" r="6" fill="#c9a24b" stroke="#7a5b1e" stroke-width="1.2"/>
    <text x="282" y="86" text-anchor="middle" class="intro-diagram-label">Food</text>

    <g transform="translate(104,40) rotate(-16) scale(0.85)">${antGlyph(HUE_A)}</g>
    <g transform="translate(168,60) rotate(8) scale(0.85)">${antGlyph(HUE_A, { carrying: true })}</g>
    <g transform="translate(222,62) rotate(-12) scale(0.85)">${antGlyph(HUE_A)}</g>
  </svg>`;
}

// ---------------------------------------------------------------------------

interface PaneSpec {
  title: string;
  /** Optional wide visual placed under the title. */
  visual?: string;
  lines: { icon?: string; text: string }[];
  /** Optional legend / control grid appended after the lines. */
  grid?: { label: string; glyph?: string; icon?: string; text: string }[];
  footnote?: string;
}

const PANES: PaneSpec[] = [
  {
    title: "What you're looking at",
    visual: `<div class="intro-antrow">
        ${antGlyph(HUE_A, { big: true })}${antGlyph(HUE_A, { carrying: true, big: true })}${antGlyph(HUE_B, { big: true })}${antGlyph(HUE_B, { soldier: true, big: true })}
      </div>`,
    lines: [
      { icon: '🐜', text: 'Every moving speck is one ant, alive and deciding for itself. Ants are tinted by the colony they belong to, so rival colonies read apart at a glance.' },
      { icon: '🏰', text: 'The mound each swarm circles is that colony&rsquo;s nest. Food gets carried back there; eggs are laid down inside it.' },
      { icon: '🔍', text: 'Nothing here is scripted. Zoom in on one ant and you are watching that individual&rsquo;s own hunger, errand and luck.' },
    ],
  },
  {
    title: 'Scent trails are the whole trick',
    visual: trailDiagram(),
    lines: [
      { icon: '👃', text: 'A forager wanders more or less at random until it stumbles into food. It then walks home laying a scent trail behind it.' },
      { icon: '📈', text: 'Ants that cross that scent follow it — and every ant that comes back loaded lays more scent, so a good route gets stronger and busier.' },
      { icon: '💨', text: 'Scent evaporates. When the food runs out nobody tops the trail up, and it fades away on its own.' },
      { icon: '🎨', text: 'The coloured haze on the ground <em>is</em> that scent. Brighter haze = a stronger, better-used trail. Red haze is alarm scent: something is attacking.' },
    ],
  },
  {
    title: 'Birth, work, war, death',
    visual: `<div class="intro-lifecycle">
        <span class="intro-life-step">${antGlyph(HUE_A, { big: true })}<b>Queen</b><i>lays eggs</i></span>
        <span class="intro-life-arrow">→</span>
        <span class="intro-life-step">${larvaGlyph()}<b>Larva</b><i>grows up</i></span>
        <span class="intro-life-arrow">→</span>
        <span class="intro-life-step">${antGlyph(HUE_A)}<b>Worker</b><i>forages</i></span>
        <span class="intro-life-arrow">/</span>
        <span class="intro-life-step">${antGlyph(HUE_A, { soldier: true })}<b>Soldier</b><i>fights</i></span>
      </div>`,
    lines: [
      { icon: '👑', text: 'One queen per colony sits in the nest laying eggs. Eggs become larvae — the pale grubs — and larvae grow into workers or soldiers.' },
      { icon: '🌰', text: 'Workers forage and feed the nest. Soldiers patrol and fight border skirmishes with neighbouring colonies.' },
      { icon: '💀', text: 'Ants die: old age, starvation when the nest runs dry, predators, and combat. The Colony log on the left names each cause as it happens.' },
      { icon: '🦋', text: 'A rich colony raises winged queens that leave on a nuptial flight, land far off, and found a brand-new colony of their own.' },
    ],
  },
  {
    title: 'Legend & what to try',
    grid: [
      { label: 'Worker', glyph: antGlyph(HUE_A), text: 'forages, hauls food home' },
      { label: 'Soldier', glyph: antGlyph(HUE_A, { soldier: true }), text: 'bigger, with mandibles' },
      { label: 'Winged queen', glyph: antGlyph(HUE_B, { winged: true }), text: 'leaves to found a colony' },
      { label: 'Larva', glyph: larvaGlyph(), text: 'pale grub, growing in the nest' },
      { label: 'Nest', glyph: nestGlyph(), text: 'the mound + its territory ring' },
      { label: 'Food', glyph: foodGlyph(), text: 'seeds, fruit, nectar, carcasses' },
      { label: 'Predator', glyph: predatorGlyph(), text: 'spiders, beetles, birds — they eat ants' },
      { label: 'Scent trail', glyph: trailGlyph(HUE_A), text: 'brighter = stronger trail' },
    ],
    lines: [
      { icon: '🖐️', text: 'Drag to pan, scroll or pinch to zoom. Click an ant to open its inspector and watch its hunger, age and errand change.' },
      { icon: '🧰', text: 'Tool bar (bottom): 🔍 inspect · 🌰 drop food · 🕷️ spawn a predator · 👑 found a rogue colony. Pick a tool, then click the ground.' },
      { icon: '⚙️', text: 'The gear holds speed (1× to 10×, or pause with Space), the surface / underground view toggle, and graphics power.' },
    ],
    footnote: 'You can reopen this any time with the <b>?</b> button, top right.',
  },
];

// ---------------------------------------------------------------------------

export class Intro {
  /** Append this to the HUD root. It is `hidden` until `open()` is called. */
  readonly element: HTMLElement;

  private card: HTMLElement;
  private paneEls: HTMLElement[] = [];
  private dotEls: HTMLElement[] = [];
  private backBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private index = 0;
  private opened = false;
  private opts: IntroOptions;

  constructor(opts: IntroOptions = {}) {
    this.opts = opts;

    const backdrop = document.createElement('div');
    backdrop.className = 'intro-backdrop hidden';
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) this.close();
    });
    this.element = backdrop;

    const card = document.createElement('div');
    card.className = 'intro-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'How Formicarium works');
    card.tabIndex = -1;
    this.card = card;
    backdrop.appendChild(card);

    // --- header -----------------------------------------------------------
    const head = document.createElement('div');
    head.className = 'intro-head';
    const kicker = document.createElement('div');
    kicker.className = 'intro-kicker';
    kicker.innerHTML = '🐜 <b>Formicarium</b> <span>· a living ant colony</span>';
    const skip = document.createElement('button');
    skip.className = 'intro-skip';
    skip.type = 'button';
    skip.textContent = 'Skip';
    skip.addEventListener('click', () => this.close());
    head.append(kicker, skip);
    card.appendChild(head);

    // --- panes ------------------------------------------------------------
    const body = document.createElement('div');
    body.className = 'intro-body';
    card.appendChild(body);
    for (const spec of PANES) {
      const pane = this.buildPane(spec);
      this.paneEls.push(pane);
      body.appendChild(pane);
    }

    // --- footer -----------------------------------------------------------
    const foot = document.createElement('div');
    foot.className = 'intro-foot';

    const dots = document.createElement('div');
    dots.className = 'intro-dots';
    PANES.forEach((_, i) => {
      const dot = document.createElement('button');
      dot.className = 'intro-dot';
      dot.type = 'button';
      dot.setAttribute('aria-label', `Step ${i + 1} of ${PANES.length}`);
      dot.addEventListener('click', () => this.goTo(i));
      this.dotEls.push(dot);
      dots.appendChild(dot);
    });

    const nav = document.createElement('div');
    nav.className = 'intro-nav';
    this.backBtn = document.createElement('button');
    this.backBtn.className = 'intro-btn ghost';
    this.backBtn.type = 'button';
    this.backBtn.textContent = 'Back';
    this.backBtn.addEventListener('click', () => this.goTo(this.index - 1));
    this.nextBtn = document.createElement('button');
    this.nextBtn.className = 'intro-btn primary';
    this.nextBtn.type = 'button';
    this.nextBtn.textContent = 'Next';
    this.nextBtn.addEventListener('click', () => {
      if (this.index >= PANES.length - 1) this.close();
      else this.goTo(this.index + 1);
    });
    nav.append(this.backBtn, this.nextBtn);

    foot.append(dots, nav);
    card.appendChild(foot);

    this.goTo(0);
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** Open the overlay, optionally jumping straight to a pane (0-based). */
  open(paneIndex = 0): void {
    this.goTo(paneIndex);
    this.element.classList.remove('hidden');
    this.opened = true;
    window.addEventListener('keydown', this.onKeyDown, true);
    // Focus the card so Esc / arrow keys work without a click first.
    requestAnimationFrame(() => this.card.focus({ preventScroll: true }));
    this.opts.onOpen?.();
  }

  close(): void {
    if (!this.opened) return;
    this.element.classList.add('hidden');
    this.opened = false;
    markIntroSeen();
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.opts.onClose?.();
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown, true);
    this.element.remove();
  }

  // -------------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent) => {
    if (!this.opened) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.close();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      this.goTo(this.index + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      this.goTo(this.index - 1);
    } else if (e.code === 'Space') {
      // Don't let the world's pause shortcut fire from behind the modal.
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private goTo(i: number): void {
    this.index = Math.max(0, Math.min(PANES.length - 1, i));
    this.paneEls.forEach((p, n) => p.classList.toggle('hidden', n !== this.index));
    this.dotEls.forEach((d, n) => d.classList.toggle('active', n === this.index));
    this.backBtn.disabled = this.index === 0;
    const last = this.index === PANES.length - 1;
    this.nextBtn.textContent = last ? 'Got it' : 'Next';
    this.nextBtn.classList.toggle('final', last);
  }

  private buildPane(spec: PaneSpec): HTMLElement {
    const pane = document.createElement('section');
    pane.className = 'intro-pane hidden';

    const h = document.createElement('h2');
    h.className = 'intro-title';
    h.textContent = spec.title;
    pane.appendChild(h);

    if (spec.visual) {
      const vis = document.createElement('div');
      vis.className = 'intro-visual';
      vis.innerHTML = spec.visual;
      pane.appendChild(vis);
    }

    if (spec.grid) {
      const grid = document.createElement('div');
      grid.className = 'intro-legend';
      for (const item of spec.grid) {
        const cell = document.createElement('div');
        cell.className = 'intro-legend-item';
        const art = document.createElement('div');
        art.className = 'intro-legend-art';
        art.innerHTML = item.glyph ?? `<span class="intro-legend-emoji">${item.icon ?? ''}</span>`;
        const txt = document.createElement('div');
        txt.className = 'intro-legend-text';
        txt.innerHTML = `<b>${item.label}</b><span>${item.text}</span>`;
        cell.append(art, txt);
        grid.appendChild(cell);
      }
      pane.appendChild(grid);
    }

    const list = document.createElement('ul');
    list.className = 'intro-lines';
    for (const line of spec.lines) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="intro-line-icon">${line.icon ?? '•'}</span><span class="intro-line-text">${line.text}</span>`;
      list.appendChild(li);
    }
    pane.appendChild(list);

    if (spec.footnote) {
      const note = document.createElement('div');
      note.className = 'intro-footnote';
      note.innerHTML = spec.footnote;
      pane.appendChild(note);
    }

    return pane;
  }
}
