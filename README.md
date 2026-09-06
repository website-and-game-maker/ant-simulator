# 🐜 Formicarium

A from-scratch ant colony simulator that tries to model real ant biology
instead of just animating dots: pheromone-trail stigmergy (the actual
mechanism behind Ant Colony Optimization algorithms), genetics with
mutation and a single lifelong mating event per queen, caste decided by
larval nutrition rather than genes, colony founding via nuptial flight,
predators, weather, and a day/night cycle — all rendered with a hand-written
Canvas2D engine, no game engine, no UI framework.

You pick a **processing power** tier (phone up to server-grade workstation)
and the simulation scales its population caps, world size, pheromone
resolution, and visual effects to match.

**Live demo:** https://website-and-game-maker.github.io/ant-simulator/
(deploys automatically from `main` via [GitHub Actions](.github/workflows/deploy.yml))

<!-- TODO: drop a screenshot or GIF of the running sim here -->

## Quick start

```bash
npm install
npm run dev       # start the dev server and open the printed local URL
```

Other scripts:

```bash
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build locally
npm run typecheck  # tsc -b --noEmit
npm run test       # vitest — unit tests for the pure simulation logic
```

It's a fully static, client-side app — `npm run build` produces a `dist/`
folder you can host anywhere (no backend, no database).

## Processing power tiers

Pick one in the in-app Settings panel. Numbers come straight from
[`src/sim/performanceProfiles.ts`](src/sim/performanceProfiles.ts):

| Tier | Target hardware | Max ants | Max colonies | World size | Pheromone cell | Effects |
| --- | --- | --- | --- | --- | --- | --- |
| **Low** | Phone / tablet | 150 | 1 | 2200×1400 | 24u | No glow/shadows, capped DPR |
| **Medium** | Laptop / desktop | 600 | 3 | 3600×2200 | 16u | Trail glow, weather particles |
| **High** | MacBook Pro / gaming PC | 2,200 | 6 | 5200×3200 | 12u | + soft shadows, 2 sim substeps |
| **Beast** | Workstation / server | 9,000 | 14 | 8000×5000 | 10u | Max particles, 3 sim substeps |

Switching tiers regenerates the world. The app also has an `autoDetectTier()`
heuristic (core count, device memory, coarse-pointer check) that preselects
a sensible default on first load.

## Core simulation features

### Pheromone stigmergy
Two chemical channels are laid over the world as coarse grids: a **food
trail** that foragers deposit on the walk home (so the path to a food source
gets reinforced the more ants use it, and fades once the food runs out) and
an **alarm trail** deposited during combat that recruits nearby soldiers.
Each cell also remembers which colony's scent currently dominates it, so
ants mostly follow their own colony's trails and barely register a rival's.
Trails evaporate every tick, and evaporate faster in the rain — see
[`src/sim/pheromones.ts`](src/sim/pheromones.ts).

### Genetics & inheritance
Every ant carries six heritable traits — `speed`, `strength`, `senseRadius`,
`lifespan`, `aggression`, `industriousness` — plus a cosmetic hue. A queen
mates exactly once, during her own nuptial flight, and uses that one
partner's genetics for every egg she ever lays (real ant biology: queens
store sperm for life). Each egg blends the queen's and the stored mate's
traits with a small chance of mutation. See
[`src/sim/genetics.ts`](src/sim/genetics.ts).

Caste is **not** genetic — it's decided when a larva is about to mature,
based on the colony's current needs (more soldiers if it's been attacked
recently, otherwise mostly workers), matching how real ant colonies raise
their brood.

### Colony lifecycle
Eggs → larvae (consuming colony food to grow) → an adult worker, soldier,
drone, or alate (winged) queen. Once a colony is large and well-fed for long
enough, it produces a batch of drones and alate queens. They fly, an alate
queen either finds open ground and **founds a brand-new colony** (starting
solo, on her own fat reserves, exactly like a real founding queen) or is lost
trying; drones mate and then die. This is how the world grows from a
handful of starting colonies into a whole multi-colony ecosystem — see
[`src/sim/colony.ts`](src/sim/colony.ts) and the lifecycle handling in
[`src/sim/simulation.ts`](src/sim/simulation.ts).

