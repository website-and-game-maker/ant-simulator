import type { WeatherState } from './types';
import { chance, clamp, type RNG } from './rng';

const DAY_LENGTH_SECONDS = 150; // one full day/night cycle, in sim-seconds

/**
 * Day/night cycle and weather state machine. Both feed back into the sim:
 * night (and storms) slow ants down and cool the colony's activity; rain
 * fills puddles (a drowning hazard) and washes pheromone trails out faster.
 */
export class WeatherSystem {
  private clock = 0; // 0..DAY_LENGTH_SECONDS, wraps
  weather: WeatherState = 'clear';
  private weatherTimer: number;
  rainIntensity = 0;

  constructor(private rng: RNG) {
    // Drawn from the seeded RNG (not Math.random()) so two runs with the
    // same seed see their first weather change at the same moment — weather
    // affects puddles, pheromone evaporation, and ant deaths, so this
    // mattered for reproducibility.
    this.weatherTimer = WeatherSystem.rand(this.rng, 20, 50);
  }

  private static rand(rng: RNG, min: number, max: number) {
    return min + rng() * (max - min);
  }

  get timeOfDay(): number {
    return this.clock / DAY_LENGTH_SECONDS;
  }

  get isDaytime(): boolean {
    const t = this.timeOfDay;
    return t > 0.22 && t < 0.78;
  }

  /** 0..1+ multiplier applied to ant/colony activity: dips at night, dips
   * further in storms, since real foragers do reduce activity in bad weather. */
  get activityMultiplier(): number {
    const t = this.timeOfDay;
    // Smooth day/night curve peaking at noon (t=0.5).
    const daylight = 0.35 + 0.65 * Math.max(0, Math.sin((t - 0.22) * Math.PI * (1 / 0.56)));
    const dayFactor = this.isDaytime ? daylight : 0.32;
    const weatherFactor = this.weather === 'storm' ? 0.55 : this.weather === 'rain' ? 0.8 : 1;
    return clamp(dayFactor * weatherFactor, 0.2, 1.1);
  }

  step(dt: number, terrain: { applyRain: (dt: number, intensity: number) => void; dryOut: (dt: number) => void }): {
    dayNightFlipped: boolean;
    weatherChanged: boolean;
  } {
    const wasDay = this.isDaytime;
    this.clock = (this.clock + dt) % DAY_LENGTH_SECONDS;
    const dayNightFlipped = wasDay !== this.isDaytime;

    let weatherChanged = false;
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      weatherChanged = this.rollWeather();
      this.weatherTimer = WeatherSystem.rand(this.rng, 25, 60);
    }

    const targetIntensity = this.weather === 'storm' ? 1 : this.weather === 'rain' ? 0.55 : 0;
    this.rainIntensity += (targetIntensity - this.rainIntensity) * clamp(dt * 0.5, 0, 1);

    if (this.rainIntensity > 0.05) terrain.applyRain(dt, this.rainIntensity);
    else terrain.dryOut(dt);

    return { dayNightFlipped, weatherChanged };
  }

  private rollWeather(): boolean {
    const prev = this.weather;
    const roll = this.rng();
    switch (this.weather) {
      case 'clear':
        this.weather = chance(this.rng, 0.28) ? 'overcast' : 'clear';
        break;
      case 'overcast':
        if (roll < 0.35) this.weather = 'rain';
        else if (roll < 0.55) this.weather = 'clear';
        else this.weather = 'overcast';
        break;
      case 'rain':
        if (roll < 0.2) this.weather = 'storm';
        else if (roll < 0.6) this.weather = 'overcast';
        else this.weather = 'rain';
        break;
      case 'storm':
        this.weather = chance(this.rng, 0.6) ? 'rain' : 'storm';
        break;
    }
    return this.weather !== prev;
  }

  /** Pheromone trails wash out faster in the wet. */
  get evaporationMultiplier(): number {
    return this.weather === 'storm' ? 2.4 : this.weather === 'rain' ? 1.6 : 1;
  }
}
