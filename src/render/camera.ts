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

  /** Fit (roughly) the whole world into a viewport of the given size. */
  fitWorld(worldWidth: number, worldHeight: number, viewportW: number, viewportH: number) {
    const zx = viewportW / worldWidth;
    const zy = viewportH / worldHeight;
    this.zoom = clamp(Math.min(zx, zy) * 0.94, this.minZoom, this.maxZoom);
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

  /** Keep the camera from wandering so far that the world drifts entirely out
   * of view. The allowed margin shrinks as you zoom in (in world units) so
   * it stays a roughly constant, modest sliver in screen space. */
  clampToWorld(worldWidth: number, worldHeight: number, viewportW: number, viewportH: number) {
    const halfW = viewportW / this.zoom / 2;
    const halfH = viewportH / this.zoom / 2;
    const marginX = Math.max(0, halfW - worldWidth / 2) + halfW * 0.5;
    const marginY = Math.max(0, halfH - worldHeight / 2) + halfH * 0.5;
    this.x = clamp(this.x, -marginX, worldWidth + marginX);
    this.y = clamp(this.y, -marginY, worldHeight + marginY);
  }

  /** Visible world-space rectangle, useful for culling. */
  visibleWorldRect(viewportW: number, viewportH: number, pad = 60) {
    const topLeft = this.screenToWorld({ x: -pad, y: -pad }, viewportW, viewportH);
    const bottomRight = this.screenToWorld({ x: viewportW + pad, y: viewportH + pad }, viewportW, viewportH);
    return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
  }
}