### Death & the food web
Ants die from old age (a rising probability curve near their genetic
lifespan), starvation, combat, predation, drowning in a rain puddle, or —
rarely, in a storm — being crushed by wind-blown debris. Every death (ant,
predator) drops a **carcass**, which is just another food source other
colonies can forage — closing the loop between death and colony survival
instead of ants just vanishing.

### Predators & multi-colony warfare
Beetles, spiders, and (rarely) birds wander the map, hunt ants, and can be
killed by soldiers defending their colony (predators are healthy enough to
take a beating and retreat when hurt, per
[`src/sim/predator.ts`](src/sim/predator.ts)). Ants from rival colonies fight
on contact, biased by each ant's `aggression` gene and caste — soldiers
always stand their ground, workers may flee a losing fight.

### Weather & day/night
A ~2.5-minute day/night cycle slows ant activity at night; a simple weather
state machine cycles clear → overcast → rain → storm and back, with rain
filling puddles (a drowning hazard for anything that lingers) and speeding
up pheromone evaporation. See [`src/sim/weather.ts`](src/sim/weather.ts).

### World generation
The terrain is procedurally generated from layered value noise into
grass/dirt/sand/rock/leaf-litter biomes, scattered with obstacles (rocks,
twigs, leaves) ants steer around, and food sources (seeds, fruit, nectar,
plus carcasses from the dead) that regrow over time. See
[`src/sim/terrain.ts`](src/sim/terrain.ts) and [`src/sim/noise.ts`](src/sim/noise.ts).

### Surface vs. underground view
Toggle between the surface (the rendered terrain, ants, food, and weather)
and an underground cutaway that shows each colony's nursery (larvae),
storage (food reserves), and queen chamber as a stylized cross-section
diagram, positioned at each nest.

## Controls

- **Drag** to pan the camera, **scroll wheel / pinch** to zoom.
- A bottom tool bar switches what a click on the ground does: **Inspect**
  (click an ant or nest for its stats), **Place food**, **Spawn predator**,
  or **Found colony** (drop a rogue new colony wherever you click).
- The gear icon opens **Settings**: processing power tier, simulation speed
  (pause/1×/2×/5×/10×), and the surface/underground view toggle.
- Click a colony in the leaderboard panel to snap the camera to its nest.

## Architecture

```
src/
  sim/      the engine — pure TypeScript, no DOM/canvas dependency
  render/   the Canvas2D renderer — camera, terrain baking, entity drawing
  ui/       the HUD — plain DOM, no framework
main.ts     wires it together: boot, input handling, the render loop
```

The engine exposes a single facade, [`ISimulation`](src/sim/facade.ts), that
the renderer and UI both code against — neither ever reaches into `Ant`,
`Colony`, or `Terrain` internals directly. Each frame, `main.ts` calls
`sim.update(dt)` to advance a **fixed-timestep** simulation (decoupled from
render framerate via `PerformanceProfile.simSubsteps`), then pulls one
`WorldSnapshot` — a plain-data view of the whole world — and hands it to both
the renderer and the HUD.

## Tech stack

Vite + TypeScript, zero runtime UI framework, a hand-written Canvas2D
renderer (camera, baked terrain layer, procedurally leg-animated ants,
pheromone glow, weather particles, day/night lighting), and Vitest for unit
tests on the pure simulation logic. No backend — it's a static site.

## Roadmap / ideas not yet built

- A WebGL instanced-sprite renderer for even bigger Beast-tier populations
  than Canvas2D can comfortably push.
- Shareable seeds / save-and-load a running world.
- Procedural ambient sound (colony hum, rain, combat) via the Web Audio API.
- A simulated tunnel/pathfinding graph underground, instead of the current
  stylized cutaway diagram.
- Territory-aware colony AI (deliberate raids on weaker neighbors, rather
  than only incidental combat on contact).

## Contributing

Run `npm run typecheck` and `npm run test` before sending a PR — both are
fast and catch most regressions in the simulation logic.
