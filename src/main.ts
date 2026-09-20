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
/**
 * Zoom level the camera opens on.
 *
 * This used to be 2.2, which at a typical 1440-wide window put a worker ant
 * at about 13 screen pixels — technically visible, but surrounded by so much
 * plain dirt that the opening view read as an empty beach with a few dust
 * specks on it rather than a colony of creatures. 3.4 puts a worker closer to
 * 20px and, more importantly, shrinks how much bare ground surrounds the
 * nest at open, which is what actually drives the "empty and boring" read —
 * it's a composition problem as much as a size one.
 */
const COLONY_VIEW_ZOOM = 3.4;

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
    renderer.effects.clear();
    hud.toasts.clear();
    hud.milestones.resetRun();
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
/** Last couple of drag samples, for working out a release velocity. */
let lastMovePos: Vec2 | null = null;
let lastMoveTime = 0;
let dragVx = 0;
let dragVy = 0;

function canvasPoint(e: PointerEvent): Vec2 {
  const rect = worldCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/**
 * Keep the cursor honest about what a press will do.
 *
 * The canvas used to sit on `default` the whole time, so the world gave no
 * hint that it could be dragged at all — panning worked, but only if you
 * happened to try it. An open hand over draggable ground and a closed one
 * while dragging is the convention every map on the web uses, and it is the
 * entire affordance.
 */
function refreshCursor() {
  if (dragged || (dragStart !== null && activePointers.size === 1)) {
    worldCanvas.style.cursor = 'grabbing';
  } else if (renderer.getHovered()) {
    worldCanvas.style.cursor = 'pointer';
  } else {
    worldCanvas.style.cursor = 'grab';
  }
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
  // Grabbing the world cancels any coast and any follow — touching the camera
  // is an unambiguous "I'll drive".
  renderer.camera.stopFling();
  renderer.stopFollowing();
  if (activePointers.size === 1) {
    dragStart = p;
    dragged = false;
    lastMovePos = p;
    lastMoveTime = performance.now();
    dragVx = 0;
    dragVy = 0;
  } else {
    const pinch = pinchState();
    if (pinch) {
      lastPinchDist = pinch.dist;
      lastPinchCenter = pinch.center;
    }
  }
  refreshCursor();
});

worldCanvas.addEventListener('pointermove', (e) => {
  const hoverPoint = canvasPoint(e);

  // Hover picking is suspended mid-drag. Running it while panning made the
  // cursor strobe between grab and pointer as ants slid underneath it, and
  // popped tooltips over the view you were trying to move.
  if (!dragged) renderer.setHoverScreen(hoverPoint);

  if (!activePointers.has(e.pointerId)) {
    refreshCursor();
    return;
  }
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
      if (!dragged) {
        dragged = true;
        renderer.setHoverScreen(null);
        refreshCursor();
      }
      renderer.camera.panByScreenDelta(dx, dy);
      dragStart = p;

      // Track velocity over the gap between samples rather than per frame, so
      // a fast flick on a slow frame still reads as fast.
      const now = performance.now();
      const gap = (now - lastMoveTime) / 1000;
      if (lastMovePos && gap > 0.001) {
        const vx = (p.x - lastMovePos.x) / gap;
        const vy = (p.y - lastMovePos.y) / gap;
        // Light smoothing: one jittery sample shouldn't define the throw.
        dragVx = dragVx * 0.4 + vx * 0.6;
        dragVy = dragVy * 0.4 + vy * 0.6;
      }
      lastMovePos = p;
      lastMoveTime = now;
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
  } else if (wasSingle && dragged) {
    // A release more than a moment after the last movement is a considered
    // stop, not a throw — coasting there feels like the camera slipping.
    if (performance.now() - lastMoveTime < 90) renderer.camera.fling(dragVx, dragVy);
  }
  if (activePointers.size === 0) {
    dragStart = null;
    dragged = false;
    lastMovePos = null;
  }
  refreshCursor();
}

worldCanvas.addEventListener('pointerenter', refreshCursor);

worldCanvas.addEventListener('pointerleave', () => {
  renderer.setHoverScreen(null);
  // Leave the grabbing cursor alone mid-drag: with pointer capture the drag
  // legitimately continues outside the canvas, and flipping the cursor there
  // makes it look like the drag was dropped.
  if (!dragged) worldCanvas.style.cursor = 'default';
});

