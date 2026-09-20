import type { ISimulation } from '../sim/facade';
import type { AntSnapshot, ColonySnapshot, FoodSource, LarvaSnapshot, PredatorSnapshot, WorldSnapshot } from '../sim/types';
import type { Vec2 } from '../sim/vec2';
import { Camera } from './camera';
import { bakeTerrain, drawTerrainDetail, drawWetness } from './terrainBaker';
import { drawAnt, drawFood, drawPredator, type FoodKind, type PredatorKind } from './sprites';
import { Effects } from './effects';

interface Raindrop {
  x: number;
  y: number;
  len: number;
  speed: number;
}

interface DustMote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  twinklePhase: number;
}

/** Something the pointer is over. Picking is done in *screen* space so the
 * hit area stays a constant, comfortable number of pixels no matter how far
 * the camera is zoomed out — hunting for a 1px ant with a 1px cursor was the
 * reason clicking felt unreliable. */
export interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PickResult {
  kind: 'ant' | 'colony';
  id: number;
  pos: Vec2;
}

const ANT_PICK_RADIUS_PX = 14;
const NEST_PICK_RADIUS_PX = 24;

const TASK_BLURB: Record<AntSnapshot['task'], string> = {
  exploring: 'searching for food',
  trailFollowing: 'following a scent trail',
  returningEmpty: 'heading home',
  returningWithFood: 'carrying food home',
  patrolling: 'guarding the nest',
  engaging: 'fighting',
  fleeing: 'fleeing',
  nuptialFlight: 'on its nuptial flight',
  foundingSolo: 'founding a colony',
};

/** Body length (nose to tail) in world units, per caste. Screen size is this
 * times the camera zoom. Real size differences between castes are part of how
 * you read a colony at a glance, so they're preserved here rather than drawing
 * every ant the same size and relying on colour. */
const ANT_BODY_LENGTH: Record<AntSnapshot['caste'], number> = {
  larva: 4.8,
  worker: 7,
  soldier: 9.6,
  queen: 12.2,
  drone: 8.4,
  alateQueen: 10.8,
};

const PREDATOR_BODY_LENGTH: Record<PredatorSnapshot['kind'], number> = {
  beetle: 12,
  spider: 11,
  bird: 20,
};

/** Deterministic 0..1 from one integer. Used for scatter that must look random
 * but stay put across frames — a nest whose soil grains re-rolled every frame
 * would boil. */
