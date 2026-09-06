import './style.css';
import { Simulation } from './sim/simulation';
import { Renderer } from './render/renderer';
import { HUD } from './ui/hud';
import type { Vec2 } from './sim/vec2';

const worldCanvas = document.getElementById('world-canvas') as HTMLCanvasElement;
const fxCanvas = document.getElementById('fx-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const bootScreen = document.getElementById('boot-screen') as HTMLElement;

const sim = new Simulation();
const renderer = new Renderer(worldCanvas, fxCanvas, sim);
renderer.fitWorldView();

const hud = new HUD(uiRoot, sim, {
  onFocusPosition: (pos: Vec2) => renderer.camera.focusOn(pos, Math.max(renderer.camera.zoom, 0.7)),
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
  if (!activePointers.has(e.pointerId)) return;
  const p = canvasPoint(e);
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
    case 'inspect':
      sim.selectAt(worldPos);
      break;
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

function frame(now: number) {
  const dtRaw = (now - lastFrame) / 1000;
  lastFrame = now;
  const dt = Math.min(dtRaw, 0.25); // guard against huge jumps (tab backgrounded, etc.)

  sim.update(dt);
  const snapshot = sim.getSnapshot();
  renderer.render(snapshot, dt);
  hud.update(snapshot);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

window.setTimeout(() => bootScreen.classList.add('hidden'), 500);
