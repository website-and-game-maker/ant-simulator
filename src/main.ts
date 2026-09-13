import './style.css';
import { Simulation } from './sim/simulation';
import { Renderer, type ScreenRect } from './render/renderer';
import { preloadSprites } from './render/sprites';
import { HUD } from './ui/hud';
import type { Vec2 } from './sim/vec2';

const worldCanvas = document.getElementById('world-canvas') as HTMLCanvasElement;
const fxCanvas = document.getElementById('fx-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const bootScreen = document.getElementById('boot-screen') as HTMLElement;

const sim = new Simulation();
const renderer = new Renderer(worldCanvas, fxCanvas, sim);
// Warm the ant sprite atlas so the first frames aren't rasterising bodies
// mid-loop. Nothing is fetched over the network, so there is nothing to await.
void preloadSprites();

/** Zoom level that makes individual ants clearly readable as ants. */
const COLONY_VIEW_ZOOM = 2.2;

/**
 * Open looking at a living colony instead of the whole world. Framing the
 * entire map put every ant below a pixel, so the sim looked like an empty
 * field — you had to hunt to find anything alive.
 */
function frameALivingColony() {
  renderer.resize();
  const colonies = sim.getSnapshot().colonies.filter((c) => c.alive);
  if (colonies.length === 0) {
    renderer.fitWorldView();
    return;
  }
  const biggest = colonies.reduce((a, b) => (b.population > a.population ? b : a));
  renderer.camera.focusOn(biggest.nestPos, COLONY_VIEW_ZOOM);
}

frameALivingColony();

const hud = new HUD(uiRoot, sim, {
  onFocusPosition: (pos: Vec2) => renderer.camera.focusOn(pos, Math.max(renderer.camera.zoom, 0.7)),
  onWorldReset: () => {
    // A tier switch or restart just regenerated the world (new dimensions,
    // maybe a new DPR cap) — re-apply both, and land the camera on a colony
    // so the player is looking at something alive.
    frameALivingColony();
  },
});

// ---------------------------------------------------------------------
// Pointer input: pan (drag), zoom (wheel / pinch), tap = tool action.
// ---------------------------------------------------------------------

const DRAG_THRESHOLD = 6;
const activePointers = new Map<number, Vec2>();
let dragStart: Vec2 | null = null;
let dragged = false;
let lastPinchDist: number | null = null;
let lastPinchCenter: Vec2 | null = null;

function canvasPoint(e: PointerEvent): Vec2 {
  const rect = worldCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function pinchState(): { dist: number; center: Vec2 } | null {
  if (activePointers.size < 2) return null;
  const pts = [...activePointers.values()];
  const [a, b] = pts;
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
  };
}

worldCanvas.addEventListener('pointerdown', (e) => {
  worldCanvas.setPointerCapture(e.pointerId);
  const p = canvasPoint(e);
  activePointers.set(e.pointerId, p);
  if (activePointers.size === 1) {
    dragStart = p;
    dragged = false;
  } else {
    const pinch = pinchState();
    if (pinch) {
      lastPinchDist = pinch.dist;
      lastPinchCenter = pinch.center;
    }
  }
});

worldCanvas.addEventListener('pointermove', (e) => {
  const hoverPoint = canvasPoint(e);
  renderer.setHoverScreen(hoverPoint);
  worldCanvas.style.cursor = renderer.getHovered() ? 'pointer' : 'default';

  if (!activePointers.has(e.pointerId)) return;
  const p = hoverPoint;
  activePointers.set(e.pointerId, p);

  if (activePointers.size >= 2) {
    const pinch = pinchState();
    if (pinch && lastPinchDist !== null && lastPinchCenter !== null) {
      const factor = pinch.dist / Math.max(1, lastPinchDist);
      renderer.camera.zoomAt(pinch.center, factor, worldCanvas.clientWidth, worldCanvas.clientHeight);
      renderer.camera.panByScreenDelta(pinch.center.x - lastPinchCenter.x, pinch.center.y - lastPinchCenter.y);
    }
    if (pinch) {
      lastPinchDist = pinch.dist;
      lastPinchCenter = pinch.center;
    }
    return;
  }

  if (dragStart) {
    const dx = p.x - dragStart.x;
    const dy = p.y - dragStart.y;
    if (dragged || Math.hypot(dx, dy) > DRAG_THRESHOLD) {
      dragged = true;
      renderer.camera.panByScreenDelta(dx, dy);
      dragStart = p;
    }
  }
});

function endPointer(e: PointerEvent) {
  const wasSingle = activePointers.size === 1;
  const p = activePointers.get(e.pointerId) ?? canvasPoint(e);
  activePointers.delete(e.pointerId);
  if (activePointers.size < 2) {
    lastPinchDist = null;
    lastPinchCenter = null;
  }
  if (wasSingle && !dragged) {
    handleTap(p);
  }
  if (activePointers.size === 0) {
    dragStart = null;
    dragged = false;
  }
}

worldCanvas.addEventListener('pointerleave', () => {
  renderer.setHoverScreen(null);
  worldCanvas.style.cursor = 'default';
});

worldCanvas.addEventListener('pointerup', endPointer);
worldCanvas.addEventListener('pointercancel', endPointer);

worldCanvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const p = canvasPoint(e as unknown as PointerEvent);
    const factor = Math.pow(1.0015, -e.deltaY);
    renderer.camera.zoomAt(p, factor, worldCanvas.clientWidth, worldCanvas.clientHeight);
  },
  { passive: false },
);

