/**
 * sprites.ts — every living thing in Formicarium is drawn from here.
 *
 * ART PROVENANCE
 * --------------
 * All of this art is original, authored for this project (see
 * `public/assets/CREDITS.md`). We went looking for genuinely CC0 top-down
 * ant art first — OpenGameArt's ant entries are all CC-BY / OGA-BY, and
 * Kenney's CC0 catalogue has no insects at all — so rather than ship art
 * with murky or attribution-encumbered licensing, the ants, predators and
 * food here are drawn as vector art.
 *
 * WHY VECTOR AND NOT AN <img> SPRITE SHEET
 * ----------------------------------------
 * Every ant needs its colony's hue, so a fixed bitmap sheet would need one
 * variant per colony anyway. Drawing the sprite with Canvas2D paths gives
 * us the same result an SVG data-URI would (identical primitives: beziers,
 * gradients, alpha) with none of the async decode — so `preloadSprites()`
 * genuinely has nothing to wait on and the very first frame is already
 * correct. Nothing is drawn from paths in the hot loop, though: each
 * (caste, hue, task-tint, leg-frame, mip) combination is rasterised **once**
 * into a small offscreen canvas and afterwards blitted with a rotate, so a
 * beast-tier frame with thousands of ants is thousands of `drawImage`s.
 *
 * COORDINATE CONTRACT
 * -------------------
 * Every exported draw function takes **screen-space** pixels and a size in
 * **screen** pixels. The camera transform is the renderer's business; none
 * of these functions read or mutate camera state. `heading` is radians with
 * 0 = facing +X (screen right), matching `AntSnapshot.heading`.
 * `sizePx` for an ant/predator is the body length nose-to-tail.
 */

import type { AntTask, Caste } from '../sim/types';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface RenderQualityFlags {
  /** Mirrors `PerformanceProfile.render.antLegAnimation`. */
  legAnimation: boolean;
}

export interface AntDrawOptions {
  caste: Caste;
  /** 0..360 — the ant's phenotype hue (`AntSnapshot.genetics.hue`). */
  colonyHue: number;
  carrying?: boolean;
  task?: AntTask;
  selected?: boolean;
  /** Free-running gait phase in radians; the renderer owns the accumulator. */
  legPhase?: number;
  quality?: RenderQualityFlags;
}

export type PredatorKind = 'beetle' | 'spider' | 'bird';

export interface PredatorDrawOptions {
  kind: PredatorKind;
  /** 0..1. Below ~0.7 the creature starts showing wounds. */
  healthFrac?: number;
}

export type FoodKind = 'seed' | 'fruit' | 'carcass' | 'nectar';

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/** Below this the ant is fewer pixels than it has body parts — draw a speck. */
const MIN_DETAIL_PX = 3;
/** Rasterised body lengths. Bigger than the largest = draw vectors directly. */
const MIP_L = [8, 16, 32];
/** Sprite canvas side, as a multiple of body length. Covers legs + antennae
 * at any rotation (the furthest point is a front tarsus at ~0.93 L). */
const SPRITE_PAD = 1.95;
/** Quantised gait positions. 8 reads as continuous at ant scale. */
const LEG_FRAMES = 8;
/** Safety valve: a pathological world (every colony a different hue, every
 * caste on screen) shouldn't grow the atlas without bound. */
const MAX_CACHED_SPRITES = 1024;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hsl(h: number, s: number, l: number, a = 1): string {
  const hh = ((h % 360) + 360) % 360;
  const ss = clamp(s, 0, 100).toFixed(1);
  const ll = clamp(l, 0, 100).toFixed(1);
  return a >= 1 ? `hsl(${hh.toFixed(1)}, ${ss}%, ${ll}%)` : `hsla(${hh.toFixed(1)}, ${ss}%, ${ll}%, ${a})`;
}

/** Shortest-arc hue interpolation, so a blue colony tinting toward "alarm
 * red" goes through magenta rather than sweeping the whole spectrum. */
function mixHue(a: number, b: number, t: number): number {
  const d = (((b - a + 540) % 360) - 180) * t;
  return ((a + d) % 360 + 360) % 360;
}

interface Palette {
  shadow: string;
  dark: string;
  mid: string;
  light: string;
  rim: string;
  leg: string;
  legLight: string;
  eye: string;
  alarm: boolean;
}

function makePalette(hue: number, satAdd: number, lightAdd: number, alarm: boolean): Palette {
  // Real ant chitin is a dark, low-value, warm shell with a hard specular
  // highlight. We keep the mid-tone deliberately darker than any of the
  // terrain biomes so ants stay readable on sand *and* on leaf litter.
  const s = clamp(58 + satAdd, 0, 92);
  const base = clamp(30 + lightAdd, 10, 60);
  return {
    shadow: hsl(hue, s * 0.75, base * 0.38),
    dark: hsl(hue, s, base * 0.60),
    mid: hsl(hue, s, base),
    light: hsl(hue, s * 0.92, base * 1.55),
    rim: hsl(hue, s * 0.5, Math.min(90, base * 2.5)),
    leg: hsl(hue, s * 0.8, base * 0.5),
    legLight: hsl(hue, s * 0.7, base * 0.95),
    eye: 'rgba(10,8,6,0.94)',
    alarm,
  };
}

/** Task colouring. We shift the *colony* hue toward the task hue instead of
 * replacing it, so a player can still tell whose soldiers are whose in a
 * brawl. `id` keeps the variants apart in the sprite cache. */
const TASK_TINT: Partial<Record<AntTask, { id: number; hue: number; w: number; sat: number; light: number; alarm: boolean }>> = {
  engaging: { id: 1, hue: 4, w: 0.6, sat: 16, light: 5, alarm: true },
  fleeing: { id: 2, hue: 46, w: 0.5, sat: 10, light: 9, alarm: false },
  returningWithFood: { id: 3, hue: 96, w: 0.22, sat: 2, light: 4, alarm: false },
};

const paletteCache = new Map<string, Palette>();

