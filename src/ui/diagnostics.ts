/**
 * The context attached to a feedback report.
 *
 * "The ants all died" is an anecdote; "the ants all died, medium tier, seed
 * 1873402231, day 4, 41 starvation deaths, 0 food in either colony" is a bug
 * report. Because the simulation is deterministic in its seed, capturing the
 * seed alone means any run can be replayed exactly — which is the single most
 * valuable thing this file does.
 *
 * Two rules shape everything here:
 *
 * 1. **It must never throw.** This runs at the moment a frustrated user is
 *    trying to tell us something broke. A diagnostics failure that swallows
 *    their report would be the worst possible bug in this feature, so every
 *    probe is individually guarded and missing values are simply omitted.
 *
 * 2. **It must be showable.** The report is destined for a *public* GitHub
 *    issue, so the user is shown this exact object before sending and can
 *    decline to attach it. Nothing is collected that we wouldn't be happy to
 *    display: no storage contents, no input history, no network information,
 *    no persistent identifier.
 */

import type { ISimulation } from '../sim/facade';
import type { DeathCause } from '../sim/types';
import { APP_BUILT_AT, APP_COMMIT, APP_VERSION } from '../appInfo';

export interface Diagnostics {
  app: {
    version: string;
    commit: string;
    builtAt: string;
    url: string;
    capturedAt: string;
    /** Seconds this tab has been open — distinguishes "broke immediately"
     * from "broke after twenty minutes". */
    sessionSeconds: number;
  };
  sim: {
    seed: number;
    tier: string;
    speed: number;
    paused: boolean;
    view: string;
    day: number;
    clock: string;
    simTimeSeconds: number;
    worldSize: string;
    ants: number;
    larvae: number;
    colonies: number;
    predators: number;
    birthsPerMinute: number;
    deathsPerMinute: number;
    deathsByCause: Partial<Record<DeathCause, number>>;
    weather: string;
    fps: number;
    simMsPerFrame: number;
  };
  /** One line per colony: enough to see a colony starving or queenless. */
  colonies: string[];
  env: {
    userAgent: string;
    platform?: string;
    language?: string;
    viewport: string;
    devicePixelRatio: number;
    cores?: number;
    memoryGb?: number;
    touch: boolean;
    reducedMotion: boolean;
    /** GPU string via WEBGL_debug_renderer_info, when the browser exposes it.
     * Frequently the deciding clue in a "it runs at 5fps" report. */
    gpu?: string;
  };
}

const SESSION_START = Date.now();

/** Run a probe, returning undefined instead of throwing. Feature detection
 * alone isn't enough — some of these throw on access under hardened privacy
 * settings rather than being absent. */
function safe<T>(fn: () => T): T | undefined {
  try {
    const v = fn();
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * The GPU string, read once and cached.
 *
 * This needs a throwaway WebGL context, which is not free, so it is cached for
 * the life of the page. Firefox with `privacy.resistFingerprinting` and Safari
 * both mask or omit the debug extension; in that case we simply don't report
 * it rather than substituting a misleading generic value.
 */
let gpuCache: string | null | undefined;
function gpuInfo(): string | undefined {
  if (gpuCache !== undefined) return gpuCache ?? undefined;
  gpuCache = null;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        const renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
        if (typeof renderer === 'string' && renderer) gpuCache = renderer.slice(0, 120);
      }
      // Release the context rather than leaving it to the GC; browsers cap
      // how many live WebGL contexts a page may hold.
      safe(() => gl.getExtension('WEBGL_lose_context')?.loseContext());
    }
  } catch {
    /* not available — omit the field */
  }
  return gpuCache ?? undefined;
}

/** Non-zero death causes only, so the block stays short and every line in it
 * means something. */
function trimDeaths(byCause: Record<DeathCause, number>): Partial<Record<DeathCause, number>> {
  const out: Partial<Record<DeathCause, number>> = {};
  for (const [cause, n] of Object.entries(byCause ?? {})) {
    if (typeof n === 'number' && n > 0) out[cause as DeathCause] = n;
  }
  return out;
}

const DAY_SECONDS = 150;