function hash01(n: number): number {
  let h = Math.imul(n | 0, 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 15), 0x45d9f3b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/** Side of the tileable screen-space soil-grain texture, in CSS pixels. */
const GRAIN_TILE = 128;

/**
 * Canvas2D renderer. Reads a `WorldSnapshot` each frame plus a handful of
 * control-surface getters off `ISimulation` (current tier/profile, surface
 * vs. underground view) — it never mutates simulation state.
 */
export class Renderer {
  readonly camera: Camera;
  private wctx: CanvasRenderingContext2D;
  private fctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private bakedTerrain: HTMLCanvasElement | null = null;
  private bakedScale = 1;
  private bakedBiomeRef: Uint8Array | null = null;

  private legPhases = new Map<number, number>();
  private raindrops: Raindrop[] = [];
  private dustMotes: DustMote[] = [];
  private lightningFlash = 0;
  private clock = 0;
  private lastDt = 1 / 60;

  /** Last snapshot handed to render(), kept so pointer picking can hit-test
   * against exactly what the player is looking at. */
  private lastSnapshot: WorldSnapshot | null = null;
  /** Pointer position in CSS pixels, or null when the pointer left the canvas. */
  private hoverScreen: Vec2 | null = null;
  /** What the pointer is currently over, recomputed each frame. */
  private hovered: PickResult | null = null;
  /** 0..1 fade so the minimap doesn't pop in and out at the threshold. */
  private minimapFade = 0;
  private grainPattern: CanvasPattern | null = null;
  /** Cosmetic particle + shake layer. Public so main.ts can wire sim events
   * straight to it without the renderer having to mirror every one. */
  readonly effects = new Effects();
  private followId: number | null = null;
  private followLostT = 0;
  /** Screen rects the HUD is occupying; the minimap keeps out of them. */
  private reservedRects: ScreenRect[] = [];
  /** Tiny offscreen canvas (one pixel per pheromone cell) used to build the
   * smooth trail glow; reallocated only when the grid size changes. */
  private trailLayer: HTMLCanvasElement | null = null;
  private trailLayerCtx: CanvasRenderingContext2D | null = null;

  constructor(
    private worldCanvas: HTMLCanvasElement,
    private fxCanvas: HTMLCanvasElement,
    private sim: ISimulation,
  ) {
    this.wctx = worldCanvas.getContext('2d')!;
    this.fctx = fxCanvas.getContext('2d')!;
    this.camera = new Camera(sim.getProfile().worldWidth, sim.getProfile().worldHeight);
    this.resize();
  }

  resize() {
    const rect = this.worldCanvas.getBoundingClientRect();
    this.cssW = Math.max(1, rect.width);
    this.cssH = Math.max(1, rect.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.sim.getProfile().maxDevicePixelRatio);
    for (const canvas of [this.worldCanvas, this.fxCanvas]) {
      canvas.width = Math.round(this.cssW * this.dpr);
      canvas.height = Math.round(this.cssH * this.dpr);
    }
    this.wctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  screenToWorld(p: Vec2): Vec2 {
    return this.camera.screenToWorld(p, this.cssW, this.cssH);
  }

  fitWorldView() {
    const p = this.sim.getProfile();
    this.camera.fitWorld(p.worldWidth, p.worldHeight, this.cssW, this.cssH);
  }

  private w2s(p: Vec2): Vec2 {
    return this.camera.worldToScreen(p, this.cssW, this.cssH);
  }

  /**
   * Lock the camera onto one ant and ride along.
   *
   * Watching a single ant's whole errand — out along a trail, onto the food,
   * back to the nest, fed by a nestmate — is the moment the colony stops being
   * a swarm of dots and turns into a thousand individuals. But an ant is a few
   * pixels wide and never stops moving, so manually keeping one in frame is
   * impossible. This makes it one click.
   */
  followAnt(id: number | null) {
    this.followId = id;
    this.followLostT = 0;
  }

  getFollowId(): number | null {
    return this.followId;
  }

  stopFollowing() {
    this.followId = null;
  }

  /** The followed ant in the latest snapshot, if it is still alive. */
  private followTarget(snapshot: WorldSnapshot): AntSnapshot | null {
    if (this.followId === null) return null;
    return snapshot.ants.find((a) => a.id === this.followId) ?? null;
  }

  /**
   * Ease the camera toward the followed ant rather than pinning it dead
   * centre. A hard lock makes the whole world jitter with every step the ant
   * takes; a spring lets the ant drift within the frame and the ground stay
   * still, which is far easier to watch.
   */
  private updateFollow(snapshot: WorldSnapshot, dt: number) {
    if (this.followId === null) return;
    const target = this.followTarget(snapshot);
    if (!target) {
      // The ant died. Hold position for a beat so the death is visible, then
      // release — yanking the camera away at the instant of death hides the
      // one thing the viewer was watching for.
      this.followLostT += dt;
      if (this.followLostT > 1.6) this.followId = null;
      return;
    }
    this.followLostT = 0;
    const k = 1 - Math.pow(0.0001, dt); // critically-damped-ish follow
    this.camera.x += (target.pos.x - this.camera.x) * k;
    this.camera.y += (target.pos.y - this.camera.y) * k;
  }

  /** Called on pointer move. Pass null when the pointer leaves the canvas. */
  setHoverScreen(p: Vec2 | null) {
    this.hoverScreen = p;
  }

  getHovered(): PickResult | null {
    return this.hovered;
  }

  /**
   * Hit-test the last rendered frame at a screen position. Ants win over
   * nests (they sit on top), and both use a generous constant pixel radius
   * so a click doesn't demand pixel-perfect aim at low zoom.
   */
  pickAt(screenPos: Vec2): PickResult | null {
    const snap = this.lastSnapshot;
    if (!snap) return null;

    let best: PickResult | null = null;
    let bestD2 = ANT_PICK_RADIUS_PX * ANT_PICK_RADIUS_PX;
    for (const a of snap.ants) {
      const s = this.w2s(a.pos);
      const dx = s.x - screenPos.x;
      const dy = s.y - screenPos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { kind: 'ant', id: a.id, pos: a.pos };
      }
    }
    if (best) return best;

    bestD2 = NEST_PICK_RADIUS_PX * NEST_PICK_RADIUS_PX;
    for (const c of snap.colonies) {
      const s = this.w2s(c.nestPos);
      const dx = s.x - screenPos.x;
      const dy = s.y - screenPos.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = { kind: 'colony', id: c.id, pos: c.nestPos };
      }
    }
    return best;
  }

  /** True when the whole world already fits on screen, in which case a
   * minimap is redundant clutter. */
  private worldFitsOnScreen(snapshot: WorldSnapshot): boolean {
    const rect = this.camera.visibleWorldRect(this.cssW, this.cssH, 0);
    const coverX = (rect.maxX - rect.minX) / snapshot.width;
    const coverY = (rect.maxY - rect.minY) / snapshot.height;
    return coverX > 0.9 && coverY > 0.9;
  }

  render(snapshot: WorldSnapshot, dtSeconds: number) {
    this.clock += dtSeconds;
    this.lastDt = dtSeconds;
    this.lastSnapshot = snapshot;
    this.camera.stepMomentum(dtSeconds);
    this.updateFollow(snapshot, dtSeconds);
    const profile = this.sim.getProfile();
    const view = this.sim.getView();

    // Re-pick under the cursor every frame: entities move, so a hover that
    // was computed only on pointermove would lag behind or stick.
    this.hovered = view === 'surface' && this.hoverScreen ? this.pickAt(this.hoverScreen) : null;

    // The minimap only earns its space once you're zoomed in far enough that
    // the world no longer fits on screen. Fade rather than pop.
    const wantMinimap = view === 'surface' && !this.worldFitsOnScreen(snapshot);
    const fadeStep = dtSeconds * 4;
    this.minimapFade = wantMinimap
      ? Math.min(1, this.minimapFade + fadeStep)
      : Math.max(0, this.minimapFade - fadeStep);

    this.camera.clampToWorld(snapshot.width, snapshot.height, this.cssW, this.cssH);

    // Effects are cosmetic, so they run on real time and keep moving even
    // while the simulation is paused — a fight that just happened still
    // finishes throwing its sparks.
    this.effects.setBudget({
      density: profile.render.maxParticles >= 200 ? 1 : profile.render.maxParticles >= 90 ? 0.6 : 0.3,
      shake: profile.render.softShadows,
    });
    this.effects.update(dtSeconds);

    this.wctx.save();
    this.wctx.clearRect(0, 0, this.cssW, this.cssH);
    this.fctx.clearRect(0, 0, this.cssW, this.cssH);

    // Screen shake is a canvas translate, not a camera move: the camera feeds
    // hit-testing, and a click during a shake has to land where it was aimed.
    const shake = this.effects.shakeOffset;
    if (shake.x !== 0 || shake.y !== 0) this.wctx.translate(shake.x, shake.y);

    if (view === 'surface') {
      this.renderSurface(snapshot, profile);
      this.effects.render(this.wctx, (p) => this.w2s(p), this.camera.zoom);
    } else {
      this.renderUnderground(snapshot);
    }

    this.wctx.restore();

    this.renderWeatherFx(snapshot, dtSeconds, profile.render.weatherParticles, profile.render.maxParticles);
    this.renderLighting(snapshot);
    if (view === 'surface') this.drawFollowIndicator(snapshot);
    this.drawHoverHighlight();
    if (this.minimapFade > 0.01) this.renderMinimap(snapshot, this.minimapFade);
  }

  /**
   * Mark the ant the camera is riding, and say how to get off.
   *
   * Without this, follow mode is indistinguishable from the camera having
   * developed a mind of its own — the ground slides around and nothing
   * explains why.
   */
  private drawFollowIndicator(snapshot: WorldSnapshot) {
    if (this.followId === null) return;
    const ctx = this.fctx;
    const target = snapshot.ants.find((a) => a.id === this.followId);

    if (target) {
      const s = this.w2s(target.pos);
      const pulse = 1 + Math.sin(this.clock * 4) * 0.12;
      const r = Math.max(14, 18 * this.camera.zoom) * pulse;
      ctx.save();
      ctx.strokeStyle = 'rgba(143, 209, 102, 0.9)';
      ctx.lineWidth = 2;
      // A broken ring reads as a targeting reticle rather than a selection
      // halo, which keeps it distinct from the hover highlight.
      ctx.setLineDash([r * 0.5, r * 0.34]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, this.clock * 1.1, this.clock * 1.1 + Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }

    const label = target ? 'Following this ant · Esc to release' : 'It died. Releasing the camera…';
    ctx.save();
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    const w = ctx.measureText(label).width + 22;
    const x = (this.cssW - w) / 2;
    const y = 16;
    ctx.fillStyle = 'rgba(12, 18, 14, 0.78)';
    ctx.beginPath();
    ctx.roundRect(x, y, w, 26, 13);
    ctx.fill();
    ctx.strokeStyle = 'rgba(143, 209, 102, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = target ? '#cfe8bd' : '#e0a95c';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, this.cssW / 2, y + 13);
    ctx.restore();
  }

  /** A ring around whatever the pointer is over, so it's obvious what a click
   * will select before you commit to it. Drawn on the FX canvas so it sits
   * above the day/night tint rather than getting dimmed by it. */
  private drawHoverHighlight() {
    const hit = this.hovered;
    if (!hit) return;
    const ctx = this.fctx;
    const s = this.w2s(hit.pos);
    const pulse = 1 + Math.sin(this.clock * 4) * 0.08;
    const r = (hit.kind === 'ant' ? 11 : 20) * pulse;

    ctx.save();
    ctx.strokeStyle = 'rgba(255, 236, 140, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r + 1.5, 0, Math.PI * 2);
    ctx.stroke();

    // Say what it is and what it's doing, right there under the cursor —
    // you shouldn't have to click and read a side panel to find out that the
    // dot you're looking at is a hungry worker carrying a seed home.
    const label = this.hoverLabel(hit);
    if (label) {
      ctx.font = '12px system-ui, sans-serif';
      const w = ctx.measureText(label).width;
      const bx = Math.min(Math.max(4, s.x - w / 2 - 7), this.cssW - w - 18);
      const by = s.y + r + 8;
      ctx.fillStyle = 'rgba(10, 16, 12, 0.86)';
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx, by, w + 14, 20, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#eaf3ea';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 7, by + 10);
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  private hoverLabel(hit: PickResult): string | null {
    const snap = this.lastSnapshot;
    if (!snap) return null;
    if (hit.kind === 'ant') {
      const a = snap.ants.find((x) => x.id === hit.id);
      if (!a) return null;
      const hunger = a.energy < 25 ? 'starving' : a.energy < 55 ? 'hungry' : 'fed';
      const caste = a.caste === 'alateQueen' ? 'young queen' : a.caste;
      return `${caste} · ${TASK_BLURB[a.task]} · ${hunger}`;
    }
    const c = snap.colonies.find((x) => x.id === hit.id);
    if (!c) return null;
    const queen = c.queenAlive ? 'queen alive' : 'no queen';
    return `${c.name} · ${c.population} ants · ${Math.round(c.foodStore)} food · ${queen}`;
  }

  // -------------------------------------------------------------------
  // Surface view
  // -------------------------------------------------------------------

  /**
   * Fine soil grain, drawn in **screen space** over the baked terrain.
   *
   * The terrain bake is a fixed-resolution image, so zooming in magnifies it —
   * past about 1:1 the baked speckle stops being soil and becomes big blurry
   * out-of-focus blobs. This pass tiles a small procedural grain texture at a
   * constant pixel size no matter the zoom, so a close-up has real crisp
   * texture under the ants. It is offset by the camera so the grain sticks to
   * the ground and scrolls with it rather than swimming across the screen.
   *
   * Skipped when zoomed out, where the bake already has more detail per screen
   * pixel than the grain would add.
   */
  private drawGroundGrain(topLeft: Vec2) {
    const zoom = this.camera.zoom;
    if (zoom < 1.15) return;
    const ctx = this.wctx;
    if (!this.grainPattern) {
      const tile = document.createElement('canvas');
      tile.width = GRAIN_TILE;
      tile.height = GRAIN_TILE;
      const tctx = tile.getContext('2d')!;
      // Half dark specks, half light: together they read as granular soil
      // rather than as either dirt or dust alone.
      for (let i = 0; i < 900; i++) {
        const x = Math.random() * GRAIN_TILE;
        const y = Math.random() * GRAIN_TILE;
        const dark = Math.random() < 0.55;
        tctx.fillStyle = dark ? 'rgba(40,28,16,0.20)' : 'rgba(228,206,170,0.14)';
        tctx.fillRect(x, y, 1 + (Math.random() < 0.2 ? 1 : 0), 1);
      }
      this.grainPattern = ctx.createPattern(tile, 'repeat');
    }
    if (!this.grainPattern) return;

    // Fade the grain in over the zoom range where the bake starts to soften,
    // so it never pops.
    ctx.save();
    ctx.globalAlpha = Math.min(0.85, (zoom - 1.15) * 0.7);
    // Anchor the tile to the world origin so it scrolls with the terrain.
    const ox = ((topLeft.x % GRAIN_TILE) + GRAIN_TILE) % GRAIN_TILE;
    const oy = ((topLeft.y % GRAIN_TILE) + GRAIN_TILE) % GRAIN_TILE;
    ctx.translate(ox, oy);
    ctx.fillStyle = this.grainPattern;
    ctx.fillRect(-GRAIN_TILE, -GRAIN_TILE, this.cssW + GRAIN_TILE * 2, this.cssH + GRAIN_TILE * 2);
    ctx.restore();
  }

  private ensureTerrainBaked(snapshot: WorldSnapshot) {
    if (this.bakedBiomeRef === snapshot.terrainGrid.biome && this.bakedTerrain) return;
    const { canvas, scale } = bakeTerrain(snapshot.width, snapshot.height, snapshot.terrainGrid, snapshot.obstacles);
    this.bakedTerrain = canvas;
    this.bakedScale = scale;
    this.bakedBiomeRef = snapshot.terrainGrid.biome;
  }

  private renderSurface(snapshot: WorldSnapshot, profile: ReturnType<ISimulation['getProfile']>) {
    this.ensureTerrainBaked(snapshot);
    const ctx = this.wctx;
    const visible = this.camera.visibleWorldRect(this.cssW, this.cssH);

    if (this.bakedTerrain) {
      const topLeft = this.w2s({ x: 0, y: 0 });
      const w = snapshot.width * this.camera.zoom;
      const h = snapshot.height * this.camera.zoom;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.bakedTerrain, topLeft.x, topLeft.y, w, h);
      // Past ~1:1 the bake is being magnified, so redraw the visible cells'
      // features live at screen resolution, faded in so there's no pop.
      // Ramp starts where the bake actually begins to soften, not before: the
      // pass redraws every visible cell, and at low zoom that is hundreds of
      // cells' worth of work to replace detail the bake is still rendering
      // perfectly well. By the time it reaches full strength the viewport
      // covers only a few dozen cells, so the cost is bounded.
      const detailAlpha = Math.min(1, (this.camera.zoom - 1.15) * 0.9);
      if (detailAlpha > 0.02) {
        ctx.save();
        ctx.globalAlpha = detailAlpha;
        drawTerrainDetail(ctx, snapshot.terrainGrid, visible, this.camera.zoom, (wx, wy) => {
          const p = this.w2s({ x: wx, y: wy });
          return [p.x, p.y];
        });
        ctx.restore();
      }
      this.drawGroundGrain(topLeft);
    }

    drawWetness(ctx, snapshot.terrainGrid, visible, (wx, wy) => {
      const s = this.w2s({ x: wx, y: wy });
      return [s.x, s.y];
    });

    if (profile.render.pheromoneGlow) {
      this.drawPheromoneLayer(snapshot);
    }

    for (const f of snapshot.foods) this.drawFoodSource(f);

    for (const c of snapshot.colonies) this.drawNest(c);

    for (const p of snapshot.predators) this.drawPredator(p);

    const legAnim = profile.render.antLegAnimation;
    const seen = new Set<number>();
    for (const a of snapshot.ants) {
      seen.add(a.id);
      this.drawAnt(a, legAnim);
    }
    if (this.legPhases.size > seen.size * 1.5) {
      // Occasional cleanup so the map doesn't grow forever as ants churn.
      for (const id of this.legPhases.keys()) if (!seen.has(id)) this.legPhases.delete(id);
    }
  }

  /**
   * Scent trails, drawn as a smooth glowing layer rather than a grid of hard
   * squares. Each pheromone cell is painted as a single pixel into a tiny
   * offscreen canvas, which is then blitted up to world scale with smoothing
   * on — so one drawImage produces soft, continuous trails no matter how many
   * cells are active, and the grid never shows through.
   *
   * Food trails glow in the depositing colony's own colour (so you can see
   * which colony a highway belongs to); alarm pheromone is always angry red,
   * because "my colony is under attack" should never be mistaken for
   * "there's food this way".
   */
  private drawPheromoneLayer(snapshot: WorldSnapshot) {
    const foodCells = snapshot.pheromone.food;
    const alarmCells = snapshot.pheromone.alarm;
    if (foodCells.length === 0 && alarmCells.length === 0) return;

    const cellSize = (foodCells[0] ?? alarmCells[0]).size;
    const cols = Math.max(1, Math.ceil(snapshot.width / cellSize));
    const rows = Math.max(1, Math.ceil(snapshot.height / cellSize));

    let layer = this.trailLayer;
    if (!layer || layer.width !== cols || layer.height !== rows) {
      layer = document.createElement('canvas');
      layer.width = cols;
      layer.height = rows;
      this.trailLayer = layer;
      this.trailLayerCtx = layer.getContext('2d');
    }
    const lctx = this.trailLayerCtx;
    if (!lctx) return;

    // Match each trail to its colony's actual colour, so a glowing highway
    // visibly belongs to the nest it leads back to.
    const hueByColony = new Map<number, number>();
    for (const c of snapshot.colonies) hueByColony.set(c.id, c.colorHue);

    // Alpha is `strength^1.6` with no floor. A linear ramp with a 0.25 floor
    // made a cell that had almost evaporated nearly as bright as a live
    // highway, so the whole map glowed uniformly; the gamma curve keeps the
    // faint stuff faint and lets the trail actually read as a trail.
    lctx.clearRect(0, 0, cols, rows);
    for (const cell of foodCells) {
      const hue = hueByColony.get(cell.colonyId) ?? 95;
      lctx.fillStyle = `hsla(${hue}, 92%, 58%, ${Math.pow(cell.strength, 1.6) * 0.92})`;
      lctx.fillRect(Math.floor(cell.x / cellSize), Math.floor(cell.y / cellSize), 1, 1);
    }
    for (const cell of alarmCells) {
      lctx.fillStyle = `rgba(255, 70, 60, ${Math.pow(cell.strength, 1.4) * 0.95})`;
      lctx.fillRect(Math.floor(cell.x / cellSize), Math.floor(cell.y / cellSize), 1, 1);
    }

    const ctx = this.wctx;
    const topLeft = this.w2s({ x: 0, y: 0 });
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // One pheromone cell covers more and more screen as you zoom in, so a
    // fixed alpha that looks like a trail from far out becomes a coloured fog
    // bank up close. Back the layer off as the cells get bigger on screen.
    const cellPx = cellSize * this.camera.zoom;
    ctx.globalAlpha = 0.62 * Math.min(1, Math.max(0.32, 26 / cellPx));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer, topLeft.x, topLeft.y, snapshot.width * this.camera.zoom, snapshot.height * this.camera.zoom);
    ctx.restore();
  }

  /**
   * Food is drawn by `sprites.drawFood`, which renders an actual pile of
   * seeds / cluster of berries / animal carcass rather than the coloured blob
   * this used to be — you can now tell at a glance what a source is, and how
   * picked-over it is (the pile visibly shrinks as `amount` drops). The
   * source's stable `id` is passed as the scatter seed so individual seeds
   * don't reshuffle themselves every frame as the camera pans.
   */
  private drawFoodSource(f: FoodSource) {
    const s = this.w2s(f.pos);
    const r = Math.max(1.5, f.radius * this.camera.zoom);
    drawFood(this.wctx, s.x, s.y, r, f.type as FoodKind, f.amount / f.maxAmount, f.id);
  }

  private drawNest(c: ColonySnapshot) {
    const ctx = this.wctx;
    const s = this.w2s(c.nestPos);
    const zoom = this.camera.zoom;

    // Faint territory boundary — soldiers patrol out to roughly here.
    ctx.strokeStyle = `hsla(${c.colorHue}, 70%, 60%, 0.13)`;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, c.territoryRadius * zoom, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // A real nest is a crater of excavated soil with a dark hole in the
    // middle, not a flat disc. Mound grows with the colony.
    const moundR = Math.max(7, 12 + Math.sqrt(Math.max(0, c.population)) * 1.7) * zoom;
    if (moundR < 1.5) {
      // Too far away to draw detail — a single colour-coded dot still tells
      // you a colony lives here.
      ctx.fillStyle = `hsl(${c.colorHue}, 70%, 55%)`;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // Irregular rim, deterministic per colony so it doesn't shimmer.
    const wobble = (i: number) => 1 + Math.sin(c.id * 12.9898 + i * 2.37) * 0.09;
    ctx.save();
    ctx.translate(s.x, s.y);

    // The mound casts a shadow onto the ground, offset away from the world's
    // top-left key light. Without it the nest looks painted on the terrain
    // rather than piled on top of it.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
    ctx.beginPath();
    ctx.ellipse(moundR * 0.10, moundR * 0.16, moundR * 1.04, moundR * 0.94, 0, 0, Math.PI * 2);
    ctx.fill();

    // Excavated soil ring.
    const soil = ctx.createRadialGradient(0, 0, moundR * 0.35, 0, 0, moundR);
    soil.addColorStop(0, 'rgba(120, 86, 56, 0.95)');
    soil.addColorStop(0.72, 'rgba(146, 108, 70, 0.95)');
    soil.addColorStop(1, 'rgba(120, 88, 58, 0)');
    ctx.fillStyle = soil;
    ctx.beginPath();
    for (let i = 0; i <= 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const r = moundR * wobble(i);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r * 0.88;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();

    // Granular soil texture. A smooth radial gradient reads as a bagel; an
    // anthill is a cone of loose excavated grains, and it takes actual grains
    // to say so. Each is shaded by where it sits relative to the key light, so
    // the near (upper-left) face is lit and the far face falls into shadow,
    // which is what gives the mound its volume.
    if (moundR > 8) {
      const grains = Math.min(220, Math.round(moundR * 3.2));
      for (let i = 0; i < grains; i++) {
        const h1 = hash01(c.id * 91 + i * 7);
        const h2 = hash01(c.id * 31 + i * 13 + 5);
        const h3 = hash01(c.id * 17 + i * 29 + 11);
        const a = h1 * Math.PI * 2;
        // sqrt keeps the scatter even per unit area instead of crowding the
        // centre, and the 0.36 floor keeps grains out of the entrance hole.
        const rr = moundR * (0.36 + Math.sqrt(h2) * 0.68);
        const gx = Math.cos(a) * rr;
        const gy = Math.sin(a) * rr * 0.88;
        // +1 facing the light (up-left), -1 facing away.
        const lit = -(Math.cos(a) + Math.sin(a)) * 0.7071;
        const tone = 128 + lit * 44 + h3 * 34;
        ctx.fillStyle = `rgba(${Math.round(tone)}, ${Math.round(tone * 0.74)}, ${Math.round(tone * 0.49)}, 0.72)`;
        const gr = Math.max(0.5, moundR * (0.022 + h3 * 0.032));
        ctx.beginPath();
        ctx.arc(gx, gy, gr, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Sunlit rim on the upper edge, shadowed lower edge — gives it volume.
    ctx.strokeStyle = 'rgba(186, 146, 100, 0.5)';
    ctx.lineWidth = Math.max(1, moundR * 0.1);
    ctx.beginPath();
    ctx.arc(0, 0, moundR * 0.8, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(40, 26, 14, 0.35)';
    ctx.beginPath();
    ctx.arc(0, 0, moundR * 0.82, Math.PI * 0.08, Math.PI * 0.92);
    ctx.stroke();

    // The entrance itself: a dark hole the ants stream in and out of. The
    // gradient's focus is offset up-left so the lit side of the shaft wall
    // catches light and the hole reads as a tunnel going down, not a sticker.
    const holeR = moundR * 0.34;
    const hole = ctx.createRadialGradient(-holeR * 0.3, -holeR * 0.3, 0, 0, 0, holeR);
    hole.addColorStop(0, '#0a0705');
    hole.addColorStop(0.7, '#170f09');
    hole.addColorStop(1, 'rgba(58, 40, 24, 0.9)');
    ctx.fillStyle = hole;
    ctx.beginPath();
    ctx.ellipse(0, 0, holeR, holeR * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();
    // Lit lip on the far side of the shaft.
    ctx.strokeStyle = 'rgba(196, 156, 106, 0.55)';
    ctx.lineWidth = Math.max(0.7, moundR * 0.05);
    ctx.beginPath();
    ctx.arc(0, 0, holeR * 0.98, Math.PI * 0.12, Math.PI * 0.88);
    ctx.stroke();

    // Scattered spoil grains around the rim.
    if (moundR > 14) {
      ctx.fillStyle = 'rgba(160, 122, 80, 0.7)';
      for (let i = 0; i < 7; i++) {
        const a = c.id * 0.7 + i * 0.9;
        const r = moundR * (1.05 + ((i * 37) % 11) / 40);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r, Math.sin(a) * r * 0.88, Math.max(0.6, moundR * 0.045), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Colony identity ring — thin, so it marks ownership without turning the
    // nest into a coloured blob.
    ctx.strokeStyle = c.alive ? `hsla(${c.colorHue}, 85%, 62%, 0.9)` : 'rgba(120,120,120,0.7)';
    ctx.lineWidth = Math.max(1, moundR * 0.06);
    ctx.beginPath();
    ctx.arc(0, 0, moundR * 1.02, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();

    if (!c.queenAlive && c.alive) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = `${Math.max(10, moundR * 0.9)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('☠', s.x, s.y + moundR * 0.35);
    }
  }

  /**
   * One ant. The anatomy — segmented gaster, mesosoma, head with mandibles
   * and elbowed antennae, six jointed legs in a real alternating-tripod gait
   * — lives in `sprites.ts`, which rasterises each (caste, hue, task, gait
   * frame) combination once and then blits it. All this method does is work
   * out where the ant is on screen, how big it should be, and where its gait
   * is up to.
   */
  private drawAnt(a: AntSnapshot, legAnim: boolean) {
    const s = this.w2s(a.pos);
    // Body length in screen pixels. Majors and reproductives are genuinely
    // larger animals, and the sprite exaggerates the head-to-body ratio on
    // top of this so a soldier is recognisable even when it is 6px long.
    const bodyLen = ANT_BODY_LENGTH[a.caste] * this.camera.zoom;
    if (bodyLen < 0.7) return; // smaller than a pixel — not worth the call

    // Free-running gait phase, advanced by distance walked rather than by
    // time, so a slow ant takes slow steps and a stopped ant stops stepping.
    let phase = this.legPhases.get(a.id) ?? 0;
    phase += a.speed * this.lastDt * 0.55;
    this.legPhases.set(a.id, phase);

    drawAnt(this.wctx, s.x, s.y, a.heading, bodyLen, {
      caste: a.caste,
      colonyHue: a.genetics.hue,
      carrying: a.carrying,
      task: a.task,
      selected: a.selected,
      legPhase: phase,
      quality: { legAnimation: legAnim },
    });
  }

  private drawPredator(p: PredatorSnapshot) {
    if (p.state === 'dead') return;
    const ctx = this.wctx;
    const s = this.w2s(p.pos);
    const size = PREDATOR_BODY_LENGTH[p.kind] * this.camera.zoom;
    if (size < 1) return;

    drawPredator(ctx, s.x, s.y, p.heading, size, {
      kind: p.kind as PredatorKind,
      healthFrac: p.health / p.maxHealth,
    });

    // Health bar for anything that's taken damage. Divided by the predator's
    // own maxHealth — a bird and a beetle do not have the same health pool.
    if (p.health < p.maxHealth * 0.98) {
      const w = size * 1.4;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(s.x - w / 2, s.y - size - 6, w, 3);
      ctx.fillStyle = '#e05050';
      ctx.fillRect(s.x - w / 2, s.y - size - 6, w * Math.max(0, p.health / p.maxHealth), 3);
    }
  }

  // -------------------------------------------------------------------
  // Underground cutaway view
  // -------------------------------------------------------------------

  private renderUnderground(snapshot: WorldSnapshot) {
    const ctx = this.wctx;
    const topLeft = this.w2s({ x: 0, y: 0 });
    const w = snapshot.width * this.camera.zoom;
    const h = snapshot.height * this.camera.zoom;
    const grad = ctx.createLinearGradient(0, topLeft.y, 0, topLeft.y + h);
    grad.addColorStop(0, '#3a2a1c');
    grad.addColorStop(1, '#160f0a');
    ctx.fillStyle = grad;
    ctx.fillRect(topLeft.x, topLeft.y, w, h);

    for (const c of snapshot.colonies) this.drawColonyCutaway(c, snapshot.larvae.filter((l) => l.colonyId === c.id));
  }

  private drawColonyCutaway(c: ColonySnapshot, larvae: LarvaSnapshot[]) {
    const ctx = this.wctx;
    const zoom = this.camera.zoom;
    const base = this.w2s(c.nestPos);
    const chamberDx = 70 * zoom;
    const chamberDy = 90 * zoom;

    const shaftBottom = { x: base.x, y: base.y + chamberDy * 2.6 };
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = Math.max(2, 10 * zoom);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(shaftBottom.x, shaftBottom.y);
    ctx.stroke();

    const nursery = { x: base.x - chamberDx, y: base.y + chamberDy };
    const storage = { x: base.x + chamberDx, y: base.y + chamberDy * 1.6 };
    const queenChamber = { x: base.x, y: base.y + chamberDy * 2.6 };

    for (const [pt, r] of [
      [nursery, 34],
      [storage, 30],
      [queenChamber, 38],
    ] as [Vec2, number][]) {
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = Math.max(2, 8 * zoom);
      ctx.beginPath();
      ctx.moveTo(base.x, base.y + 4);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r * zoom, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `hsla(${c.colorHue}, 50%, 45%, 0.6)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Nursery: larvae as tiny cream grubs.
    const shown = larvae.slice(0, 40);
    for (let i = 0; i < shown.length; i++) {
      const angle = (i / Math.max(1, shown.length)) * Math.PI * 2;
      const rr = 20 * zoom * Math.min(1, shown.length / 12);
      const gx = nursery.x + Math.cos(angle) * rr;
      const gy = nursery.y + Math.sin(angle) * rr * 0.6;
      ctx.fillStyle = '#eee3c0';
      ctx.beginPath();
      ctx.ellipse(gx, gy, 3.2 * zoom, 1.8 * zoom, angle, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `${Math.max(9, 11 * zoom)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${larvae.length} larvae`, nursery.x, nursery.y + 44 * zoom);

    // Storage: food fill level.
    const fillFrac = Math.min(1, c.foodStore / 200);
    ctx.fillStyle = 'rgba(224,169,92,0.85)';
    ctx.beginPath();
    ctx.arc(storage.x, storage.y + 30 * zoom * (1 - fillFrac), 30 * zoom * fillFrac, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(`${Math.round(c.foodStore)} food`, storage.x, storage.y + 44 * zoom);

    // Queen chamber.
    ctx.fillStyle = c.queenAlive ? `hsl(${c.colorHue}, 60%, 55%)` : '#444';
    ctx.beginPath();
    ctx.ellipse(queenChamber.x, queenChamber.y, 12 * zoom, 8 * zoom, 0, 0, Math.PI * 2);
    ctx.fill();
    if (c.queenAlive) {
      ctx.strokeStyle = '#ffd54a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(queenChamber.x, queenChamber.y, 18 * zoom * (0.4 + (c.queenEnergy / 100) * 0.6), 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#ffe066';
      ctx.font = `${Math.max(10, 14 * zoom)}px sans-serif`;
      ctx.fillText('♛', queenChamber.x, queenChamber.y - 16 * zoom);
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText('☠', queenChamber.x, queenChamber.y - 12 * zoom);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = `${Math.max(10, 12 * zoom)}px sans-serif`;
    ctx.fillText(c.name, base.x, base.y - 14 * zoom);
  }

  // -------------------------------------------------------------------
  // Weather, lighting, minimap
  // -------------------------------------------------------------------

  private renderWeatherFx(snapshot: WorldSnapshot, dt: number, enabled: boolean, maxParticles: number) {
    const ctx = this.fctx;
    const active = enabled && (snapshot.weather === 'rain' || snapshot.weather === 'storm');
    const targetCount = active ? Math.round(maxParticles * (snapshot.weather === 'storm' ? 1 : 0.55) * snapshot.rainIntensity) : 0;

    while (this.raindrops.length < targetCount) {
      this.raindrops.push({
        x: Math.random() * this.cssW,
        y: Math.random() * this.cssH,
        len: 8 + Math.random() * 10,
        speed: 380 + Math.random() * 220,
      });
    }
    if (this.raindrops.length > targetCount) this.raindrops.length = targetCount;

    if (this.raindrops.length > 0) {
      ctx.strokeStyle = 'rgba(180,200,230,0.35)';
      ctx.lineWidth = 1;
      for (const d of this.raindrops) {
        d.y += d.speed * dt;
        d.x -= d.speed * 0.12 * dt;
        if (d.y > this.cssH) {
          d.y = -10;
          d.x = Math.random() * this.cssW;
        }
        ctx.beginPath();
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x - 3, d.y + d.len);
        ctx.stroke();
      }
    }

    if (snapshot.weather === 'storm' && Math.random() < dt * 0.05) this.lightningFlash = 1;
    if (this.lightningFlash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.lightningFlash * 0.25})`;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
      this.lightningFlash = Math.max(0, this.lightningFlash - dt * 3);
    }

    // Ambient dust/pollen motes drift year-round (not just in rain) — a
    // static scene otherwise reads as dead rather than alive.
    const dustTarget = enabled && !active ? Math.round(maxParticles * 0.12) : 0;
    while (this.dustMotes.length < dustTarget) {
      this.dustMotes.push({
        x: Math.random() * this.cssW,
        y: Math.random() * this.cssH,
        vx: (Math.random() - 0.5) * 8,
        vy: -3 - Math.random() * 6,
        size: 0.8 + Math.random() * 1.6,
        twinklePhase: Math.random() * Math.PI * 2,
      });
    }
    if (this.dustMotes.length > dustTarget) this.dustMotes.length = dustTarget;
    for (const m of this.dustMotes) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      m.twinklePhase += dt * 1.5;
      if (m.y < -10) {
        m.y = this.cssH + 10;
        m.x = Math.random() * this.cssW;
      }
      if (m.x < -10) m.x = this.cssW + 10;
      if (m.x > this.cssW + 10) m.x = -10;
      const alpha = 0.15 + Math.sin(m.twinklePhase) * 0.1;
      ctx.fillStyle = `rgba(230, 240, 200, ${Math.max(0, alpha)})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private renderLighting(snapshot: WorldSnapshot) {
    const ctx = this.fctx;
    const t = snapshot.timeOfDay;
    // Night is darkest around t=0, brightest around t=0.5 (noon).
    const daylight = Math.max(0, Math.sin((t - 0.22) * Math.PI * (1 / 0.56)));
    const nightAlpha = Math.max(0, 0.62 - daylight * 0.62);
    if (nightAlpha > 0.01) {
      ctx.fillStyle = `rgba(8, 14, 35, ${nightAlpha})`;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }
    const overcast = snapshot.weather === 'overcast' || snapshot.weather === 'rain' || snapshot.weather === 'storm';
    if (overcast) {
      ctx.fillStyle = `rgba(60,65,70,${snapshot.weather === 'storm' ? 0.28 : 0.15})`;
      ctx.fillRect(0, 0, this.cssW, this.cssH);
    }

    // A soft vignette gives the scene some depth instead of reading as a
    // flat, evenly-lit rectangle.
    const vignette = ctx.createRadialGradient(
      this.cssW / 2,
      this.cssH / 2,
      Math.min(this.cssW, this.cssH) * 0.35,
      this.cssW / 2,
      this.cssH / 2,
      Math.max(this.cssW, this.cssH) * 0.72,
    );
    vignette.addColorStop(0, 'rgba(0,0,0,0)');
    vignette.addColorStop(1, 'rgba(0,0,0,0.18)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
  }

  /**
   * Tell the renderer which parts of the screen the HUD is currently covering.
   *
   * The minimap is painted onto the FX canvas, so CSS layout can't flow around
   * it — it used to sit in the bottom-right corner unconditionally and the
   * inspector panel landed on top of it. Rather than hard-code which panel
   * lives where, the HUD reports its occupied rects and the minimap picks a
   * corner that is actually free, which keeps working when panels are added,
   * moved, or resized.
   */
  setReservedRects(rects: ScreenRect[]) {
    this.reservedRects = rects;
  }

  private static rectsOverlap(a: ScreenRect, b: ScreenRect): boolean {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  }

  /** First corner whose map box clears every reserved rect; bottom-right if
   * they're all occupied (better a slight overlap than no minimap). */
  private minimapOrigin(mapW: number, mapH: number): ScreenRect {
    const pad = 14;
    const candidates: ScreenRect[] = [
      { x: this.cssW - mapW - pad, y: this.cssH - mapH - pad, w: mapW, h: mapH },
      { x: pad, y: this.cssH - mapH - pad, w: mapW, h: mapH },
      { x: this.cssW - mapW - pad, y: pad, w: mapW, h: mapH },
    ];
    for (const c of candidates) {
      const padded = { x: c.x - 6, y: c.y - 6, w: c.w + 12, h: c.h + 12 };
      if (!this.reservedRects.some((r) => Renderer.rectsOverlap(padded, r))) return c;
    }
    return candidates[0];
  }

  private renderMinimap(snapshot: WorldSnapshot, alpha: number) {
    const ctx = this.fctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    const mapW = 150;
    const mapH = (snapshot.height / snapshot.width) * mapW;
    const { x: x0, y: y0 } = this.minimapOrigin(mapW, mapH);

    ctx.fillStyle = 'rgba(10, 16, 12, 0.55)';
    ctx.fillRect(x0 - 4, y0 - 4, mapW + 8, mapH + 8);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(x0 - 4, y0 - 4, mapW + 8, mapH + 8);

    const sx = mapW / snapshot.width;
    const sy = mapH / snapshot.height;

    for (const f of snapshot.foods) {
      ctx.fillStyle = 'rgba(224,169,92,0.6)';
      ctx.fillRect(x0 + f.pos.x * sx, y0 + f.pos.y * sy, 1, 1);
    }
    for (const c of snapshot.colonies) {
      ctx.fillStyle = `hsl(${c.colorHue}, 80%, 60%)`;
      ctx.beginPath();
      ctx.arc(x0 + c.nestPos.x * sx, y0 + c.nestPos.y * sy, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    const rect = this.camera.visibleWorldRect(this.cssW, this.cssH, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      x0 + rect.minX * sx,
      y0 + rect.minY * sy,
      (rect.maxX - rect.minX) * sx,
      (rect.maxY - rect.minY) * sy,
    );
    ctx.restore();
  }
}
