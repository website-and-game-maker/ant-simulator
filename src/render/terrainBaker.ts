import type { BiomeType, Obstacle, TerrainGridData } from '../sim/types';

const BIOME_NAMES: BiomeType[] = ['grass', 'dirt', 'sand', 'rock', 'puddle', 'leafLitter'];
const TAU = Math.PI * 2;

/**
 * Ground colour per biome.
 *
 * These all sit on a warm soil undertone on purpose. The previous palette gave
 * each biome a fully independent, highly saturated colour and then jittered
 * every cell by ±22 per channel, which turned the world into a blotchy green /
 * orange / grey camouflage pattern — six colour fields of equal visual weight,
 * with nothing reading as "the ground" and nothing reading as "a thing on the
 * ground". Here the base layer is deliberately quiet and close-toned; all the
 * legibility comes from the feature pass below (blades, leaves, pebbles,
 * stones), which is what actually tells you what you're looking at.
 */
const BIOME_COLORS: Record<BiomeType, [number, number, number]> = {
  dirt: [104, 78, 54],
  grass: [86, 104, 55],
  sand: [190, 166, 120],
  rock: [128, 124, 116],
  puddle: [58, 84, 94],
  leafLitter: [126, 92, 55],
};

/** Deterministic 0..1 from three integers. Same cell always gets the same
 * blades of grass, so the world doesn't reshuffle itself on a re-bake. */
function rand(x: number, y: number, i: number): number {
  let h = Math.imul(x * 374761393 + y * 668265263 + i * 2147483647, 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 15), 0x45d9f3b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Bakes the terrain's biome grid + obstacles into a single offscreen canvas so
 * the main render loop can blit one image instead of redrawing thousands of
 * ground cells every frame. Only needs to run again when the world (or
 * performance tier) changes.
 *
 * Two passes, and the split is the whole trick:
 *
 *  1. **Base colour**, painted one pixel per cell into a tiny canvas and then
 *     blitted up with smoothing on. Bilinear interpolation gives a genuinely
 *     continuous ground tone with no cell grid and no scalloped circle edges.
 *     On its own this is a flat smear — which is why it is only the underlay.
 *  2. **Features**, drawn at full resolution on top: individual blades of
 *     grass, fallen leaves with midribs, pebbles, sand ripples, stone facets.
 *     This is what you actually see, and it stays crisp at any zoom because it
 *     was never scaled up from a thumbnail.
 */
export function bakeTerrain(
  worldWidth: number,
  worldHeight: number,
  grid: TerrainGridData,
  obstacles: Obstacle[],
  maxPixels = 6_000_000,
): { canvas: HTMLCanvasElement; scale: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (worldWidth * worldHeight)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(worldWidth * scale));
  canvas.height = Math.max(1, Math.round(worldHeight * scale));
  const ctx = canvas.getContext('2d')!;
  const cellSize = grid.cellSize * scale;

  const biomeAt = (cx: number, cy: number): BiomeType => {
    const x = cx < 0 ? 0 : cx >= grid.cols ? grid.cols - 1 : cx;
    const y = cy < 0 ? 0 : cy >= grid.rows ? grid.rows - 1 : cy;
    return BIOME_NAMES[grid.biome[y * grid.cols + x]];
  };

  drawBaseLayer(ctx, canvas, grid);
  drawMottling(ctx, canvas, scale);

  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      drawCellFeatures(ctx, grid, biomeAt, cx, cy, cx * cellSize, cy * cellSize, cellSize, scale, 'bake');
    }
  }

  for (const o of obstacles) drawObstacle(ctx, o, scale);

  return { canvas, scale };
}

// ---------------------------------------------------------------------------
// Per-cell feature dispatch (shared by the bake and the live detail pass)
// ---------------------------------------------------------------------------

type BiomeLookup = (cx: number, cy: number) => BiomeType;

/**
 * `'bake'` runs once, offscreen, and can afford per-feature gradients.
 * `'live'` runs every frame for every cell on screen, so it substitutes flat
 * fills for gradients and drops the fine grain (which the renderer's
 * screen-space grain pass is already supplying at constant pixel size). The
 * silhouettes — blades, leaves, stones — are identical either way, and those
 * are what you actually read.
 */
type DetailMode = 'bake' | 'live';

