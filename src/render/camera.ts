import type { Vec2 } from '../sim/vec2';
import { clamp } from '../sim/rng';

/**
 * A simple 2D pan/zoom camera. `zoom` is pixels-per-world-unit, so
 * `zoom > 1` means "zoomed in" (world looks bigger on screen).
 */
export class Camera {
  x: number; // world-space point currently at the center of the viewport
  y: number;
  zoom: number;
  minZoom = 0.12;
  maxZoom = 4;

  constructor(worldWidth: number, worldHeight: number) {
    this.x = worldWidth / 2;
    this.y = worldHeight / 2;
    this.zoom = 1;
  }

  /**
   * The most zoomed-out useful setting: the whole world visible at once.
   *
   * `minZoom` is a fixed 0.12, which for a typical world let you keep scrolling
   * out long after the last of it was on screen, until the map was a postage
   * stamp adrift in black. Past the fit point there is nothing further to
   * reveal, so that is where zooming out stops.
   */
  fitZoom(worldWidth: number, worldHeight: number, viewportW: number, viewportH: number): number {
    return Math.max(this.minZoom, Math.min(viewportW / worldWidth, viewportH / worldHeight));
  }

  /** Fit (roughly) the whole world into a viewport of the given size. */
  fitWorld(worldWidth: number, worldHeight: number, viewportW: number, viewportH: number) {
    this.zoom = clamp(this.fitZoom(worldWidth, worldHeight, viewportW, viewportH), this.minZoom, this.maxZoom);
    this.x = worldWidth / 2;
    this.y = worldHeight / 2;
  }

  worldToScreen(p: Vec2, viewportW: number, viewportH: number): Vec2 {
    return {
      x: (p.x - this.x) * this.zoom + viewportW / 2,
      y: (p.y - this.y) * this.zoom + viewportH / 2,
    };
  }

  screenToWorld(p: Vec2, viewportW: number, viewportH: number): Vec2 {
    return {
      x: (p.x - viewportW / 2) / this.zoom + this.x,
      y: (p.y - viewportH / 2) / this.zoom + this.y,
    };
  }

  panByScreenDelta(dx: number, dy: number) {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  zoomAt(screenPos: Vec2, factor: number, viewportW: number, viewportH: number) {
    const before = this.screenToWorld(screenPos, viewportW, viewportH);
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    const after = this.screenToWorld(screenPos, viewportW, viewportH);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  focusOn(pos: Vec2, zoom?: number) {
    this.x = pos.x;
    this.y = pos.y;
    if (zoom !== undefined) this.zoom = clamp(zoom, this.minZoom, this.maxZoom);
  }

  /**
   * Keep the viewport inside the world.
   *
   * This used to allow the camera centre to travel a margin *past* the world
   * edge, which meant you could pan until a third of the screen was empty
   * black nothing below the ground — the world looked like it had fallen off
   * a table. Now the rule is the ordinary one: if the world is wider than the
   * viewport, the camera centre stays at least half a viewport in from each
   * edge, so the ground always fills the screen; if the world is *narrower*
   * than the viewport (fully zoomed out), it is centred instead.
   */
  clampToWorld(worldWidth: number, worldHeight: number, viewportW: number, viewportH: number) {
    // Enforced here rather than in `zoomAt` because it depends on the viewport
    // size, which changes on every window resize.
    this.zoom = Math.max(this.zoom, this.fitZoom(worldWidth, worldHeight, viewportW, viewportH));
    const halfW = viewportW / this.zoom / 2;
    const halfH = viewportH / this.zoom / 2;
    this.x = worldWidth <= halfW * 2 ? worldWidth / 2 : clamp(this.x, halfW, worldWidth - halfW);
    this.y = worldHeight <= halfH * 2 ? worldHeight / 2 : clamp(this.y, halfH, worldHeight - halfH);
  }

  /** Visible world-space rectangle, useful for culling. */
  visibleWorldRect(viewportW: number, viewportH: number, pad = 60) {
    const topLeft = this.screenToWorld({ x: -pad, y: -pad }, viewportW, viewportH);
    const bottomRight = this.screenToWorld({ x: viewportW + pad, y: viewportH + pad }, viewportW, viewportH);
    return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
  }
}
