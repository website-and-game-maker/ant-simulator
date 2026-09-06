import type { BiomeType, Obstacle, TerrainGridData } from '../sim/types';

const BIOME_NAMES: BiomeType[] = ['grass', 'dirt', 'sand', 'rock', 'puddle', 'leafLitter'];

// A bit more saturated/contrasty than real dirt — this is a stylized
// simulator, not a satellite photo, and flat muted tones were reading as
// dull. These get smoothly interpolated between cells (see below), so
// pushing them punchier here doesn't turn into garish hard blocks.
const BIOME_COLORS: Record<BiomeType, [number, number, number]> = {
  grass: [64, 128, 51],
  dirt: [110, 76, 48],
  sand: [214, 186, 116],
  rock: [124, 122, 118],
  puddle: [51, 97, 112],
  leafLitter: [150, 103, 51],
};

function hash2(x: number, y: number): number {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h ^= h >> 16;
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Bakes the terrain's biome grid + obstacles into a single offscreen canvas
 * so the main render loop can blit one image instead of redrawing thousands
 * of ground cells every frame. Only needs to run again when the world (or
 * performance tier) changes — call it whenever `terrainGrid.biome` is a new
 * array reference.
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

  // --- Base color: each cell is painted as a soft-edged radial blob
  // (rather than a hard-edged rectangle) that overlaps its neighbors, so
  // adjacent cells blend into each other through alpha compositing. Unlike
  // scaling up a tiny 1px-per-cell bitmap, this keeps a real per-pixel
  // gradient baked at full resolution — so it still looks like *something*
  // (not a flat blur) even zoomed in close on a single cell.
  ctx.fillStyle = `rgb(${BIOME_COLORS.dirt.join(',')})`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const cellSize = grid.cellSize * scale;
  const blobRadius = cellSize * 1.05;
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const biome = BIOME_NAMES[grid.biome[cy * grid.cols + cx]];
      const [r, g, b] = BIOME_COLORS[biome];
      const jitter = (hash2(cx, cy) - 0.5) * 22;
      const color = `rgb(${clamp255(r + jitter)}, ${clamp255(g + jitter)}, ${clamp255(b + jitter)})`;
      // Offset each blob's center a little so they don't all line up into a
      // visibly repeating scale pattern.
      const jx = (hash2(cx * 3 + 1, cy * 5 + 1) - 0.5) * cellSize * 0.5;
      const jy = (hash2(cx * 11 + 2, cy * 13 + 2) - 0.5) * cellSize * 0.5;
      const px = (cx + 0.5) * cellSize + jx;
      const py = (cy + 0.5) * cellSize + jy;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, blobRadius);
      grad.addColorStop(0, color);
      grad.addColorStop(0.7, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(px - blobRadius, py - blobRadius, blobRadius * 2, blobRadius * 2);
    }
  }

  // --- Texture on top: every biome gets its own fleck pattern, drawn at
  // full resolution, so there's real detail to look at even zoomed in tight
  // on a single cell — not just a smooth color gradient.
  const FLECKS: Record<BiomeType, [string, number]> = {
    grass: ['rgba(150,220,110,0.28)', 6],
    leafLitter: ['rgba(205,160,80,0.26)', 5],
    dirt: ['rgba(70,48,30,0.22)', 4],
    sand: ['rgba(235,215,160,0.3)', 5],
    rock: ['rgba(80,78,74,0.3)', 3],
    puddle: ['rgba(120,165,185,0.2)', 3],
  };
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const biome = BIOME_NAMES[grid.biome[cy * grid.cols + cx]];
      const [fleckColor, count] = FLECKS[biome];
      ctx.fillStyle = fleckColor;
      for (let i = 0; i < count; i++) {
        const fx = hash2(cx * 7 + i, cy * 13 + i);
        const fy = hash2(cx * 17 + i, cy * 23 + i);
        const fsize = (1.5 + hash2(cx * 29 + i, cy * 31 + i) * 2.5) * scale;
        const px = (cx + fx) * cellSize;
        const py = (cy + fy) * cellSize;
        ctx.fillRect(px, py, Math.max(1, fsize), Math.max(1, fsize));
      }
    }
  }

  for (const o of obstacles) {
    const x = o.pos.x * scale;
    const y = o.pos.y * scale;
    const r = o.radius * scale;
    if (o.kind === 'rock') {
      const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      grad.addColorStop(0, '#a8a59c');
      grad.addColorStop(1, '#57544e');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      // A little occlusion shadow grounds it instead of looking pasted on.
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.ellipse(x, y + r * 0.75, r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (o.kind === 'twig') {
      ctx.strokeStyle = '#5b4326';
      ctx.lineWidth = Math.max(1, r * 0.5);
      ctx.beginPath();
      ctx.moveTo(x - r, y - r * 0.3);
      ctx.lineTo(x + r, y + r * 0.3);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#a8672c';
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.6, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return { canvas, scale };
}

/** Sample the live wetness grid and draw semi-transparent puddle patches over
 * whatever's currently on screen. Cheap: only iterates cells inside the
 * visible rect, and skips anything drier than a visible threshold. */
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
      const [sx, sy] = worldToScreenScale(cx * cs, cy * cs);
      const [sx2, sy2] = worldToScreenScale((cx + 1) * cs, (cy + 1) * cs);
      ctx.fillStyle = `rgba(40, 70, 110, ${Math.min(0.6, w * 0.6)})`;
      ctx.fillRect(sx, sy, sx2 - sx, sy2 - sy);
    }
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}
