import type { ISimulation } from '../sim/facade';
import type { AntSnapshot, ColonySnapshot, LarvaSnapshot, PredatorSnapshot, WorldSnapshot } from '../sim/types';
import type { Vec2 } from '../sim/vec2';
import { Camera } from './camera';
import { bakeTerrain, drawWetness } from './terrainBaker';

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

const TASK_TINT: Partial<Record<AntSnapshot['task'], string>> = {
  engaging: '#ff5252',
  fleeing: '#ffd54a',
  returningWithFood: '#9be564',
};

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

    this.wctx.save();
    this.wctx.clearRect(0, 0, this.cssW, this.cssH);
    this.fctx.clearRect(0, 0, this.cssW, this.cssH);

    if (view === 'surface') {
      this.renderSurface(snapshot, profile);
    } else {
      this.renderUnderground(snapshot);
    }

    this.wctx.restore();

    this.renderWeatherFx(snapshot, dtSeconds, profile.render.weatherParticles, profile.render.maxParticles);
    this.renderLighting(snapshot);
    this.drawHoverHighlight();
    if (this.minimapFade > 0.01) this.renderMinimap(snapshot, this.minimapFade);
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
    }

    drawWetness(ctx, snapshot.terrainGrid, visible, (wx, wy) => {
      const s = this.w2s({ x: wx, y: wy });
      return [s.x, s.y];
    });

    if (profile.render.pheromoneGlow) {
      this.drawPheromoneLayer(snapshot);
    }

    for (const f of snapshot.foods) this.drawFood(f.pos, f.radius, f.type, f.amount / f.maxAmount);

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

    lctx.clearRect(0, 0, cols, rows);
    for (const cell of foodCells) {
      const hue = hueByColony.get(cell.colonyId) ?? 95;
      lctx.fillStyle = `hsla(${hue}, 95%, 62%, ${Math.min(1, 0.25 + cell.strength * 1.1)})`;
      lctx.fillRect(Math.floor(cell.x / cellSize), Math.floor(cell.y / cellSize), 1, 1);
    }
    for (const cell of alarmCells) {
      lctx.fillStyle = `rgba(255, 70, 60, ${Math.min(1, 0.3 + cell.strength * 1.2)})`;
      lctx.fillRect(Math.floor(cell.x / cellSize), Math.floor(cell.y / cellSize), 1, 1);
    }

    const ctx = this.wctx;
    const topLeft = this.w2s({ x: 0, y: 0 });
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.85;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer, topLeft.x, topLeft.y, snapshot.width * this.camera.zoom, snapshot.height * this.camera.zoom);
    ctx.restore();
  }

  private drawFood(pos: Vec2, radius: number, type: string, frac: number) {
    const ctx = this.wctx;
    const s = this.w2s(pos);
    const r = Math.max(1.5, radius * this.camera.zoom * Math.max(0.25, frac));
    const colors: Record<string, [string, string]> = {
      seed: ['#c9a24b', '#7a5b1e'],
      fruit: ['#e0644a', '#8f2c1c'],
      nectar: ['#e8c95a', '#a3781a'],
      carcass: ['#b98f7a', '#5c3d31'],
    };
    const [fill, edge] = colors[type] ?? colors.seed;
    const grad = ctx.createRadialGradient(s.x - r * 0.3, s.y - r * 0.3, r * 0.1, s.x, s.y, r);
    grad.addColorStop(0, fill);
    grad.addColorStop(1, edge);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fill();
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

    // The entrance itself: a dark hole the ants stream in and out of.
    const holeR = moundR * 0.34;
    const hole = ctx.createRadialGradient(0, 0, 0, 0, 0, holeR);
    hole.addColorStop(0, '#0a0705');
    hole.addColorStop(0.75, '#160f09');
    hole.addColorStop(1, 'rgba(30, 20, 12, 0.85)');
    ctx.fillStyle = hole;
    ctx.beginPath();
    ctx.ellipse(0, 0, holeR, holeR * 0.86, 0, 0, Math.PI * 2);
    ctx.fill();

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

  private drawAnt(a: AntSnapshot, legAnim: boolean) {
    const ctx = this.wctx;
    const s = this.w2s(a.pos);
    const zoom = this.camera.zoom;
    const isSoldier = a.caste === 'soldier';
    const isAlate = a.caste === 'drone' || a.caste === 'alateQueen';
    const bodyLen = (isSoldier ? 5.2 : isAlate ? 5.6 : 4) * zoom;
    if (bodyLen < 0.7) return; // too small to matter, skip for perf

    let phase = this.legPhases.get(a.id) ?? 0;
    phase += a.speed * this.lastDt * 0.18;
    this.legPhases.set(a.id, phase);

    ctx.save();
    ctx.translate(s.x, s.y);

    // A small grounded drop shadow reads as depth and stops ants from
    // looking like flat stickers pasted on the terrain. Drawn before the
    // heading rotation so it stays a simple "shadow under the body" ellipse
    // regardless of which way the ant is facing.
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.ellipse(0, bodyLen * 0.12, bodyLen * 0.4, bodyLen * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(a.heading);

    const lightness = a.selected ? 74 : 46 + (a.energy / 100) * 12;
    let color = `hsl(${a.genetics.hue}, 68%, ${lightness}%)`;
    const tint = TASK_TINT[a.task];
    if (tint) color = blend(color, tint, 0.4);

    if (legAnim && bodyLen > 2.2) {
      ctx.strokeStyle = 'rgba(20,15,10,0.55)';
      ctx.lineWidth = Math.max(0.4, bodyLen * 0.06);
      for (let i = -1; i <= 1; i++) {
        const swing = Math.sin(phase + i * 1.2) * bodyLen * 0.35;
        for (const side of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(i * bodyLen * 0.28, side * bodyLen * 0.12);
          ctx.lineTo(i * bodyLen * 0.28 + swing * 0.3, side * (bodyLen * 0.55 + Math.abs(swing) * 0.4));
          ctx.stroke();
        }
      }
    }

    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(20,12,6,0.5)';
    ctx.lineWidth = Math.max(0.3, bodyLen * 0.05);
    ctx.beginPath();
    ctx.ellipse(-bodyLen * 0.18, 0, bodyLen * 0.42, bodyLen * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(bodyLen * 0.32, 0, bodyLen * 0.22, bodyLen * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // A tiny highlight gives the carapace some shine instead of a flat fill.
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.ellipse(-bodyLen * 0.24, -bodyLen * 0.09, bodyLen * 0.14, bodyLen * 0.07, -0.4, 0, Math.PI * 2);
    ctx.fill();

    if (isAlate) {
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      ctx.ellipse(-bodyLen * 0.05, -bodyLen * 0.32, bodyLen * 0.5, bodyLen * 0.16, -0.3, 0, Math.PI * 2);
      ctx.ellipse(-bodyLen * 0.05, bodyLen * 0.32, bodyLen * 0.5, bodyLen * 0.16, 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (a.carrying) {
      ctx.fillStyle = '#e6c65c';
      ctx.beginPath();
      ctx.arc(bodyLen * 0.55, 0, bodyLen * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }

    if (isSoldier) {
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = Math.max(0.5, bodyLen * 0.08);
      ctx.beginPath();
      ctx.moveTo(bodyLen * 0.45, -bodyLen * 0.1);
      ctx.lineTo(bodyLen * 0.7, -bodyLen * 0.25);
      ctx.moveTo(bodyLen * 0.45, bodyLen * 0.1);
      ctx.lineTo(bodyLen * 0.7, bodyLen * 0.25);
      ctx.stroke();
    }

    ctx.restore();

    if (a.selected) {
      const pulse = 1 + Math.sin(this.clock * 5) * 0.15;
      ctx.strokeStyle = '#ffe066';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, bodyLen * 1.6 * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawPredator(p: PredatorSnapshot) {
    if (p.state === 'dead') return;
    const ctx = this.wctx;
    const s = this.w2s(p.pos);
    const zoom = this.camera.zoom;
    const size = (p.kind === 'bird' ? 16 : p.kind === 'spider' ? 9 : 11) * zoom;
    if (size < 1) return;

    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(p.heading);
    const colors: Record<string, string> = { beetle: '#3a2f22', spider: '#2a2a2a', bird: '#6b4a2a' };
    ctx.fillStyle = colors[p.kind] ?? '#333';
    ctx.beginPath();
    ctx.ellipse(0, 0, size * 0.6, size * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(size * 0.55, 0, size * 0.28, size * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    if (p.kind === 'spider') {
      ctx.strokeStyle = colors.spider;
      ctx.lineWidth = Math.max(0.6, size * 0.08);
      for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(-size * 0.1 + i * size * 0.12, 0);
          ctx.lineTo(-size * 0.1 + i * size * 0.12 + size * 0.3, side * size * 0.7);
          ctx.stroke();
        }
      }
    }
    ctx.restore();

    // Health bar for anything that's taken damage.
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

  private renderMinimap(snapshot: WorldSnapshot, alpha: number) {
    const ctx = this.fctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    const mapW = 150;
    const mapH = (snapshot.height / snapshot.width) * mapW;
    const pad = 14;
    const x0 = this.cssW - mapW - pad;
    const y0 = this.cssH - mapH - pad;

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

function blend(a: string, b: string, t: number): string {
  // Cheap HSL string blend: real alpha-compositing needs a scratch canvas, so
  // we approximate by returning `b` at high t, `a` otherwise — good enough
  // for a subtle task-based tint at typical ant sizes.
  return t > 0.5 ? b : a;
}
