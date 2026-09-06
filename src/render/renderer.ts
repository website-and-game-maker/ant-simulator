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
  private lightningFlash = 0;
  private clock = 0;
  private lastDt = 1 / 60;

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

  render(snapshot: WorldSnapshot, dtSeconds: number) {
    this.clock += dtSeconds;
    this.lastDt = dtSeconds;
    const profile = this.sim.getProfile();
    const view = this.sim.getView();

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
    this.renderMinimap(snapshot);
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
      ctx.globalCompositeOperation = 'lighter';
      for (const cell of snapshot.pheromone.food) this.drawPheromoneCell(cell, '120');
      for (const cell of snapshot.pheromone.alarm) this.drawPheromoneCell(cell, '0');
      ctx.globalCompositeOperation = 'source-over';
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

  private drawPheromoneCell(cell: { x: number; y: number; size: number; strength: number; colonyId: number }, hueOverride: string) {
    const ctx = this.wctx;
    const p1 = this.w2s({ x: cell.x, y: cell.y });
    const size = cell.size * this.camera.zoom;
    const hue = cell.colonyId >= 0 ? (cell.colonyId * 47) % 360 : hueOverride;
    ctx.fillStyle = `hsla(${hue}, 90%, 60%, ${cell.strength * 0.35})`;
    ctx.fillRect(p1.x, p1.y, size + 1, size + 1);
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
    const territoryR = c.territoryRadius * zoom;

    ctx.strokeStyle = `hsla(${c.colorHue}, 70%, 60%, 0.18)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(s.x, s.y, territoryR, 0, Math.PI * 2);
    ctx.stroke();

    const moundR = Math.max(6, 10 + Math.sqrt(c.population) * 1.4) * zoom;
    const grad = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, moundR);
    grad.addColorStop(0, `hsl(${c.colorHue}, 40%, 32%)`);
    grad.addColorStop(1, `hsl(${c.colorHue}, 40%, 16%)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, moundR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = c.alive ? `hsl(${c.colorHue}, 80%, 65%)` : '#555';
    ctx.lineWidth = 2;
    ctx.stroke();

    if (!c.queenAlive && c.alive) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = `${Math.max(10, moundR)}px sans-serif`;
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
    ctx.rotate(a.heading);

    const lightness = a.selected ? 70 : 42 + (a.energy / 100) * 10;
    let color = `hsl(${a.genetics.hue}, 55%, ${lightness}%)`;
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
    ctx.beginPath();
    ctx.ellipse(-bodyLen * 0.18, 0, bodyLen * 0.42, bodyLen * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(bodyLen * 0.32, 0, bodyLen * 0.22, bodyLen * 0.18, 0, 0, Math.PI * 2);
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
    if (p.health < 100 * 0.98) {
      const w = size * 1.4;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(s.x - w / 2, s.y - size - 6, w, 3);
      ctx.fillStyle = '#e05050';
      ctx.fillRect(s.x - w / 2, s.y - size - 6, w * Math.max(0, p.health / 400), 3);
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
  }

  private renderMinimap(snapshot: WorldSnapshot) {
    const ctx = this.fctx;
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
  }
}

function blend(a: string, b: string, t: number): string {
  // Cheap HSL string blend: real alpha-compositing needs a scratch canvas, so
  // we approximate by returning `b` at high t, `a` otherwise — good enough
  // for a subtle task-based tint at typical ant sizes.
  return t > 0.5 ? b : a;
}
