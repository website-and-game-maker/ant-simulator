import type { SpeciesProfile } from './types';

// Lifespans/timings are expressed in sim-seconds. A "day" is ~120s by default
// (see weather.ts), so these are tuned so a colony visibly grows, wars, and
// eventually turns over generations within a play session of a few minutes,
// rather than modeling literal real-ant-years.
export const DEFAULT_SPECIES: SpeciesProfile = {
  id: 'formica-ludens',
  name: 'Formica ludens (garden ant, simulated)',
  baseColorHue: 18, // amber/rust — classic "ant" color
  baseSpeed: 34, // world units/sec at genetics.speed = 1
  baseLifespanTicks: {
    worker: 900, // ~15 sim-minutes
    soldier: 780,
    queen: 9000, // queens live far longer than workers, as in reality
    drone: 240, // drones die shortly after the nuptial flight
    alateQueen: 9000, // her lifespan once she founds a colony, if she gets there
  },
  larvaMatureTicks: 70,
  eggTicks: 18,
  metabolism: 0.9, // energy points/sec baseline
  aggressionBase: 0.35,
};

export const RIVAL_HUES = [18, 210, 285, 140, 0, 45, 320, 170, 260, 95];