function paletteFor(hueBucket: number, tintId: number): Palette {
  const key = `${hueBucket}|${tintId}`;
  let p = paletteCache.get(key);
  if (!p) {
    const tint = tintId === 1 ? TASK_TINT.engaging! : tintId === 2 ? TASK_TINT.fleeing! : tintId === 3 ? TASK_TINT.returningWithFood! : null;
    const hue = hueBucket * 20;
    p = makePalette(hue, tint ? tint.sat : 0, tint ? tint.light : 0, tint ? tint.alarm : false);
    paletteCache.set(key, p);
  }
  return p;
}

function bucketFor(opts: AntDrawOptions): { hueBucket: number; tintId: number } {
  const tint = opts.task ? TASK_TINT[opts.task] : undefined;
  const hue = tint ? mixHue(opts.colonyHue, tint.hue, tint.w) : opts.colonyHue;
  return { hueBucket: Math.round((((hue % 360) + 360) % 360) / 20) % 18, tintId: tint ? tint.id : 0 };
}

// ---------------------------------------------------------------------------
// Caste anatomy. All numbers are fractions of body length; the ant is drawn
// in a unit-length local space (nose at roughly +0.5, gaster tip at -0.5)
// and scaled by the caller, so one set of paths serves every zoom level.
// ---------------------------------------------------------------------------

interface CasteShape {
  gx: number; grx: number; gry: number; // gaster
  tx: number; trx: number; try_: number; // thorax / mesosoma
  hx: number; hl: number; hw: number; // head half-length / half-width
  mand: number; // mandible length multiplier
  legW: number; // leg thickness multiplier
  wings: boolean;
  grub: boolean;
}

const SHAPES: Record<Caste, CasteShape> = {
  worker: { gx: -0.295, grx: 0.200, gry: 0.148, tx: 0.055, trx: 0.150, try_: 0.086, hx: 0.325, hl: 0.112, hw: 0.110, mand: 1.0, legW: 1.0, wings: false, grub: false },
  // Majors: same body, dramatically bigger head and sabre mandibles. That
  // head-to-body ratio is the whole visual tell for a soldier at 6 px.
  soldier: { gx: -0.300, grx: 0.203, gry: 0.156, tx: 0.040, trx: 0.148, try_: 0.098, hx: 0.320, hl: 0.140, hw: 0.156, mand: 1.75, legW: 1.22, wings: false, grub: false },
  queen: { gx: -0.310, grx: 0.250, gry: 0.196, tx: 0.082, trx: 0.168, try_: 0.124, hx: 0.352, hl: 0.108, hw: 0.114, mand: 1.05, legW: 1.15, wings: false, grub: false },
  drone: { gx: -0.298, grx: 0.190, gry: 0.138, tx: 0.062, trx: 0.150, try_: 0.104, hx: 0.336, hl: 0.098, hw: 0.116, mand: 0.8, legW: 0.92, wings: true, grub: false },
  alateQueen: { gx: -0.305, grx: 0.232, gry: 0.182, tx: 0.078, trx: 0.164, try_: 0.118, hx: 0.348, hl: 0.108, hw: 0.116, mand: 1.05, legW: 1.12, wings: true, grub: false },
  larva: { gx: 0, grx: 0.34, gry: 0.20, tx: 0, trx: 0, try_: 0, hx: 0.26, hl: 0.07, hw: 0.08, mand: 0, legW: 0, wings: false, grub: true },
};

// Leg rig. Index 0 = fore, 1 = mid, 2 = hind.
const LEG_BX = [0.168, 0.056, -0.058];
const LEG_ANGLE = [42, 95, 143]; // degrees off +X, swept toward this side
const LEG_BEND = [-32, 22, 27]; // tibia angle offset — gives the knee its kink
const LEG_FEMUR = [0.27, 0.29, 0.30];
const LEG_TIBIA = [0.30, 0.325, 0.335];
const LEG_SWING = 15; // degrees

// ---------------------------------------------------------------------------
// Unit-space ant drawing. `ctx` is expected to already be translated to the
// ant's position, rotated to its heading, and scaled by its body length.
// ---------------------------------------------------------------------------

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot = 0) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, TAU);
}

/** Soft grounded shadow. Drawn first, under everything, so ants sit *on* the
 * terrain instead of floating above it like decals. */
function drawContactShadow(ctx: CanvasRenderingContext2D, spread: number) {
  ctx.save();
  ctx.translate(0.02, 0.10);
  ctx.scale(1, 0.58);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, spread);
  g.addColorStop(0, 'rgba(0,0,0,0.34)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.20)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, spread, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawLegs(ctx: CanvasRenderingContext2D, sh: CasteShape, phase: number, animate: boolean) {
  const by = sh.try_ * 0.9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 3; i++) {
    for (let k = 0; k < 2; k++) {
      const s = k === 0 ? -1 : 1;
      // Alternating tripod: fore+hind of one side swing with the mid leg of
      // the other. That's the gait a real ant uses, and it's legible even as
      // a 10 px silhouette.
      const group = (i + (s > 0 ? 1 : 0)) % 2;
      const swing = animate ? Math.sin(phase + group * Math.PI) * LEG_SWING : (i - 1) * 4;
      const lift = animate ? Math.max(0, Math.sin(phase + group * Math.PI + 1.2)) : 0;

      const a = (LEG_ANGLE[i] + swing) * DEG * s;
      const b = (LEG_ANGLE[i] + swing + LEG_BEND[i]) * DEG * s;
      const bx = LEG_BX[i];
      const byy = by * s;
      const fem = LEG_FEMUR[i];
      const tib = LEG_TIBIA[i] * (1 - lift * 0.14);
      const kx = bx + Math.cos(a) * fem;
      const ky = byy + Math.sin(a) * fem;
      const fx = kx + Math.cos(b) * tib;
      const fy = ky + Math.sin(b) * tib;

      ctx.beginPath();
      ctx.moveTo(bx, byy);
      ctx.lineTo(kx, ky);
      ctx.stroke();
      ctx.save();
      ctx.lineWidth *= 0.72;
      ctx.beginPath();
      ctx.moveTo(kx, ky);
      ctx.lineTo(fx, fy);
      ctx.stroke();
      // Tarsus — the little foot pad that makes legs read as touching ground.
      ctx.beginPath();
      ctx.arc(fx, fy, ctx.lineWidth * 0.85, 0, TAU);
      ctx.fill();
      ctx.restore();
    }
  }
}

