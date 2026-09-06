import type { PerformanceProfile, PerformanceTierName } from './types';

/**
 * The four processing-power tiers the user picks from in Settings.
 * These numbers are deliberately conservative on `low` (a phone/tablet
 * pushing a big <canvas> in a browser is not a powerful GPU) and go
 * aggressively big on `beast` (a dedicated server / workstation).
 */
export const PERFORMANCE_PROFILES: Record<PerformanceTierName, PerformanceProfile> = {
  low: {
    name: 'low',
    label: 'Low — Phone / Tablet',
    blurb: 'Smooth on an iPad, an older laptop, or a phone browser. One colony, modest population.',
    maxAnts: 150,
    maxColonies: 1,
    maxPredators: 2,
    worldWidth: 2200,
    worldHeight: 1400,
    pheromoneCellSize: 24,
    pheromoneDiffusion: false,
    simSubsteps: 1,
    spatialCellSize: 80,
    maxDevicePixelRatio: 1.25,
    render: {
      antLegAnimation: false,
      pheromoneGlow: false,
      softShadows: false,
      weatherParticles: false,
      ambientLighting: true,
      antiAlias: false,
      maxParticles: 40,
      trailFade: false,
    },
  },
  medium: {
    name: 'medium',
    label: 'Medium — Laptop / Desktop',
    blurb: 'A regular laptop or desktop browser. A couple of colonies, real pheromone trails.',
    maxAnts: 600,
    maxColonies: 3,
    maxPredators: 5,
    worldWidth: 3600,
    worldHeight: 2200,
    pheromoneCellSize: 16,
    pheromoneDiffusion: true,
    simSubsteps: 1,
    spatialCellSize: 64,
    maxDevicePixelRatio: 1.75,
    render: {
      antLegAnimation: true,
      pheromoneGlow: true,
      softShadows: false,
      weatherParticles: true,
      ambientLighting: true,
      antiAlias: true,
      maxParticles: 250,
      trailFade: true,
    },
  },
  high: {
    name: 'high',
    label: 'High — MacBook Pro / Gaming PC',
    blurb: 'Full graphics: glow trails, weather, soft shadows. Several warring colonies.',
    maxAnts: 2200,
    maxColonies: 6,
    maxPredators: 10,
    worldWidth: 5200,
    worldHeight: 3200,
    pheromoneCellSize: 12,
    pheromoneDiffusion: true,
    simSubsteps: 2,
    spatialCellSize: 56,
    maxDevicePixelRatio: 2,
    render: {
      antLegAnimation: true,
      pheromoneGlow: true,
      softShadows: true,
      weatherParticles: true,
      ambientLighting: true,
      antiAlias: true,
      maxParticles: 700,
      trailFade: true,
    },
  },
  beast: {
    name: 'beast',
    label: 'Beast — Workstation / Server',
    blurb: 'Push it. Thousands of ants, a dozen colonies at war, dense pheromone fields.',
    maxAnts: 9000,
    maxColonies: 14,
    maxPredators: 24,
    worldWidth: 8000,
    worldHeight: 5000,
    pheromoneCellSize: 10,
    pheromoneDiffusion: true,
    simSubsteps: 3,
    spatialCellSize: 48,
    maxDevicePixelRatio: 2,
    render: {
      antLegAnimation: true,
      pheromoneGlow: true,
      softShadows: true,
      weatherParticles: true,
      ambientLighting: true,
      antiAlias: true,
      maxParticles: 2000,
      trailFade: true,
    },
  },
};

export const PERFORMANCE_TIER_ORDER: PerformanceTierName[] = ['low', 'medium', 'high', 'beast'];

/** Heuristic auto-pick based on rough client capability signals. Never trusted
 * blindly — it's just the default the Settings panel preselects. */
export function autoDetectTier(): PerformanceTierName {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const isCoarsePointer = matchMedia?.('(pointer: coarse)').matches ?? false;
  const dpr = window.devicePixelRatio ?? 1;

  if (isCoarsePointer && cores <= 6) return 'low';
  if (cores >= 16 && mem >= 8) return 'beast';
  if (cores >= 8 && mem >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return dpr > 2 ? 'medium' : 'low';
}
