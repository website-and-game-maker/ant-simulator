# Art credits

**Everything drawn in Formicarium is original work, authored for this project.**
There are no third-party assets, no downloaded sprite sheets, and nothing here
carries an attribution requirement.

## Why there is no downloaded art

We went looking for genuinely public-domain (CC0) top-down ant art first, and
it does not exist in any usable form:

- **OpenGameArt** — the ant entries are licensed CC-BY or OGA-BY, which means
  shipping them puts an attribution obligation on anyone who forks this repo.
- **Kenney.nl** — the largest CC0 game-art catalogue there is, and it contains
  no insects at all.
- Most "free ant sprite" results elsewhere are side-on clip art, are scraped
  from commercial packs, or have no stated licence, which is worse than a
  restrictive one.

So the ants, predators and food in `src/render/sprites.ts`, and the ground,
stones, twigs and leaves in `src/render/terrainBaker.ts`, are drawn from
scratch with Canvas2D paths.

## Why vector paths rather than image files

Every ant is tinted with its colony's hue and its current task, so a fixed
bitmap would need a separate variant per colony anyway. Drawing with Canvas2D
primitives gives exactly what an SVG would (beziers, gradients, alpha) with no
async decode — `preloadSprites()` genuinely has nothing to wait for, and the
very first rendered frame is already correct.

Nothing is drawn from paths in the hot loop. Each combination of caste, hue,
task tint, gait frame and mip level is rasterised **once** into a small
offscreen canvas and blitted thereafter, so a frame with thousands of ants is
thousands of `drawImage` calls.

## Anatomy references

The ant proportions (gaster / mesosoma / head, the elbowed antennae, the
alternating-tripod gait, the head-to-body ratio that distinguishes a major
worker from a minor) follow standard myrmecological descriptions of
*Formicidae*. No reference image was traced.
