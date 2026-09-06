import type { Vec2 } from './vec2';
import type { PerformanceTierName, PerformanceProfile, AntSnapshot, ColonySnapshot, WorldSnapshot } from './types';
import type { EventBus } from './eventBus';

/**
 * The public control surface of the simulation engine, as seen by the
 * renderer and the UI layer. Neither should ever reach into Simulation's
 * private fields — everything they need is here or in a WorldSnapshot.
 *
 * `src/sim/simulation.ts` implements this. UI/renderer code should code
 * against `ISimulation`, not the concrete class, so engine internals can
 * change freely.
 */
export interface ISimulation {
  readonly events: EventBus;

  // --- lifecycle / control -------------------------------------------------
  setTier(tier: PerformanceTierName): void;
  getTier(): PerformanceTierName;
  getProfile(): PerformanceProfile;
  restart(seed?: number): void;

  setSpeed(multiplier: number): void; // 0 = paused, 1 = normal, up to ~8
  getSpeed(): number;
  togglePause(): void;
  isPaused(): boolean;

  setView(view: 'surface' | 'underground'): void;
  getView(): 'surface' | 'underground';

  /** Advance the simulation by `realDtSeconds` of wall-clock time (internally
   * scaled by speed multiplier and fixed-stepped for stability). */
  update(realDtSeconds: number): void;

  // --- world interaction (things a player can click/tap to do) ------------
  placeFoodAt(pos: Vec2): void;
  spawnPredatorAt(pos: Vec2): void;
  foundColonyAt(pos: Vec2): boolean;

  selectAt(pos: Vec2): void;
  clearSelection(): void;
  getSelectedAnt(): AntSnapshot | null;
  getSelectedColony(): ColonySnapshot | null;

  // --- read-only data for rendering/UI -------------------------------------
  getSnapshot(): WorldSnapshot;
}
