import type { BiomeType, Obstacle, TerrainGridData } from '../sim/types';

const BIOME_NAMES: BiomeType[] = ['grass', 'dirt', 'sand', 'rock', 'puddle', 'leafLitter'];

const BIOME_COLORS: Record<BiomeType, [number, number, number]> = {
  grass: [58, 99, 47],
  dirt: [92, 66, 46],
  sand: [193, 170, 110],
  rock: [110, 108, 104],
  puddle: [58, 88, 96],
  leafLitter: [128, 92, 52],
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

  const cellSize = grid.cellSize * scale;
  for (let cy = 0; cy < grid.rows; cy++) {
    for (let cx = 0; cx < grid.cols; cx++) {
      const biome = BIOME_NAMES[grid.biome[cy * grid.cols + cx]];
      const [r, g, b] = BIOME_COLORS[biome];
      const jitter = (hash2(cx, cy) - 0.5) * 18;
      ctx.fillStyle = `rgb(${clamp255(r + jitter)}, ${clamp255(g + jitter)}, ${clamp255(b + jitter)})`;
      ctx.fillRect(Math.floor(cx * cellSize), Math.floor(cy * cellSize), Math.ceil(cellSize) + 1, Math.ceil(cellSize) + 1);

      if (biome === 'grass' || biome === 'leafLitter') {
        for (let i = 0; i < 3; i++) {
          const fx = hash2(cx * 7 + i, cy * 13 + i);
          const fy = hash2(cx * 17 + i, cy * 23 + i);
          const px = (cx + fx) * cellSize;
          const py = (cy + fy) * cellSize;
          ctx.fillStyle = biome === 'grass' ? 'rgba(120,190,90,0.18)' : 'rgba(180,140,70,0.2)';
          ctx.fillRect(px, py, Math.max(1, scale * 3), Math.max(1, scale * 3));
        }
      }
    }
  }

  for (const o of obstacles) {
    const x = o.pos.x * scale;
    const y = o.pos.y * scale;
    const r = o.radius * scale;
    if (o.kind === 'rock') {
      const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      grad.addColorStop(0, '#9a978f');
      grad.addColorStop(1, '#57544e');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
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