function gasterPath(ctx: CanvasRenderingContext2D, sh: CasteShape) {
  const { gx, grx: rx, gry: ry } = sh;
  ctx.beginPath();
  ctx.moveTo(gx + rx * 1.0, 0); // petiole attachment — narrow
  ctx.bezierCurveTo(gx + rx * 0.86, -ry * 0.60, gx + rx * 0.15, -ry * 1.0, gx - rx * 0.42, -ry * 0.80);
  ctx.bezierCurveTo(gx - rx * 0.94, -ry * 0.52, gx - rx * 1.12, -ry * 0.20, gx - rx * 1.14, 0);
  ctx.bezierCurveTo(gx - rx * 1.12, ry * 0.20, gx - rx * 0.94, ry * 0.52, gx - rx * 0.42, ry * 0.80);
  ctx.bezierCurveTo(gx + rx * 0.15, ry * 1.0, gx + rx * 0.86, ry * 0.60, gx + rx * 1.0, 0);
  ctx.closePath();
}

function headPath(ctx: CanvasRenderingContext2D, sh: CasteShape) {
  const { hx, hl, hw } = sh;
  // Widest across the back, narrowing to the clypeus, with the concave
  // posterior margin that makes an ant head an ant head from above.
  ctx.beginPath();
  ctx.moveTo(hx + hl * 0.92, 0);
  ctx.bezierCurveTo(hx + hl * 0.90, -hw * 0.52, hx + hl * 0.44, -hw * 0.94, hx - hl * 0.18, -hw * 1.0);
  ctx.bezierCurveTo(hx - hl * 0.78, -hw * 1.0, hx - hl * 1.02, -hw * 0.62, hx - hl * 0.96, -hw * 0.14);
  ctx.quadraticCurveTo(hx - hl * 0.80, 0, hx - hl * 0.96, hw * 0.14);
  ctx.bezierCurveTo(hx - hl * 1.02, hw * 0.62, hx - hl * 0.78, hw * 1.0, hx - hl * 0.18, hw * 1.0);
  ctx.bezierCurveTo(hx + hl * 0.44, hw * 0.94, hx + hl * 0.90, hw * 0.52, hx + hl * 0.92, 0);
  ctx.closePath();
}

function drawMandible(ctx: CanvasRenderingContext2D, sh: CasteShape, s: number) {
  const { hx, hl, hw } = sh;
  const m = sh.mand;
  const bx = hx + hl * 0.70;
  const tipX = hx + hl * (0.95 + 0.95 * m);
  const w = hw * (0.13 + 0.08 * m);
  ctx.beginPath();
  ctx.moveTo(bx, s * (hw * 0.56 - w));
  // Bow outward, then hook back toward the midline — a closed pair of tongs.
  ctx.quadraticCurveTo(hx + hl * (0.95 + 0.55 * m), s * hw * (0.86 + 0.20 * m), tipX, s * hw * 0.10);
  ctx.quadraticCurveTo(hx + hl * (0.95 + 0.34 * m), s * hw * (0.44 + 0.10 * m), bx, s * (hw * 0.56 + w));
  ctx.closePath();
  ctx.fill();
  if (m > 1.3) {
    // Majors get a visible inner tooth.
    ctx.beginPath();
    ctx.moveTo(hx + hl * (0.95 + 0.55 * m), s * hw * 0.62);
    ctx.lineTo(hx + hl * (0.95 + 0.42 * m), s * hw * 0.20);
    ctx.lineTo(hx + hl * (0.95 + 0.70 * m), s * hw * 0.34);
    ctx.closePath();
    ctx.fill();
  }
}

function drawAntenna(ctx: CanvasRenderingContext2D, sh: CasteShape, s: number) {
  const { hx, hl, hw } = sh;
  const ax = hx + hl * 0.40;
  const ay = s * hw * 0.74;
  const ex = hx + hl * 1.02;
  const ey = s * hw * 1.30;
  const tx = hx + hl * 1.78;
  const ty = s * hw * 0.86;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(ex, ey); // scape
  ctx.quadraticCurveTo(hx + hl * 1.44, s * hw * 1.32, tx, ty); // elbowed funiculus
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(tx, ty, ctx.lineWidth * 1.15, 0, TAU);
  ctx.fill();
}

function drawWings(ctx: CanvasRenderingContext2D, sh: CasteShape) {
  ctx.save();
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? -1 : 1;
    for (let w = 0; w < 2; w++) {
      const len = w === 0 ? 1 : 0.66;
      const off = w === 0 ? 0 : 0.05;
      ctx.beginPath();
      ctx.moveTo(sh.tx + 0.02, s * 0.02);
      ctx.quadraticCurveTo(sh.tx - 0.16 * len, s * (0.30 + off) * len, sh.tx - 0.52 * len, s * (0.26 + off) * len);
      ctx.quadraticCurveTo(sh.tx - 0.22 * len, s * (0.12 + off) * len, sh.tx + 0.02, s * 0.02);
      ctx.closePath();
      ctx.fillStyle = 'rgba(228,242,255,0.34)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.40)';
      ctx.lineWidth = 0.008;
      ctx.stroke();
      // A couple of veins so the wings aren't blank glass.
      ctx.strokeStyle = 'rgba(190,215,235,0.45)';
      ctx.lineWidth = 0.005;
      ctx.beginPath();
      ctx.moveTo(sh.tx + 0.01, s * 0.02);
      ctx.quadraticCurveTo(sh.tx - 0.22 * len, s * 0.20 * len, sh.tx - 0.48 * len, s * 0.24 * len);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawGrub(ctx: CanvasRenderingContext2D, pal: Palette) {
  // Larvae never surface, but the underground cutaway wants them.
  const g = ctx.createLinearGradient(0, -0.2, 0, 0.22);
  g.addColorStop(0, '#fbf3d8');
  g.addColorStop(1, '#d9c79a');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-0.34, 0.02);
  ctx.bezierCurveTo(-0.30, -0.20, 0.10, -0.24, 0.28, -0.10);
  ctx.bezierCurveTo(0.40, 0.00, 0.34, 0.18, 0.16, 0.20);
  ctx.bezierCurveTo(-0.06, 0.22, -0.24, 0.20, -0.34, 0.02);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(160,140,100,0.5)';
  ctx.lineWidth = 0.018;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo(i * 0.11, -0.17);
    ctx.quadraticCurveTo(i * 0.11 + 0.02, 0, i * 0.11, 0.17);
    ctx.stroke();
  }
  ctx.fillStyle = pal.dark;
  ctx.beginPath();
  ctx.arc(0.29, -0.04, 0.045, 0, TAU);
  ctx.fill();
}