function handleTap(screenPos: Vec2) {
  const worldPos = renderer.screenToWorld(screenPos);
  switch (hud.getActiveTool()) {
    case 'inspect': {
      // Hit-test in screen space first: at low zoom an ant is a couple of
      // pixels wide, and asking the player to land a click inside a world-space
      // radius that small is why selection felt unreliable. If the pick finds
      // something, hand the sim that entity's exact position so it always
      // resolves to the thing under the cursor.
      const hit = renderer.pickAt(screenPos);
      sim.selectAt(hit ? hit.pos : worldPos);
      break;
    }
    case 'placeFood':
      sim.placeFoodAt(worldPos);
      break;
    case 'spawnPredator':
      sim.spawnPredatorAt(worldPos);
      break;
    case 'foundColony':
      sim.foundColonyAt(worldPos);
      break;
  }
}

window.addEventListener('resize', () => renderer.resize());

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------

let lastFrame = performance.now();

/**
 * Report where the HUD currently is, so the canvas-drawn minimap can pick a
 * free corner instead of ending up underneath a panel.
 *
 * Read from the live DOM rather than from a hardcoded list of panel positions,
 * so it stays correct as panels open, close, grow with their content, or move
 * at a different viewport width. Throttled because `getBoundingClientRect`
 * forces layout and panels don't move sixty times a second.
 */
const RESERVED_RECT_INTERVAL = 0.2; // seconds
let reservedRectTimer = 0;

function syncReservedRects() {
  const rects: ScreenRect[] = [];
  const selector = '.hud-panel, .hud-toolbar-wrap, .hud-topright, .hud-settings-wrap';
  for (const el of Array.from(uiRoot.querySelectorAll<HTMLElement>(selector))) {
    if (el.classList.contains('hidden') || el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) rects.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  renderer.setReservedRects(rects);
}

function frame(now: number) {
  const dtRaw = (now - lastFrame) / 1000;
  lastFrame = now;
  const dt = Math.min(dtRaw, 0.25); // guard against huge jumps (tab backgrounded, etc.)

  reservedRectTimer -= dt;
  if (reservedRectTimer <= 0) {
    reservedRectTimer = RESERVED_RECT_INTERVAL;
    syncReservedRects();
  }

  sim.update(dt);
  const snapshot = sim.getSnapshot();
  renderer.render(snapshot, dt);
  hud.update(snapshot);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

window.setTimeout(() => bootScreen.classList.add('hidden'), 500);