/**
 * Draws one cell's worth of ground features.
 *
 * The `(ox, oy, cs, unit)` quartet is what lets this serve two callers. During
 * the bake they are the cell's position and size in the baked image, with
 * `unit` the bake scale. Live, they are the cell's position and size **on
 * screen**, with `unit` the camera zoom — so blade thickness and speck size
 * come out right in both. Everything else is driven off `(cx, cy)` through the
 * hash, so a cell draws identically either way and there is no visible seam
 * when the live pass fades in over the baked one.
 */
function drawCellFeatures(
  ctx: CanvasRenderingContext2D,
  grid: TerrainGridData,
  biomeAt: BiomeLookup,
  cx: number, cy: number,
  ox: number, oy: number, cs: number, unit: number,
  mode: DetailMode,
) {
  const biome = biomeAt(cx, cy);
  // Feature density falls off where a biome meets a different one, so grass
  // thins out into bare dirt instead of stopping at a hard line.
  let same = 1;
  if (biomeAt(cx - 1, cy) === biome) same++;
  if (biomeAt(cx + 1, cy) === biome) same++;
  if (biomeAt(cx, cy - 1) === biome) same++;
  if (biomeAt(cx, cy + 1) === biome) same++;
  const density = same / 5;

  switch (biome) {
    case 'grass':
      drawGrassCell(ctx, ox, oy, cs, unit, cx, cy, density);
      break;
    case 'leafLitter':
      drawLitterCell(ctx, ox, oy, cs, unit, cx, cy, density, mode);
      break;
    case 'sand':
      drawSandCell(ctx, ox, oy, cs, unit, cx, cy, mode);
      break;
    case 'rock':
      drawRockCell(ctx, ox, oy, cs, unit, cx, cy, mode);
      break;
    case 'puddle':
      drawWaterCell(ctx, ox, oy, cs, unit, cx, cy, same === 5);
      break;
    default:
      drawDirtCell(ctx, ox, oy, cs, unit, cx, cy, mode);
      break;
  }
}

/**
 * Re-draws ground features at full screen resolution for the cells currently
 * on screen.
 *
 * The baked terrain is a fixed-resolution image, so once the camera zooms past
 * roughly 1:1 it is being magnified and every blade of grass turns into a soft
 * brown smudge — exactly when the player is closest and looking hardest. This
 * pass puts the detail back: at zoom 4 the viewport covers only a couple of
 * dozen cells, so redrawing them live costs a few hundred operations a frame
 * and the close-up is as crisp as the wide shot.
 *
 * The caller fades it in with `globalAlpha`, so it lands on top of the blurred
 * bake rather than replacing it.
 */
export function drawTerrainDetail(
  ctx: CanvasRenderingContext2D,
  grid: TerrainGridData,
  visible: { minX: number; minY: number; maxX: number; maxY: number },
  zoom: number,
  worldToScreen: (wx: number, wy: number) => [number, number],
) {
  const cs = grid.cellSize;
  const minCx = Math.max(0, Math.floor(visible.minX / cs));
  const maxCx = Math.min(grid.cols - 1, Math.floor(visible.maxX / cs));
  const minCy = Math.max(0, Math.floor(visible.minY / cs));
  const maxCy = Math.min(grid.rows - 1, Math.floor(visible.maxY / cs));
  const biomeAt: BiomeLookup = (bx, by) => {
    const x = bx < 0 ? 0 : bx >= grid.cols ? grid.cols - 1 : bx;
    const y = by < 0 ? 0 : by >= grid.rows ? grid.rows - 1 : by;
    return BIOME_NAMES[grid.biome[y * grid.cols + x]];
  };
  const screenCell = cs * zoom;
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const [sx, sy] = worldToScreen(cx * cs, cy * cs);
      drawCellFeatures(ctx, grid, biomeAt, cx, cy, sx, sy, screenCell, zoom, 'live');
    }
  }
}

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