/** The whole ant, in unit-length local space, facing +X. */
function drawAntUnit(ctx: CanvasRenderingContext2D, sh: CasteShape, pal: Palette, phase: number, animate: boolean) {
  if (sh.grub) {
    drawContactShadow(ctx, 0.4);
    drawGrub(ctx, pal);
    return;
  }

  drawContactShadow(ctx, 0.52);

  // --- Legs, under the body.
  ctx.strokeStyle = pal.leg;
  ctx.fillStyle = pal.leg;
  ctx.lineWidth = 0.026 * sh.legW;
  drawLegs(ctx, sh, phase, animate);

  // Shared top-lit gradient: highlight toward -Y, shade toward +Y. It rotates
  // with the ant, which is the usual compromise for rotated sprites and reads
  // as a curved, shiny shell rather than a flat blob.
  const shell = ctx.createLinearGradient(0, -0.19, 0, 0.20);
  shell.addColorStop(0, pal.light);
  shell.addColorStop(0.42, pal.mid);
  shell.addColorStop(1, pal.dark);

  // --- Gaster (abdomen).
  ctx.fillStyle = shell;
  ctx.strokeStyle = pal.shadow;
  ctx.lineWidth = 0.016;
  gasterPath(ctx, sh);
  ctx.fill();
  ctx.stroke();
  // Tergite (segment) seams.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 0.012;
  for (let i = 1; i <= 2; i++) {
    const sx = sh.gx + sh.grx * (0.55 - i * 0.52);
    ctx.beginPath();
    ctx.moveTo(sx, -sh.gry * (0.86 - i * 0.10));
    ctx.quadraticCurveTo(sx - sh.grx * 0.12, 0, sx, sh.gry * (0.86 - i * 0.10));
    ctx.stroke();
  }

  // --- Petiole: the two little nodes that make an ant an ant and not a wasp.
  ctx.fillStyle = pal.dark;
  const pmid = (sh.gx + sh.grx + sh.tx - sh.trx) * 0.5;
  ellipse(ctx, pmid + 0.018, 0, 0.030, 0.034);
  ctx.fill();
  ellipse(ctx, pmid - 0.030, 0, 0.026, 0.030);
  ctx.fill();

  // --- Thorax (mesosoma) with a pronotal hump at the front.
  ctx.fillStyle = shell;
  ctx.strokeStyle = pal.shadow;
  ctx.lineWidth = 0.014;
  ellipse(ctx, sh.tx, 0, sh.trx, sh.try_);
  ctx.fill();
  ctx.stroke();
  ellipse(ctx, sh.tx + sh.trx * 0.52, 0, sh.trx * 0.48, sh.try_ * 1.02);
  ctx.fill();
  ctx.stroke();

  // --- Mandibles, behind the head so they tuck under the clypeus.
  ctx.fillStyle = pal.dark;
  drawMandible(ctx, sh, -1);
  drawMandible(ctx, sh, 1);

  // --- Head.
  ctx.fillStyle = shell;
  ctx.strokeStyle = pal.shadow;
  ctx.lineWidth = 0.015;
  headPath(ctx, sh);
  ctx.fill();
  ctx.stroke();

  // --- Carapace sheen: a soft specular on the gaster and a glint on the head.
  const sheen = ctx.createRadialGradient(sh.gx + sh.grx * 0.12, -sh.gry * 0.42, 0, sh.gx + sh.grx * 0.12, -sh.gry * 0.42, sh.grx * 0.85);
  sheen.addColorStop(0, 'rgba(255,255,255,0.40)');
  sheen.addColorStop(0.55, 'rgba(255,255,255,0.10)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ellipse(ctx, sh.gx + sh.grx * 0.05, -sh.gry * 0.30, sh.grx * 0.70, sh.gry * 0.52, -0.25);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.26)';
  ellipse(ctx, sh.hx - sh.hl * 0.10, -sh.hw * 0.44, sh.hl * 0.52, sh.hw * 0.26, -0.2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ellipse(ctx, sh.tx, -sh.try_ * 0.42, sh.trx * 0.62, sh.try_ * 0.28, 0);
  ctx.fill();

  // --- Compound eyes.
  ctx.fillStyle = pal.eye;
  for (const s of [-1, 1]) {
    ellipse(ctx, sh.hx + sh.hl * 0.06, s * sh.hw * 0.64, sh.hl * 0.22, sh.hw * 0.20, 0);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(sh.hx + sh.hl * 0.13, s * sh.hw * 0.70, sh.hl * 0.07, 0, TAU);
    ctx.fill();
  }

  // --- Antennae.
  ctx.strokeStyle = pal.leg;
  ctx.fillStyle = pal.leg;
  ctx.lineWidth = 0.019;
  ctx.lineCap = 'round';
  drawAntenna(ctx, sh, -1);
  drawAntenna(ctx, sh, 1);

  if (sh.wings) drawWings(ctx, sh);

  if (pal.alarm) {
    // Fighting ants get a hot rim so a brawl reads instantly at any zoom.
    ctx.strokeStyle = 'rgba(255,90,60,0.75)';
    ctx.lineWidth = 0.022;
    gasterPath(ctx, sh);
    ctx.stroke();
    headPath(ctx, sh);
    ctx.stroke();
  }
}

/** The crumb clamped in the mandibles. Drawn outside the cached sprite so
 * "carrying" doesn't double the size of the atlas. */
function drawCrumb(ctx: CanvasRenderingContext2D, sizePx: number) {
  const r = sizePx * 0.115;
  const x = sizePx * 0.56;
  ctx.save();
  ctx.translate(x, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(r * 0.18, r * 0.35, r * 1.0, r * 0.7, 0, 0, TAU);
  ctx.fill();
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.25);
  g.addColorStop(0, '#f0dfa0');
  g.addColorStop(0.55, '#c8a259');
  g.addColorStop(1, '#7f5c22');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(-r, -r * 0.35);
  ctx.lineTo(-r * 0.25, -r);
  ctx.lineTo(r * 0.85, -r * 0.5);
  ctx.lineTo(r, r * 0.45);
  ctx.lineTo(r * 0.1, r);
  ctx.lineTo(-r * 0.9, r * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(90,62,20,0.6)';
  ctx.lineWidth = Math.max(0.4, r * 0.14);
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Sprite cache
// ---------------------------------------------------------------------------

const antCache = new Map<string, HTMLCanvasElement>();

function bakeAntSprite(caste: Caste, hueBucket: number, tintId: number, frame: number, mip: number, animate: boolean): HTMLCanvasElement {
  const L = MIP_L[mip];
  const side = Math.max(4, Math.ceil(L * SPRITE_PAD));
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(side / 2, side / 2);
  ctx.scale(L, L);
  const phase = (frame / LEG_FRAMES) * TAU;
  drawAntUnit(ctx, SHAPES[caste] ?? SHAPES.worker, paletteFor(hueBucket, tintId), phase, animate);
  return canvas;
}

function getAntSprite(caste: Caste, hueBucket: number, tintId: number, frame: number, mip: number, animate: boolean): HTMLCanvasElement {
  const key = `${caste}|${hueBucket}|${tintId}|${frame}|${mip}|${animate ? 1 : 0}`;
  let c = antCache.get(key);
  if (!c) {
    if (antCache.size > MAX_CACHED_SPRITES) antCache.clear();
    c = bakeAntSprite(caste, hueBucket, tintId, frame, mip, animate);
    antCache.set(key, c);
  }
  return c;
}

function pickMip(sizePx: number): number {
  for (let i = 0; i < MIP_L.length; i++) if (sizePx <= MIP_L[i] * 1.12) return i;
  return -1;
}

// ---------------------------------------------------------------------------
// drawAnt
// ---------------------------------------------------------------------------

export function drawAnt(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  headingRadians: number,
  sizePx: number,
  opts: AntDrawOptions,
): void {
  if (!(sizePx > 0.2)) return;
  const { hueBucket, tintId } = bucketFor(opts);

  if (sizePx < MIN_DETAIL_PX) {
    // Zoomed all the way out: thousands of these per frame. One fillRect.
    const pal = paletteFor(hueBucket, tintId);
    const s = Math.max(1, sizePx * 0.8);
    ctx.fillStyle = pal.dark;
    ctx.fillRect(screenX - s * 0.5, screenY - s * 0.5, s, s);
    return;
  }

  const caste = SHAPES[opts.caste] ? opts.caste : 'worker';
  const animate = (opts.quality?.legAnimation ?? true) && sizePx >= 4;
  const frame = animate ? (Math.floor(((opts.legPhase ?? 0) / TAU) * LEG_FRAMES) % LEG_FRAMES + LEG_FRAMES) % LEG_FRAMES : 0;
  const mip = pickMip(sizePx);

  ctx.save();
  ctx.translate(screenX, screenY);
  ctx.rotate(headingRadians);
  if (mip < 0) {
    // Zoomed right in — few ants on screen, so draw real vectors for crispness.
    ctx.save();
    ctx.scale(sizePx, sizePx);
    drawAntUnit(ctx, SHAPES[caste], paletteFor(hueBucket, tintId), (opts.legPhase ?? 0), animate);
    ctx.restore();
  } else {
    const sprite = getAntSprite(caste, hueBucket, tintId, frame, mip, animate);
    const k = sizePx / MIP_L[mip];
    const w = sprite.width * k;
    ctx.drawImage(sprite, -w * 0.5, -w * 0.5, w, w);
  }
  if (opts.carrying && sizePx >= 5) drawCrumb(ctx, sizePx);
  ctx.restore();

  if (opts.selected) {
    const r = sizePx * 0.95;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,224,102,0.95)';
    ctx.lineWidth = Math.max(1, sizePx * 0.07);
    ctx.beginPath();
    ctx.arc(screenX, screenY, r, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,224,102,0.30)';
    ctx.lineWidth = Math.max(2, sizePx * 0.2);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Predators
// ---------------------------------------------------------------------------

function jointedLeg(ctx: CanvasRenderingContext2D, bx: number, by: number, a1: number, l1: number, a2: number, l2: number) {
  const kx = bx + Math.cos(a1) * l1;
  const ky = by + Math.sin(a1) * l1;
  const fx = kx + Math.cos(a2) * l2;
  const fy = ky + Math.sin(a2) * l2;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(kx, ky);
  ctx.lineTo(fx, fy);
  ctx.stroke();
}

function drawBeetleUnit(ctx: CanvasRenderingContext2D) {
  drawContactShadow(ctx, 0.55);

  ctx.strokeStyle = '#1b140d';
  ctx.lineWidth = 0.032;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) {
      const a = (46 + i * 50) * DEG * s;
      jointedLeg(ctx, 0.16 - i * 0.12, s * 0.10, a, 0.22, a + 34 * DEG * s, 0.20);
    }
  }

  // Elytra — hard, glossy wing cases with a centre seam.
  const body = ctx.createLinearGradient(0, -0.26, 0, 0.28);
  body.addColorStop(0, '#6b4f2c');
  body.addColorStop(0.35, '#3d2b17');
  body.addColorStop(1, '#191008');
  ctx.fillStyle = body;
  ctx.strokeStyle = '#100a05';
  ctx.lineWidth = 0.018;
  ellipse(ctx, -0.08, 0, 0.40, 0.29);
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 0.02;
  ctx.beginPath();
  ctx.moveTo(0.28, 0);
  ctx.lineTo(-0.47, 0);
  ctx.stroke();
  // Punctate striations along each elytron.
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 0.011;
  for (const s of [-1, 1]) {
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(0.24, s * i * 0.06);
      ctx.quadraticCurveTo(-0.10, s * (i * 0.075 + 0.03), -0.42, s * i * 0.045);
      ctx.stroke();
    }
  }
  ctx.fillStyle = 'rgba(255,240,210,0.20)';
  ellipse(ctx, -0.06, -0.14, 0.26, 0.08, -0.12);
  ctx.fill();

  // Pronotum + head.
  ctx.fillStyle = '#33240f';
  ctx.strokeStyle = '#120c05';
  ctx.lineWidth = 0.016;
  ellipse(ctx, 0.30, 0, 0.16, 0.20);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#241a0b';
  ellipse(ctx, 0.45, 0, 0.10, 0.12);
  ctx.fill();
  ctx.stroke();
  // Pincers.
  ctx.strokeStyle = '#171008';
  ctx.lineWidth = 0.03;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0.52, s * 0.08);
    ctx.quadraticCurveTo(0.70, s * 0.20, 0.76, s * 0.04);
    ctx.stroke();
  }
  ctx.lineWidth = 0.016;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0.47, s * 0.09);
    ctx.lineTo(0.60, s * 0.24);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(250,230,190,0.85)';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(0.47, s * 0.07, 0.022, 0, TAU);
    ctx.fill();
  }
}