export function captureDiagnostics(sim: ISimulation): Diagnostics {
  const snap = sim.getSnapshot();
  const stats = snap.stats;

  const day = Math.floor((stats.simTime + DAY_SECONDS / 2) / DAY_SECONDS) + 1;
  const hh = Math.floor(snap.timeOfDay * 24);
  const mm = Math.floor(snap.timeOfDay * 24 * 60) % 60;

  return {
    app: {
      version: APP_VERSION,
      commit: APP_COMMIT,
      builtAt: APP_BUILT_AT,
      url: safe(() => location.href.split('#')[0]) ?? 'unknown',
      capturedAt: new Date().toISOString(),
      sessionSeconds: Math.round((Date.now() - SESSION_START) / 1000),
    },
    sim: {
      seed: safe(() => sim.getSeed()) ?? -1,
      tier: sim.getTier(),
      speed: sim.getSpeed(),
      paused: sim.isPaused(),
      view: sim.getView(),
      day,
      clock: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
      simTimeSeconds: Math.round(stats.simTime),
      worldSize: `${snap.width}x${snap.height}`,
      ants: stats.totalAnts,
      larvae: stats.totalLarvae,
      colonies: stats.totalColonies,
      predators: stats.totalPredators,
      birthsPerMinute: Math.round(stats.birthsPerMinute),
      deathsPerMinute: Math.round(stats.deathsPerMinute),
      deathsByCause: trimDeaths(stats.deathsByCause),
      weather: stats.weather,
      fps: Math.round(stats.fps),
      simMsPerFrame: Math.round(stats.simMsPerFrame * 100) / 100,
    },
    colonies: snap.colonies
      .slice(0, 12)
      .map(
        (c) =>
          `${c.name}: ${c.population} ants, ${Math.round(c.foodStore)} food, queen ${c.queenAlive ? 'alive' : 'dead'}${c.alive ? '' : ', COLLAPSED'}`,
      ),
    env: {
      userAgent: safe(() => navigator.userAgent.slice(0, 200)) ?? 'unknown',
      platform: safe(() => (navigator as Navigator & { platform?: string }).platform),
      language: safe(() => navigator.language),
      viewport: safe(() => `${window.innerWidth}x${window.innerHeight}`) ?? 'unknown',
      devicePixelRatio: safe(() => window.devicePixelRatio) ?? 1,
      cores: safe(() => navigator.hardwareConcurrency),
      memoryGb: safe(() => (navigator as Navigator & { deviceMemory?: number }).deviceMemory),
      touch: safe(() => matchMedia('(pointer: coarse)').matches) ?? false,
      reducedMotion: safe(() => matchMedia('(prefers-reduced-motion: reduce)').matches) ?? false,
      gpu: gpuInfo(),
    },
  };
}

/**
 * Render diagnostics as the Markdown that goes into the issue body.
 *
 * Deliberately two things at once: a short human-readable summary that a
 * maintainer reads at a glance, and a fenced JSON block that
 * `scripts/feedbackDigest.mjs` parses back out. The fence is tagged `json` so
 * GitHub highlights it, and carries a marker line so the digest can find it
 * without guessing which of several code blocks is ours.
 */
export const DIAGNOSTICS_MARKER = 'formicarium-diagnostics';

export function diagnosticsToMarkdown(d: Diagnostics): string {
  const deaths = Object.entries(d.sim.deathsByCause);
  const deathLine = deaths.length ? deaths.map(([k, v]) => `${k} ${v}`).join(', ') : 'none yet';

  const summary = [
    `| | |`,
    `| --- | --- |`,
    `| Build | \`${d.app.version}\` (\`${d.app.commit}\`) |`,
    `| Seed | \`${d.sim.seed}\` |`,
    `| Tier | ${d.sim.tier} |`,
    `| World | day ${d.sim.day}, ${d.sim.clock}, ${d.sim.weather} |`,
    `| Population | ${d.sim.ants} ants, ${d.sim.larvae} larvae, ${d.sim.colonies} colonies, ${d.sim.predators} predators |`,
    `| Deaths | ${deathLine} |`,
    `| Performance | ${d.sim.fps} fps, ${d.sim.simMsPerFrame} ms/frame sim |`,
    `| Display | ${d.env.viewport} @${d.env.devicePixelRatio}x${d.env.gpu ? `, ${d.env.gpu}` : ''} |`,
  ].join('\n');

  const colonies = d.colonies.length ? `\n\nColonies:\n${d.colonies.map((c) => `- ${c}`).join('\n')}` : '';

  return [
    summary,
    colonies,
    '',
    '<details><summary>Full diagnostics</summary>',
    '',
    '```json',
    `// ${DIAGNOSTICS_MARKER}`,
    JSON.stringify(d, null, 2),
    '```',
    '',
    '</details>',
  ].join('\n');
}
