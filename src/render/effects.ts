/**
 * The juice layer: particles, floating text and screen shake.
 *
 * Everything in here is cosmetic and none of it feeds back into the
 * simulation. That is deliberate — it means the effects budget can be capped
 * hard, dropped entirely on the low tier, and skipped while the clock is
 * racing, without any of that changing what the colony actually does.
 *
 * Why it exists: the simulation was already dramatic — ants starved, colonies
 * collapsed, beetles ate foragers — and none of it *read* as dramatic, because
 * every one of those events was a dot quietly ceasing to be drawn. A fight
 * should throw sparks. A death should leave a puff. A new colony should land
 * with a bang. The events were always there; this gives them a body.
 *
 * Coordinates are world-space, converted at draw time, so particles stick to
 * the ground and pan and zoom with it.
 */

import type { Vec2 } from '../sim/vec2';

export type ParticleKind = 'spark' | 'puff' | 'sparkle' | 'ring' | 'text';

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  hue: number;
  /** Only for `text`. */
  text?: string;
}

/** Hard ceiling. A colony war at 50x can emit thousands of events a second;
 * past a few hundred live particles nobody can tell the difference anyway, and
 * the frame time very much can. */
const MAX_PARTICLES = 420;

export interface EffectsBudget {
  /** Scales every emission count. 0 disables the layer entirely. */
  density: number;
  /** Screen shake is the first thing to feel cheap on a weak device. */
  shake: boolean;
}

export class Effects {
  private particles: Particle[] = [];
  private shakeAmount = 0;
  private shakeX = 0;
  private shakeY = 0;
  private budget: EffectsBudget = { density: 1, shake: true };

  setBudget(b: EffectsBudget) {
    this.budget = b;
    if (b.density === 0) this.particles.length = 0;
    if (!b.shake) this.shakeAmount = 0;
  }

  get count(): number {
    return this.particles.length;
  }

  /** Current shake offset, in screen pixels. Applied by the renderer as a
   * canvas translate so it never reaches the picking maths — a click during a
   * shake must still land where the player aimed. */
  get shakeOffset(): { x: number; y: number } {
    return { x: this.shakeX, y: this.shakeY };
  }

  private push(p: Particle) {
    // Drop the oldest rather than refusing the newest: the newest is the one
    // tied to something that just happened on screen.
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push(p);
  }

  private scaled(n: number): number {
    return Math.max(0, Math.round(n * this.budget.density));
  }

  /** A fight. Sharp, fast, hot-coloured. */
  spark(pos: Vec2, count = 8, hue = 18) {
    for (let i = 0; i < this.scaled(count); i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 18 + Math.random() * 46;
      this.push({
        kind: 'spark',
        x: pos.x,
        y: pos.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 0.28 + Math.random() * 0.3,
        maxLife: 0.58,
        size: 0.9 + Math.random() * 1.5,
        hue: hue + Math.random() * 26,
      });
    }
  }

  /** A death. Slow, soft, drifting — the visual opposite of a spark. */
  puff(pos: Vec2, count = 6, hue = 30) {
    for (let i = 0; i < this.scaled(count); i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 3 + Math.random() * 10;
      this.push({
        kind: 'puff',
        x: pos.x,
        y: pos.y,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed - 4,
        life: 0.7 + Math.random() * 0.6,
        maxLife: 1.3,
        size: 2.2 + Math.random() * 3.4,
        hue,
      });
    }
  }

  /** A birth. Rising, bright, cheerful. */
  sparkle(pos: Vec2, hue: number, count = 5) {
    for (let i = 0; i < this.scaled(count); i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.5;
      const speed = 10 + Math.random() * 22;
      this.push({
        kind: 'sparkle',
        x: pos.x + (Math.random() - 0.5) * 10,
        y: pos.y + (Math.random() - 0.5) * 10,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 0.5 + Math.random() * 0.45,
        maxLife: 0.95,
        size: 1.1 + Math.random() * 1.5,
        hue,
      });
    }
  }