function drawSpiderUnit(ctx: CanvasRenderingContext2D) {
  drawContactShadow(ctx, 0.5);

  ctx.strokeStyle = '#14100d';
  ctx.lineWidth = 0.028;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 0; i < 4; i++) {
    for (const s of [-1, 1]) {
      const a = (28 + i * 44) * DEG * s;
      jointedLeg(ctx, 0.14 - i * 0.05, s * 0.08, a - 16 * DEG * s, 0.30, a + 40 * DEG * s, 0.34);
    }
  }

  const abd = ctx.createRadialGradient(-0.20, -0.10, 0.02, -0.16, 0, 0.34);
  abd.addColorStop(0, '#514334');
  abd.addColorStop(0.6, '#2b2119');
  abd.addColorStop(1, '#120d09');
  ctx.fillStyle = abd;
  ctx.strokeStyle = '#0c0806';
  ctx.lineWidth = 0.016;
  ellipse(ctx, -0.18, 0, 0.33, 0.28);
  ctx.fill();
  ctx.stroke();
  // Dorsal chevrons.
  ctx.strokeStyle = 'rgba(228,206,160,0.5)';
  ctx.lineWidth = 0.022;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.moveTo(-0.04 - i * 0.13, -0.14 + i * 0.02);
    ctx.lineTo(-0.12 - i * 0.13, 0);
    ctx.lineTo(-0.04 - i * 0.13, 0.14 - i * 0.02);
    ctx.stroke();
  }

  ctx.fillStyle = '#2e251c';
  ctx.strokeStyle = '#0c0806';
  ctx.lineWidth = 0.014;
  ellipse(ctx, 0.20, 0, 0.20, 0.17);
  ctx.fill();
  ctx.stroke();
  // Eight eyes.
  ctx.fillStyle = '#0a0a0c';
  for (const s of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const r = i < 2 ? 0.026 : 0.018;
      ctx.beginPath();
      ctx.arc(0.30 + (i % 2) * 0.05, s * (0.03 + Math.floor(i / 2) * 0.07), r, 0, TAU);
      ctx.fill();
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(0.31, s * 0.035, 0.009, 0, TAU);
    ctx.fill();
  }
  // Fangs.
  ctx.strokeStyle = '#0d0906';
  ctx.lineWidth = 0.026;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(0.36, s * 0.07);
    ctx.quadraticCurveTo(0.46, s * 0.12, 0.48, s * 0.02);
    ctx.stroke();
  }
}