worldCanvas.addEventListener('pointerup', endPointer);
worldCanvas.addEventListener('pointercancel', endPointer);

worldCanvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const p = canvasPoint(e as unknown as PointerEvent);
    const factor = Math.pow(1.0015, -e.deltaY);
    renderer.camera.stopFling();
    renderer.camera.zoomAt(p, factor, worldCanvas.clientWidth, worldCanvas.clientHeight);
  },
  { passive: false },
);

// --- Keyboard panning ------------------------------------------------------
// WASD and the arrows, because reaching for the mouse to look 200 units left
// is friction nobody should have to accept in something you drive with one
// hand while watching with the other.
const heldKeys = new Set<string>();
const PAN_KEYS: Record<string, [number, number]> = {
  w: [0, 1], arrowup: [0, 1],
  s: [0, -1], arrowdown: [0, -1],
  a: [1, 0], arrowleft: [1, 0],
  d: [-1, 0], arrowright: [-1, 0],
};
/** Screen pixels per second; Shift doubles it. */
const KEY_PAN_SPEED = 620;

function isTypingInto(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  if (isTypingInto(e.target)) return;
  const key = e.key.toLowerCase();
  if (PAN_KEYS[key]) {
    heldKeys.add(key);
    renderer.camera.stopFling();
    renderer.stopFollowing();
    e.preventDefault();
  }
});
window.addEventListener('keyup', (e) => heldKeys.delete(e.key.toLowerCase()));

window.addEventListener('keydown', (e) => {
  if (isTypingInto(e.target)) return;
  if (e.key === 'Escape' && renderer.getFollowId() !== null) {
    renderer.stopFollowing();
    e.preventDefault();
  }
});
// Keys held while the tab loses focus would otherwise stick down forever.
window.addEventListener('blur', () => heldKeys.clear());

function stepKeyboardPan(dt: number) {
  if (heldKeys.size === 0) return;
  let dx = 0;
  let dy = 0;
  for (const key of heldKeys) {
    const dir = PAN_KEYS[key];
    if (dir) {
      dx += dir[0];
      dy += dir[1];
    }
  }
  if (dx === 0 && dy === 0) return;
  // Normalise so a diagonal isn't 1.4x faster than a straight line.
  const len = Math.hypot(dx, dy);
  const speed = KEY_PAN_SPEED * dt;
  renderer.camera.panByScreenDelta((dx / len) * speed, (dy / len) * speed);
}

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
      // Clicking an ant also rides along with it. Following is the difference
      // between "a swarm of dots" and "that one, right there, carrying a seed
      // home", and asking for a separate gesture would mean most people never
      // discovered it.
      //
      // Follow whatever the *simulation* ended up selecting rather than the
      // renderer's own pick. The two use different radii, so a click just
      // outside the renderer's screen-space radius could still select an ant
      // in the sim — the inspector would fill in while the camera sat there
      // doing nothing, which looked like follow mode was broken.
      renderer.followAnt(sim.getSelectedAnt()?.id ?? null);
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

// ---------------------------------------------------------------------
// Juice: turn simulation events into things you can see.
// ---------------------------------------------------------------------
//
// The engine already emitted all of this. Until now every one of these
// dramatic moments was rendered as a dot quietly no longer being drawn, which
// is why a world full of birth, starvation, predation and war managed to look
// like a screensaver.
//
// All of it is throttled: at 50x a colony war emits hundreds of events a
// second, and spawning particles for every one would be both unreadable and
// slow. The cap is per-frame rather than per-event so a burst still reads as
// a burst — just a bounded one.

const hueOfColony = (id: number): number =>
  sim.getSnapshot().colonies.find((c) => c.id === id)?.colorHue ?? 90;

let combatThisFrame = 0;
let deathsThisFrame = 0;
let birthsThisFrame = 0;
const MAX_COMBAT_FX_PER_FRAME = 4;
const MAX_DEATH_FX_PER_FRAME = 3;
const MAX_BIRTH_FX_PER_FRAME = 2;

sim.events.on('combat', ({ pos, a, b }) => {
  if (combatThisFrame >= MAX_COMBAT_FX_PER_FRAME) return;
  combatThisFrame++;
  // Ant-vs-predator hits harder than a border scuffle between workers, so it
  // gets more sparks and an actual jolt.
  const bigFight = a === 'predator' || b === 'predator';
  renderer.effects.spark(pos, bigFight ? 10 : 6, bigFight ? 8 : 26);
  if (bigFight) renderer.effects.shake(2.2);
});