  /** An expanding shockwave ring — for the big, rare moments. */
  ring(pos: Vec2, hue: number, size = 60) {
    if (this.budget.density === 0) return;
    this.push({
      kind: 'ring',
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      life: 0.85,
      maxLife: 0.85,
      size,
      hue,
    });
  }

  /** Floating text that rises and fades, for things worth reading. */
  floatText(pos: Vec2, text: string, hue = 90) {
    if (this.budget.density === 0) return;
    this.push({
      kind: 'text',
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: -16,
      life: 1.25,
      maxLife: 1.25,
      size: 13,
      hue,
      text,
    });
  }

  /**
   * Add a jolt. Takes the strongest request rather than summing, so a brawl
   * involving twenty ants shakes like one good hit instead of tearing the
   * screen apart.
   */
  shake(amount: number) {
    if (!this.budget.shake) return;
    this.shakeAmount = Math.min(14, Math.max(this.shakeAmount, amount));
  }

  update(dt: number) {
    // Clamp: after a tab has been backgrounded dt can be enormous, and a
    // single huge step would fling every live particle off the map at once.
    const step = Math.min(dt, 0.05);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= step;
      if (p.life <= 0) {
        // Swap-pop: order doesn't matter and it avoids an O(n) splice per
        // dead particle, which at war-time emission rates adds up.
        this.particles[i] = this.particles[this.particles.length - 1];
        this.particles.pop();
        continue;
      }
      p.x += p.vx * step;
      p.y += p.vy * step;
      if (p.kind === 'spark') {
        p.vx *= 0.9;
        p.vy *= 0.9;
      } else if (p.kind === 'puff') {
        p.vx *= 0.96;
        p.vy = p.vy * 0.96 - 2 * step;
      } else if (p.kind === 'sparkle') {
        p.vy += 26 * step; // gravity, so sparks arc back down
      }
    }

    if (this.shakeAmount > 0.05) {
      this.shakeAmount *= Math.pow(0.0008, step);
      this.shakeX = (Math.random() - 0.5) * 2 * this.shakeAmount;
      this.shakeY = (Math.random() - 0.5) * 2 * this.shakeAmount;
    } else {
      this.shakeAmount = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /** Draw everything. `w2s` converts world to screen; `zoom` scales sizes. */
  render(ctx: CanvasRenderingContext2D, w2s: (p: Vec2) => Vec2, zoom: number) {
    if (this.particles.length === 0) return;
    ctx.save();
    // Additive for the hot stuff; text and puffs restore normal blending
    // themselves so they stay readable against bright ground.
    ctx.globalCompositeOperation = 'lighter';

    for (const p of this.particles) {
      const t = Math.max(0, p.life / p.maxLife);
      const s = w2s({ x: p.x, y: p.y });

      if (p.kind === 'ring') {
        const r = p.size * (1 - t) * zoom;
        if (r < 0.5) continue;
        ctx.strokeStyle = `hsla(${p.hue}, 95%, 66%, ${t * 0.75})`;
        ctx.lineWidth = Math.max(1, 3 * t * zoom);
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      }

      if (p.kind === 'text') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = `700 ${p.size}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        // Outline first so it reads over pale sand as well as dark soil.
        ctx.strokeStyle = `rgba(0,0,0,${t * 0.7})`;
        ctx.lineWidth = 3;
        ctx.strokeText(p.text ?? '', s.x, s.y);
        ctx.fillStyle = `hsla(${p.hue}, 90%, 72%, ${t})`;
        ctx.fillText(p.text ?? '', s.x, s.y);
        ctx.globalCompositeOperation = 'lighter';
        continue;
      }

      const r = Math.max(0.6, p.size * zoom * (p.kind === 'puff' ? 1 + (1 - t) * 1.6 : t));
      if (p.kind === 'puff') {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `hsla(${p.hue}, 24%, 62%, ${t * 0.34})`;
      } else {
        ctx.fillStyle = `hsla(${p.hue}, 100%, ${p.kind === 'spark' ? 66 : 74}%, ${t})`;
      }
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      if (p.kind === 'puff') ctx.globalCompositeOperation = 'lighter';
    }

    ctx.restore();
  }

  clear() {
    this.particles.length = 0;
    this.shakeAmount = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }
}