function drawBirdUnit(ctx: CanvasRenderingContext2D) {
  ctx.save();
  ctx.translate(0.04, 0.16);
  ctx.scale(1, 0.5);
  const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.6);
  sg.addColorStop(0, 'rgba(0,0,0,0.32)');
  sg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = sg;
  ctx.beginPath();
  ctx.arc(0, 0, 0.6, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Tail fan.
  ctx.fillStyle = '#5a4128';
  ctx.beginPath();
  ctx.moveTo(-0.26, -0.10);
  ctx.lineTo(-0.62, -0.20);
  ctx.lineTo(-0.66, 0);
  ctx.lineTo(-0.62, 0.20);
  ctx.lineTo(-0.26, 0.10);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 0.012;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(-0.28, i * 0.05);
    ctx.lineTo(-0.63, i * 0.16);
    ctx.stroke();
  }

  // Wings, swept back — a top-down bird silhouette is mostly wing.
  for (const s of [-1, 1]) {
    const wg = ctx.createLinearGradient(0, 0, -0.2, s * 0.6);
    wg.addColorStop(0, '#7b5a35');
    wg.addColorStop(1, '#3d2c19');
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.moveTo(0.12, s * 0.08);
    ctx.quadraticCurveTo(0.02, s * 0.42, -0.34, s * 0.62);
    ctx.quadraticCurveTo(-0.40, s * 0.40, -0.22, s * 0.14);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.30)';
    ctx.lineWidth = 0.012;
    for (let i = 1; i <= 3; i++) {
      ctx.beginPath();
      ctx.moveTo(0.06 - i * 0.05, s * 0.12);
      ctx.quadraticCurveTo(-0.10 - i * 0.04, s * 0.34, -0.30 + i * 0.02, s * (0.60 - i * 0.05));
      ctx.stroke();
    }
  }

  const bg = ctx.createLinearGradient(0, -0.18, 0, 0.2);
  bg.addColorStop(0, '#8a663d');
  bg.addColorStop(1, '#402d19');
  ctx.fillStyle = bg;
  ellipse(ctx, -0.05, 0, 0.32, 0.17);
  ctx.fill();
  ctx.fillStyle = '#6d4e2c';
  ellipse(ctx, 0.28, 0, 0.13, 0.12);
  ctx.fill();
  ctx.fillStyle = '#e8b23c';
  ctx.beginPath();
  ctx.moveTo(0.38, -0.045);
  ctx.lineTo(0.56, 0);
  ctx.lineTo(0.38, 0.045);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#0d0a08';
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(0.31, s * 0.06, 0.022, 0, TAU);
    ctx.fill();
  }
}