sim.events.on('antDied', ({ pos, cause, colonyId }) => {
  if (deathsThisFrame >= MAX_DEATH_FX_PER_FRAME) return;
  deathsThisFrame++;
  renderer.effects.puff(pos, cause === 'predator' || cause === 'combat' ? 8 : 5, 28);
  if (cause === 'predator' || cause === 'combat') {
    renderer.effects.spark(pos, 5, hueOfColony(colonyId));
  }
});

sim.events.on('antBorn', ({ colonyId }) => {
  if (birthsThisFrame >= MAX_BIRTH_FX_PER_FRAME) return;
  birthsThisFrame++;
  const nest = sim.getSnapshot().colonies.find((c) => c.id === colonyId);
  if (nest) renderer.effects.sparkle(nest.nestPos, nest.colorHue, 4);
});

// The rare, genuinely significant events are deliberately not throttled —
// they can't spam, and they're the ones worth interrupting for.
const colonyName = (id: number): string =>
  sim.getSnapshot().colonies.find((c) => c.id === id)?.name ?? 'A colony';

sim.events.on('colonyFounded', ({ pos, colonyId, parentColonyId }) => {
  const hue = hueOfColony(colonyId);
  renderer.effects.ring(pos, hue, 90);
  renderer.effects.sparkle(pos, hue, 18);
  renderer.effects.floatText({ x: pos.x, y: pos.y - 26 }, 'New colony!', hue);
  renderer.effects.shake(3);
  hud.milestones.noteFounding(parentColonyId);
  // A colony the player dropped with the tool is not news to the player; one
  // that a queen founded on her own very much is.
  if (parentColonyId !== null) {
    hud.toasts.show({
      icon: '👑',
      title: `${colonyName(colonyId)} was founded`,
      body: 'A winged queen landed, shed her wings and started digging.',
      tone: 'good',
      key: 'founded',
    });
  }
});

sim.events.on('colonyCollapsed', ({ pos, colonyId }) => {
  renderer.effects.ring(pos, 0, 120);
  renderer.effects.puff(pos, 26, 12);
  renderer.effects.floatText({ x: pos.x, y: pos.y - 26 }, 'Colony wiped out', 8);
  renderer.effects.shake(6);
  hud.milestones.noteCollapse();
  hud.toasts.show({
    icon: '💀',
    title: `${colonyName(colonyId)} has died out`,
    body: 'Its queen is gone and the last of its workers with her.',
    tone: 'bad',
    key: 'collapsed',
  });
});

sim.events.on('nuptialFlight', ({ colonyId, count }) => {
  hud.milestones.noteFlight();
  const nest = sim.getSnapshot().colonies.find((c) => c.id === colonyId);
  if (!nest) return;
  renderer.effects.ring(nest.nestPos, nest.colorHue, 70);
  renderer.effects.sparkle(nest.nestPos, nest.colorHue, 16);
  renderer.effects.floatText(
    { x: nest.nestPos.x, y: nest.nestPos.y - 30 },
    `${count} queens take flight`,
    nest.colorHue,
  );
  hud.toasts.show({
    icon: '🦋',
    title: `${nest.name} sends out ${count} queens`,
    body: 'Each one that survives the flight can found a colony of her own.',
    tone: 'event',
    key: 'flight',
  });
});

sim.events.on('weatherChanged', ({ weather }) => {
  if (weather !== 'storm') return;
  // Only storms get a card: they drown ants in puddles and wash trails out,
  // so they actually change what you're watching. Drizzle does not.
  hud.toasts.show({
    icon: '⛈️',
    title: 'Storm rolling in',
    body: 'Foraging slows, puddles rise, and scent trails wash away fast.',
    tone: 'event',
    key: 'storm',
  });
});

sim.events.on('foodDepleted', ({ pos }) => {
  renderer.effects.puff(pos, 5, 40);
});

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

  stepKeyboardPan(dt);
  combatThisFrame = 0;
  deathsThisFrame = 0;
  birthsThisFrame = 0;
  sim.update(dt);
  const snapshot = sim.getSnapshot();
  renderer.render(snapshot, dt);
  hud.update(snapshot);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

window.setTimeout(() => bootScreen.classList.add('hidden'), 500);