function drawBaseLayer(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, grid: TerrainGridData) {
  const tiny = document.createElement('canvas');
  tiny.width = grid.cols;
  tiny.height = grid.rows;
  const tctx = tiny.getContext('2d')!;
  const img = tctx.createImageData(grid.cols, grid.rows);
  for (let i = 0; i < grid.cols * grid.rows; i++) {
    const [r, g, b] = BIOME_COLORS[BIOME_NAMES[grid.biome[i]]];
    // A gentle per-cell shade (±7, not ±22) keeps the interpolated field from
    // looking like airbrushed plastic without breaking it into confetti.
    const j = (rand(i % grid.cols, (i / grid.cols) | 0, 7) - 0.5) * 14;
    img.data[i * 4] = clamp255(r + j);
    img.data[i * 4 + 1] = clamp255(g + j);
    img.data[i * 4 + 2] = clamp255(b + j);
    img.data[i * 4 + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tiny, 0, 0, canvas.width, canvas.height);
}

/** Big, soft, low-frequency light and dark patches — the shallow undulation of
 * real ground. Drawn before features so blades and pebbles sit *on* it. */
function drawMottling(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, scale: number) {
  const count = Math.round((canvas.width * canvas.height) / (90000 * scale));
  for (let i = 0; i < count; i++) {
    const x = rand(i, 1, 11) * canvas.width;
    const y = rand(i, 2, 13) * canvas.height;
    const r = (60 + rand(i, 3, 17) * 190) * scale;
    const dark = rand(i, 4, 19) < 0.55;
    const a = 0.05 + rand(i, 5, 23) * 0.07;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, dark ? `rgba(30,20,10,${a})` : `rgba(255,236,190,${a * 0.8})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

// ---------------------------------------------------------------------------
// Per-biome feature passes
// ---------------------------------------------------------------------------

function drawGrassCell(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, cs: number, scale: number,
  cx: number, cy: number, density: number,
) {
  const tufts = Math.round(4 * density);
  const bladeLen = cs * 0.26;
  for (let t = 0; t < tufts; t++) {
    const rx = ox + rand(cx, cy, t * 3 + 40) * cs;
    const ry = oy + rand(cx, cy, t * 3 + 41) * cs;
    // Each tuft is a few blades from one root, fanning out and curving over.
    const blades = 2 + Math.floor(rand(cx, cy, t * 3 + 42) * 3);
    const shade = rand(cx, cy, t + 60);
    for (let b = 0; b < blades; b++) {
      const lean = (rand(cx, cy, t * 7 + b + 70) - 0.5) * 1.5;
      const len = bladeLen * (0.55 + rand(cx, cy, t * 7 + b + 80) * 0.75);
      const tipX = rx + Math.sin(lean) * len * 0.75;
      const tipY = ry - Math.cos(lean * 0.5) * len;
      // Olive-leaning and a shade darker than the obvious choice. Bright
      // saturated green turned every meadow cell into a loud cartoon lawn that
      // out-shouted the ants, which are the thing you're meant to be watching.
      const g = 96 + shade * 46 + b * 5;
      ctx.strokeStyle = `rgba(${Math.round(62 + shade * 34)},${Math.round(g)},${Math.round(44 + shade * 26)},0.80)`;
      ctx.lineWidth = Math.max(0.7, 1.35 * scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(rx, ry);
      ctx.quadraticCurveTo(rx + Math.sin(lean) * len * 0.3, ry - len * 0.62, tipX, tipY);
      ctx.stroke();
    }
    // A dab of shadow at the root so the tuft is standing in the soil, not
    // floating above it.
    ctx.fillStyle = 'rgba(24,32,16,0.22)';
    ctx.beginPath();
    ctx.ellipse(rx, ry + scale, bladeLen * 0.3, bladeLen * 0.12, 0, 0, TAU);
    ctx.fill();
  }
}

function drawLitterCell(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, cs: number, scale: number,
  cx: number, cy: number, density: number, mode: DetailMode,
) {
  // Two per cell, not four: at four the ground vanished under a uniform
  // carpet of identical orange pods. Leaf litter should be something you
  // notice lying *on* the soil, with soil still visible between.
  const leaves = Math.round(2 * density);
  for (let i = 0; i < leaves; i++) {
    const x = ox + rand(cx, cy, i * 5 + 100) * cs;
    const y = oy + rand(cx, cy, i * 5 + 101) * cs;
    const r = cs * (0.08 + rand(cx, cy, i * 5 + 102) * 0.13);
    const rot = rand(cx, cy, i * 5 + 103) * TAU;
    const tone = rand(cx, cy, i * 5 + 104);
    // Dead-leaf colours, and mostly the *old* end of the range: rust and
    // ochre for a freshly fallen one, faded grey-brown for the rest.
    const age = rand(cx, cy, i * 5 + 105);
    const fill = `rgb(${clamp255(112 + tone * 74 - age * 34)},${clamp255(72 + tone * 52 - age * 20)},${clamp255(36 + tone * 30)})`;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.fillStyle = 'rgba(0,0,0,0.20)';
    leafPath(ctx, r * 1.02, r * 0.5);
    ctx.translate(-r * 0.06, r * 0.09);
    ctx.fill();
    ctx.translate(r * 0.06, -r * 0.09);
    ctx.fillStyle = fill;
    leafPath(ctx, r, r * 0.48);
    ctx.fill();
    // Midrib: the single line that makes an ellipse read as a leaf.
    ctx.strokeStyle = `rgba(${clamp255(92 + tone * 30)},${clamp255(56 + tone * 20)},22,0.55)`;
    ctx.lineWidth = Math.max(0.5, scale);
    ctx.beginPath();
    ctx.moveTo(-r, 0);
    ctx.lineTo(r, 0);
    ctx.stroke();
    ctx.restore();
  }
  // Bare soil still shows through between the leaves.
  if (mode === 'bake') drawDirtCell(ctx, ox, oy, cs, scale, cx + 977, cy + 331, mode);
}

/** A pointed-both-ends leaf outline, centred, pointing along +X. */
function leafPath(ctx: CanvasRenderingContext2D, halfLen: number, halfWidth: number) {
  ctx.beginPath();
  ctx.moveTo(-halfLen, 0);
  ctx.quadraticCurveTo(0, -halfWidth, halfLen, 0);
  ctx.quadraticCurveTo(0, halfWidth, -halfLen, 0);
  ctx.closePath();
}

function drawDirtCell(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, cs: number, scale: number,
  cx: number, cy: number, mode: DetailMode,
) {
  // Soil grain: fine light and dark specks, the texture of turned earth.
  for (let i = 0; mode === 'bake' && i < 14; i++) {
    const x = ox + rand(cx, cy, i * 2 + 200) * cs;
    const y = oy + rand(cx, cy, i * 2 + 201) * cs;
    // Kept deliberately small and low-contrast: the bake is magnified by the
    // camera zoom, and chunky bright grain turns into floating out-of-focus
    // dust when you get close. Crisp close-up texture comes from the renderer's
    // screen-space grain pass instead.
    const s = Math.max(0.8, (0.6 + rand(cx, cy, i + 220) * 0.9) * scale);
    ctx.fillStyle = rand(cx, cy, i + 240) < 0.55 ? 'rgba(58,40,24,0.24)' : 'rgba(186,160,126,0.13)';
    ctx.fillRect(x, y, s, s);
  }
  // A pebble in roughly half the cells, occasionally two, lit from the
  // top-left like everything else. One per cell everywhere read as a field of
  // identical grey bubbles rather than scattered stones.
  const roll = rand(cx, cy, 260);
  const pebbles = roll < 0.12 ? 2 : roll < 0.55 ? 1 : 0;
  for (let i = 0; i < pebbles; i++) {
    const x = ox + rand(cx, cy, i + 270) * cs;
    const y = oy + rand(cx, cy, i + 271) * cs;
    const r = cs * (0.016 + rand(cx, cy, i + 272) * 0.026);
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.25, y + r * 0.4, r, r * 0.7, 0, 0, TAU);
    ctx.fill();
    // Warmer and darker than before — stones lying in soil pick up its colour,
    // and bright neutral grey made them pop off the ground like beads.
    const tone = 98 + rand(cx, cy, i + 273) * 46;
    const rot = rand(cx, cy, i + 274) * TAU;
    if (mode === 'bake') {
      const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
      g.addColorStop(0, `rgb(${clamp255(tone + 34)},${clamp255(tone + 28)},${clamp255(tone + 18)})`);
      g.addColorStop(1, `rgb(${clamp255(tone - 38)},${clamp255(tone - 40)},${clamp255(tone - 42)})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.82, rot, 0, TAU);
      ctx.fill();
    } else {
      // Two flat fills instead of a gradient object per pebble per frame:
      // a dark body with a lit crescent offset toward the key light. At the
      // size a pebble occupies, the difference is invisible.
      ctx.fillStyle = `rgb(${clamp255(tone - 24)},${clamp255(tone - 28)},${clamp255(tone - 32)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.82, rot, 0, TAU);
      ctx.fill();
      ctx.fillStyle = `rgb(${clamp255(tone + 28)},${clamp255(tone + 22)},${clamp255(tone + 12)})`;
      ctx.beginPath();
      ctx.ellipse(x - r * 0.22, y - r * 0.22, r * 0.62, r * 0.48, rot, 0, TAU);
      ctx.fill();
    }
  }
}

function drawSandCell(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, cs: number, scale: number,
  cx: number, cy: number, mode: DetailMode,
) {
  for (let i = 0; mode === 'bake' && i < 26; i++) {
    const x = ox + rand(cx, cy, i * 2 + 300) * cs;
    const y = oy + rand(cx, cy, i * 2 + 301) * cs;
    ctx.fillStyle = rand(cx, cy, i + 320) < 0.5 ? 'rgba(255,244,214,0.30)' : 'rgba(142,116,74,0.22)';
    ctx.fillRect(x, y, Math.max(0.8, scale), Math.max(0.8, scale));
  }
  // Wind ripples: shallow parallel arcs, the signature of dry loose sand.
  const dir = rand(cx, cy, 340) * 0.9 - 0.45;
  for (let i = 0; i < 3; i++) {
    const y = oy + ((i + rand(cx, cy, i + 341)) / 3) * cs;
    ctx.strokeStyle = 'rgba(160,132,86,0.16)';
    ctx.lineWidth = Math.max(0.8, 1.6 * scale);
    ctx.beginPath();
    ctx.moveTo(ox, y);
    ctx.quadraticCurveTo(ox + cs * 0.5, y + Math.sin(dir) * cs * 0.22, ox + cs, y + dir * cs * 0.1);
    ctx.stroke();
  }
}

function drawRockCell(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, cs: number, scale: number,
  cx: number, cy: number, mode: DetailMode,
) {
  // Outcrop: a couple of angular slabs rather than a grey wash, so stony
  // ground looks like broken stone from above.
  for (let i = 0; i < 3; i++) {
    const x = ox + (0.2 + rand(cx, cy, i * 4 + 400) * 0.6) * cs;
    const y = oy + (0.2 + rand(cx, cy, i * 4 + 401) * 0.6) * cs;
    const r = cs * (0.16 + rand(cx, cy, i * 4 + 402) * 0.2);
    const sides = 5 + Math.floor(rand(cx, cy, i * 4 + 403) * 3);
    const rot = rand(cx, cy, i + 420) * TAU;
    ctx.beginPath();
    for (let k = 0; k < sides; k++) {
      const a = rot + (k / sides) * TAU;
      const rr = r * (0.68 + rand(cx, cy, i * 9 + k + 430) * 0.42);
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr * 0.82;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const tone = 120 + rand(cx, cy, i + 440) * 40;
    if (mode === 'bake') {
      const g = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
      g.addColorStop(0, `rgb(${clamp255(tone + 46)},${clamp255(tone + 44)},${clamp255(tone + 40)})`);
      g.addColorStop(1, `rgb(${clamp255(tone - 44)},${clamp255(tone - 44)},${clamp255(tone - 42)})`);
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = `rgb(${clamp255(tone + 6)},${clamp255(tone + 4)},${tone | 0})`;
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(40,38,34,0.45)';
    ctx.lineWidth = Math.max(0.6, scale);
    ctx.stroke();
  }
  for (let i = 0; mode === 'bake' && i < 8; i++) {
    const x = ox + rand(cx, cy, i * 2 + 460) * cs;
    const y = oy + rand(cx, cy, i * 2 + 461) * cs;
    ctx.fillStyle = 'rgba(60,58,54,0.28)';
    ctx.fillRect(x, y, Math.max(0.8, 1.4 * scale), Math.max(0.8, 1.4 * scale));
  }
}

function drawWaterCell(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number, cs: number, scale: number,
  cx: number, cy: number, interior: boolean,
) {
  // Standing water: darker and *smoother* than the ground around it, with no
  // speckle — flat specular sheen is exactly what separates water from mud.
  //
  // Drawn as overlapping soft-edged blobs rather than a `fillRect` per cell.
  // The rectangles gave every pond a hard staircase outline and a visible
  // 40-unit grid, which was the most obviously synthetic thing on the map;
  // blobs from neighbouring cells blend into one continuous body of water.
  const mx = ox + cs * 0.5;
  const my = oy + cs * 0.5;
  const r = cs * 0.78;
  const g = ctx.createRadialGradient(mx, my, 0, mx, my, r);
  g.addColorStop(0, 'rgba(26, 50, 62, 0.44)');
  g.addColorStop(0.6, 'rgba(26, 50, 62, 0.34)');
  g.addColorStop(1, 'rgba(26, 50, 62, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(mx - r, my - r, r * 2, r * 2);

  if (!interior) {
    // Silt collects where the water meets the bank.
    const sg = ctx.createRadialGradient(mx, my, cs * 0.2, mx, my, cs * 0.8);
    sg.addColorStop(0, 'rgba(150, 130, 94, 0)');
    sg.addColorStop(0.75, 'rgba(150, 130, 94, 0.22)');
    sg.addColorStop(1, 'rgba(150, 130, 94, 0)');
    ctx.fillStyle = sg;
    ctx.fillRect(mx - cs * 0.8, my - cs * 0.8, cs * 1.6, cs * 1.6);
  }

  // Specular glints off the surface.
  for (let i = 0; i < 2; i++) {
    const x = ox + rand(cx, cy, i + 500) * cs * 0.7;
    const y = oy + rand(cx, cy, i + 501) * cs;
    ctx.strokeStyle = 'rgba(198,226,238,0.16)';
    ctx.lineWidth = Math.max(0.8, 1.8 * scale);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + cs * 0.3, y - cs * 0.04);
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Obstacles
// ---------------------------------------------------------------------------

function drawObstacle(ctx: CanvasRenderingContext2D, o: Obstacle, scale: number) {
  const x = o.pos.x * scale;
  const y = o.pos.y * scale;
  const r = o.radius * scale;
  const seed = Math.round(o.pos.x * 7 + o.pos.y * 13);

  if (o.kind === 'rock') {
    // Contact shadow first, offset down-right to match the world's top-left
    // key light (the same one the ant sprites and the nest mound assume).
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.14, y + r * 0.3, r * 1.02, r * 0.72, 0, 0, TAU);
    ctx.fill();

    // Irregular boulder outline — a perfect circle read as a bubble.
    ctx.beginPath();
    const sides = 9;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * TAU;
      const rr = r * (0.78 + rand(seed, k, 600) * 0.34);
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr * 0.9;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    const g = ctx.createLinearGradient(x - r, y - r, x + r * 0.8, y + r);
    g.addColorStop(0, '#b9b5aa');
    g.addColorStop(0.5, '#8b8781');
    g.addColorStop(1, '#4e4b46');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(38,36,32,0.5)';
    ctx.lineWidth = Math.max(0.8, 1.2 * scale);
    ctx.stroke();
    // A couple of cracks so it has a surface.
    ctx.strokeStyle = 'rgba(44,42,38,0.35)';
    ctx.lineWidth = Math.max(0.6, scale);
    for (let k = 0; k < 2; k++) {
      const a = rand(seed, k, 620) * TAU;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a) * r * 0.15, y + Math.sin(a) * r * 0.15);
      ctx.lineTo(x + Math.cos(a + 0.6) * r * 0.8, y + Math.sin(a + 0.6) * r * 0.7);
      ctx.stroke();
    }
    return;
  }

  if (o.kind === 'twig') {
    const a = rand(seed, 0, 700) * TAU;
    const dx = Math.cos(a) * r;
    const dy = Math.sin(a) * r;
    ctx.save();
    ctx.lineCap = 'round';
    // Shadow, then the twig, then a lit edge along the top — a bare stroke
    // read as a pencil mark rather than a piece of wood.
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = Math.max(1.4, r * 0.5);
    ctx.beginPath();
    ctx.moveTo(x - dx + r * 0.1, y - dy + r * 0.16);
    ctx.quadraticCurveTo(x + r * 0.1, y + r * 0.16, x + dx + r * 0.1, y + dy + r * 0.16);
    ctx.stroke();

    ctx.strokeStyle = '#5b4326';
    ctx.lineWidth = Math.max(1.2, r * 0.42);
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy);
    ctx.quadraticCurveTo(x + dy * 0.18, y - dx * 0.18, x + dx, y + dy);
    ctx.stroke();
    // Side branch.
    ctx.lineWidth = Math.max(0.8, r * 0.22);
    ctx.beginPath();
    ctx.moveTo(x + dx * 0.2, y + dy * 0.2);
    ctx.lineTo(x + dx * 0.2 + dy * 0.5, y + dy * 0.2 - dx * 0.5);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(176,140,92,0.45)';
    ctx.lineWidth = Math.max(0.5, r * 0.12);
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy - r * 0.12);
    ctx.quadraticCurveTo(x + dy * 0.18, y - dx * 0.18 - r * 0.12, x + dx, y + dy - r * 0.12);
    ctx.stroke();
    ctx.restore();
    return;
  }

  // Leaf.
  const rot = rand(seed, 0, 800) * TAU;
  const tone = rand(seed, 1, 801);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.translate(r * 0.08, r * 0.12);
  leafPath(ctx, r * 1.05, r * 0.6);
  ctx.fill();
  ctx.translate(-r * 0.08, -r * 0.12);
  const g = ctx.createLinearGradient(-r, -r * 0.6, r, r * 0.6);
  g.addColorStop(0, `rgb(${clamp255(196 + tone * 40)},${clamp255(128 + tone * 40)},${clamp255(52 + tone * 30)})`);
  g.addColorStop(1, `rgb(${clamp255(132 + tone * 30)},${clamp255(74 + tone * 26)},${clamp255(30 + tone * 18)})`);
  ctx.fillStyle = g;
  leafPath(ctx, r, r * 0.58);
  ctx.fill();
  // Midrib plus a few side veins.
  ctx.strokeStyle = 'rgba(94,54,20,0.5)';
  ctx.lineWidth = Math.max(0.6, r * 0.06);
  ctx.beginPath();
  ctx.moveTo(-r, 0);
  ctx.lineTo(r, 0);
  ctx.stroke();
  ctx.lineWidth = Math.max(0.4, r * 0.035);
  for (let k = -2; k <= 2; k++) {
    if (k === 0) continue;
    const bx = k * r * 0.3;
    ctx.beginPath();
    ctx.moveTo(bx, 0);
    ctx.lineTo(bx + r * 0.22, -r * 0.3);
    ctx.moveTo(bx, 0);
    ctx.lineTo(bx + r * 0.22, r * 0.3);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Live wetness overlay
// ---------------------------------------------------------------------------

/**
 * Sample the live wetness grid and draw semi-transparent damp patches over
 * whatever's currently on screen. Cheap: only iterates cells inside the
 * visible rect, and skips anything drier than a visible threshold.
 *
 * Cells are drawn as soft radial blobs rather than hard rectangles — rain
 * soaking into ground does not come in 40-unit squares, and the grid pattern
 * was the most artificial-looking thing on the map in the wet.
 */
export function drawWetness(
  ctx: CanvasRenderingContext2D,
  grid: TerrainGridData,
  visible: { minX: number; minY: number; maxX: number; maxY: number },
  worldToScreenScale: (wx: number, wy: number) => [number, number],
) {
  const cs = grid.cellSize;
  const minCx = Math.max(0, Math.floor(visible.minX / cs));
  const maxCx = Math.min(grid.cols - 1, Math.floor(visible.maxX / cs));
  const minCy = Math.max(0, Math.floor(visible.minY / cs));
  const maxCy = Math.min(grid.rows - 1, Math.floor(visible.maxY / cs));
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const w = grid.wetness[cy * grid.cols + cx];
      if (w < 0.12) continue;
      const [sx, sy] = worldToScreenScale((cx + 0.5) * cs, (cy + 0.5) * cs);
      const [sx2, sy2] = worldToScreenScale((cx + 1.5) * cs, (cy + 1.5) * cs);
      const r = Math.max(1, (sx2 - sx) * 0.95);
      const a = Math.min(0.55, w * 0.55);
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      g.addColorStop(0, `rgba(36, 62, 96, ${a})`);
      g.addColorStop(0.6, `rgba(36, 62, 96, ${a * 0.7})`);
      g.addColorStop(1, 'rgba(36, 62, 96, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    }
  }
}