export function drawPredator(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  headingRadians: number,
  sizePx: number,
  opts: PredatorDrawOptions,
): void {
  if (!(sizePx > 0.2)) return;
  if (sizePx < MIN_DETAIL_PX) {
    const s = Math.max(1.5, sizePx);
    ctx.fillStyle = opts.kind === 'bird' ? '#4a3620' : '#191410';
    ctx.fillRect(screenX - s * 0.5, screenY - s * 0.5, s, s);
    return;
  }
  ctx.save();
  ctx.translate(screenX, screenY);
  ctx.rotate(headingRadians);
  ctx.scale(sizePx, sizePx);
  if (opts.kind === 'spider') drawSpiderUnit(ctx);
  else if (opts.kind === 'bird') drawBirdUnit(ctx);
  else drawBeetleUnit(ctx);

  const hp = opts.healthFrac ?? 1;
  if (hp < 0.75) {
    // Visible wounds, so a half-dead beetle looks half dead.
    ctx.fillStyle = `rgba(150,32,18,${Math.min(0.75, (0.75 - hp) * 1.5)})`;
    const marks: [number, number, number][] = [
      [-0.12, -0.11, 0.07],
      [0.06, 0.13, 0.05],
      [-0.28, 0.06, 0.06],
    ];
    for (const [mx, my, mr] of marks) {
      ctx.beginPath();
      ctx.arc(mx, my, mr, 0, TAU);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

/** Deterministic per-item scatter. `seed` should be something stable like the
 * food source's id — never its screen position, or the pile would crawl
 * around as the camera pans. */
function rand(seed: number, i: number): number {
  let h = Math.imul(seed * 73856093 + i * 19349663, 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 15), 0x45d9f3b);
  h ^= h >>> 13;
  return ((h >>> 0) % 100000) / 100000;
}

function drawSeedPile(ctx: CanvasRenderingContext2D, r: number, frac: number, seed: number) {
  const n = Math.max(1, Math.round(3 + frac * 6));
  for (let i = 0; i < n; i++) {
    const a = rand(seed, i) * TAU;
    const d = r * 0.55 * Math.sqrt(rand(seed, i + 40));
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d * 0.85;
    const sr = r * (0.26 + rand(seed, i + 80) * 0.13);
    const rot = rand(seed, i + 120) * TAU;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(sr * 0.18, sr * 0.3, sr * 1.05, sr * 0.68, 0, 0, TAU);
    ctx.fill();
    const g = ctx.createLinearGradient(0, -sr * 0.7, 0, sr * 0.7);
    g.addColorStop(0, '#e8cd8a');
    g.addColorStop(0.5, '#c39a4d');
    g.addColorStop(1, '#7c5a22');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, 0, sr, sr * 0.62, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(96,68,22,0.65)';
    ctx.lineWidth = Math.max(0.4, sr * 0.11);
    ctx.beginPath();
    ctx.moveTo(-sr * 0.75, 0);
    ctx.quadraticCurveTo(0, -sr * 0.18, sr * 0.8, 0);
    ctx.stroke();
    ctx.restore();
  }
}

function drawBerries(ctx: CanvasRenderingContext2D, r: number, frac: number, seed: number) {
  const n = Math.max(1, Math.round(1 + frac * 3));
  for (let i = 0; i < n; i++) {
    const a = rand(seed, i + 7) * TAU;
    const d = i === 0 ? 0 : r * 0.45;
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d * 0.8;
    const br = r * (0.46 + rand(seed, i + 33) * 0.16);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x + br * 0.15, y + br * 0.4, br * 1.0, br * 0.6, 0, 0, TAU);
    ctx.fill();
    const g = ctx.createRadialGradient(x - br * 0.35, y - br * 0.4, br * 0.08, x, y, br);
    g.addColorStop(0, '#ff8f6a');
    g.addColorStop(0.5, '#d94a30');
    g.addColorStop(1, '#7d1d13');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, br, 0, TAU);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.beginPath();
    ctx.ellipse(x - br * 0.34, y - br * 0.38, br * 0.24, br * 0.15, -0.6, 0, TAU);
    ctx.fill();
  }
  // Stem + leaf so it reads as fruit rather than a red ball.
  ctx.strokeStyle = '#4d6b28';
  ctx.lineWidth = Math.max(0.6, r * 0.1);
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.35);
  ctx.quadraticCurveTo(r * 0.25, -r * 0.8, r * 0.55, -r * 0.85);
  ctx.stroke();
  ctx.fillStyle = '#5f8a2e';
  ctx.beginPath();
  ctx.ellipse(r * 0.72, -r * 0.82, r * 0.3, r * 0.14, -0.5, 0, TAU);
  ctx.fill();
}

function drawNectar(ctx: CanvasRenderingContext2D, r: number, frac: number) {
  const rr = r * (0.55 + frac * 0.45);
  // The outline is a closed Catmull-Rom-ish curve through jittered radii
  // rather than a polygon of straight `lineTo` segments — the old version's
  // hard corners made a spill of sugar syrup look like a folded gold foil
  // wrapper. Liquid has no straight edges.
  const pts: [number, number][] = [];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * TAU;
    const k = rr * (0.84 + 0.2 * Math.sin(i * 2.1) + 0.08 * Math.sin(i * 5.3));
    pts.push([Math.cos(a) * k, Math.sin(a) * k * 0.86]);
  }
  const blobPath = () => {
    ctx.beginPath();
    const mid = (i: number): [number, number] => {
      const p = pts[i % pts.length];
      const q = pts[(i + 1) % pts.length];
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    };
    const [sx, sy] = mid(pts.length - 1);
    ctx.moveTo(sx, sy);
    for (let i = 0; i < pts.length; i++) {
      const [mx, my] = mid(i);
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.closePath();
  };

  // Damp halo where the syrup has soaked into the soil around the spill.
  const halo = ctx.createRadialGradient(0, 0, rr * 0.6, 0, 0, rr * 1.35);
  halo.addColorStop(0, 'rgba(120,86,20,0.35)');
  halo.addColorStop(1, 'rgba(120,86,20,0)');
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(0, 0, rr * 1.35, 0, TAU);
  ctx.fill();

  // The body: translucent, so the ground darkens through it the way it does
  // through anything wet, instead of reading as an opaque solid object.
  const g = ctx.createRadialGradient(-rr * 0.3, -rr * 0.35, rr * 0.05, 0, 0, rr);
  g.addColorStop(0, 'rgba(255,232,150,0.80)');
  g.addColorStop(0.55, 'rgba(226,172,46,0.72)');
  g.addColorStop(1, 'rgba(146,96,12,0.66)');
  ctx.fillStyle = g;
  blobPath();
  ctx.fill();

  // Meniscus: bright along the lit rim, dark along the far one — the two
  // together are what make a puddle read as having surface tension.
  ctx.save();
  blobPath();
  ctx.clip();
  ctx.strokeStyle = 'rgba(255,250,214,0.75)';
  ctx.lineWidth = Math.max(0.6, rr * 0.13);
  blobPath();
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = 'rgba(96,60,6,0.45)';
  ctx.lineWidth = Math.max(0.4, rr * 0.05);
  blobPath();
  ctx.stroke();

  // Specular glints.
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.beginPath();
  ctx.ellipse(-rr * 0.3, -rr * 0.35, rr * 0.26, rr * 0.12, -0.5, 0, TAU);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.beginPath();
  ctx.ellipse(rr * 0.22, rr * 0.18, rr * 0.13, rr * 0.06, 0.3, 0, TAU);
  ctx.fill();
}

function drawCarcass(ctx: CanvasRenderingContext2D, r: number, frac: number, seed: number) {
  ctx.save();
  ctx.rotate(rand(seed, 3) * TAU);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.beginPath();
  ctx.ellipse(r * 0.1, r * 0.25, r * 0.95, r * 0.6, 0, 0, TAU);
  ctx.fill();
  // Curled-up dead bug: legs stick up and inward, body is dried and pale.
  ctx.strokeStyle = '#4a3a2c';
  ctx.lineWidth = Math.max(0.6, r * 0.08);
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) {
      const a = (50 + i * 46) * DEG * s;
      const bx = r * (0.25 - i * 0.22);
      jointedLeg(ctx, bx, s * r * 0.1, a, r * 0.34, a + 70 * DEG * s, r * 0.26);
    }
  }
  const g = ctx.createLinearGradient(0, -r * 0.5, 0, r * 0.5);
  g.addColorStop(0, '#c9b295');
  g.addColorStop(1, '#6d5844');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(-r * 0.12, 0, r * 0.5 * (0.6 + frac * 0.4), r * 0.34, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#8a735a';
  ctx.beginPath();
  ctx.arc(r * 0.42, 0, r * 0.18, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = 'rgba(60,45,32,0.5)';
  ctx.lineWidth = Math.max(0.4, r * 0.06);
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.12 + i * r * 0.14, -r * 0.28);
    ctx.lineTo(-r * 0.12 + i * r * 0.14, r * 0.28);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawFood(
  ctx: CanvasRenderingContext2D,
  screenX: number,
  screenY: number,
  radiusPx: number,
  type: FoodKind,
  fullnessFrac: number,
  /** Optional stable id (e.g. `FoodSource.id`) so piles don't reshuffle. */
  seed = 0,
): void {
  const frac = clamp(fullnessFrac, 0, 1);
  const r = Math.max(1, radiusPx * (0.45 + frac * 0.55));
  if (r < 2.2) {
    ctx.fillStyle = type === 'fruit' ? '#c8452c' : type === 'nectar' ? '#e0b23c' : type === 'carcass' ? '#8a735a' : '#c39a4d';
    ctx.beginPath();
    ctx.arc(screenX, screenY, r, 0, TAU);
    ctx.fill();
    return;
  }
  ctx.save();
  ctx.translate(screenX, screenY);
  if (type === 'fruit') drawBerries(ctx, r, frac, seed);
  else if (type === 'nectar') drawNectar(ctx, r, frac);
  else if (type === 'carcass') drawCarcass(ctx, r, frac, seed);
  else drawSeedPile(ctx, r, frac, seed);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Preload
// ---------------------------------------------------------------------------

let preloaded: Promise<void> | null = null;

/**
 * Warms the sprite atlas for the castes and sizes the first frames will ask
 * for. There are no network assets, so this resolves on the next microtask —
 * and because every draw path falls back to drawing vectors inline, the
 * renderer is free to ignore the promise entirely and still look right on
 * frame one.
 */
export function preloadSprites(): Promise<void> {
  if (preloaded) return preloaded;
  preloaded = new Promise<void>((resolve) => {
    try {
      if (typeof document !== 'undefined') {
        for (const caste of ['worker', 'soldier'] as Caste[]) {
          for (let f = 0; f < LEG_FRAMES; f++) getAntSprite(caste, 1, 0, f, 1, true);
        }
      }
    } catch {
      /* Never let sprite warm-up take the sim down. */
    }
    resolve();
  });
  return preloaded;
}

/** Drops every cached raster. Call on a tier switch if you want the memory
 * back; purely an optimisation, correctness never depends on it. */
export function clearSpriteCache(): void {
  antCache.clear();
}
