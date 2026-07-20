# Custom-content optimization status (2026-07-20)

Scope: the scaling mechanism that keeps editor-made content (modeled objects,
imported textures, world texture overrides) affordable on weak GPUs as the map
grows. Motivation: the garage build alone (63 styled objects + 14 placed
customs + 37 imported images) was already creating GPU pressure that persisted
while driving, and the map is intended to grow with much more custom content.

## The four mechanisms

### 1. Texture size budget (js/custom-assets.js)

`textureFromSource` keeps the decoded source image on
`texture.userData.hesiSourceImage` and downscales it onto a canvas before GPU
upload whenever a budget is active. The game applies the budget per quality
profile in `resize()` (js/game.js):

| Quality | Cap (longest side) |
|---|---|
| low | 128 px |
| medium | 256 px |
| high | 512 px |

`setTextureSizeBudget()` re-processes every cached texture, so changing the
quality setting re-uploads existing textures at the new cap without a reload.
The editor never sets a budget and keeps authoring at full resolution — the
game imports `./custom-assets.js` with the same specifier (no `?v=` fork) so
both share one module instance and texture cache.

Player-imported images are unbounded by nature (the current set already
includes 1254×1254 and 2.6 MB PNGs); the budget makes their GPU cost a
constant of the quality profile instead of a property of the import. At
medium, worst-case editor texture VRAM drops from ~6.3 MB to ~0.35 MB each
(RGBA + mipmaps).

### 2. Garage VRAM release while driving (js/game.js)

The game boots into the garage, so every garage texture is uploaded on the
first frame and — because the garage scene is merely not rendered while
driving — previously stayed in VRAM for the whole drive. `exitGarage()` now
calls `releaseGarageTextures()`: it disposes the GPU copies of textures
referenced only by the garage scene (anything shared with the road scene is
kept). The JS-side images stay cached, and three.js re-uploads them
automatically on the next garage render, so re-entry just works.

### 3. Shared builds for repeated placements (js/custom-assets.js, js/editor-map-patch.js)

`buildPartObject`/`buildCustomAssetGroup` accept a `buildCache` (WeakMap keyed
by part definition). The game passes a persistent cache from
editor-map-patch.js, so N placements of one asset share a single geometry and
material set instead of building N copies. The custom-assets document is
fetched once per page load, making part objects stable cache keys. The editor
does not pass a cache (it mutates part definitions live and rebuilds).
`applyObjectFaceStyles` still clones materials per-mesh before styling, so
per-placement face overrides never leak into shared materials.

### 4. Chunk streaming for highway placements (js/map.js, js/editor-map-patch.js)

`HighwayMap.attachStreamedObject(object, position?)` parents an externally
built object into the streamed chunk containing its position.
`applyHighwayBuild` uses it for every `place`/`place-primitive`/`place-custom`
op, so placed objects pop in/out with the existing 1.5 km chunk-visibility
radius instead of rendering from any distance. Draw calls stay bounded no
matter how many objects the map accumulates. The garage scene (a single
interior) keeps the flat placed group.

## Evidence (2026-07-20, headless Chromium probes)

`node .devtests/custom-content-optimization-probe.mjs` — 13/13:

- 37 editor textures observed; 35 downscaled; none above the 256 px medium
  cap; switching quality to low re-capped all to 128 px live.
- Garage exit dropped renderer textures 33 → 14 while driving; re-entry
  re-uploaded to 35; a second exit dropped them again. No console errors.
- Repeated placements share geometries (2 placements / 1 geometry,
  3 placements / 1 geometry).
- Placement chunk visible near, hidden at 6 km, visible again on return
  (exercised synthetically via `attachStreamedObject`; see data note below).

`node .devtests/performance.mjs` on this container (slower than the reference
machine; both runs exceed the absolute limits tuned there, so compare
same-machine deltas): HEAD baseline vs this pass — draw calls 154 → 154,
visible triangles 37,518 → 37,518, renderer textures at the driving landmark
39 → 18, geometries 202 → 200, build times equal within run-to-run noise,
frame p50/p95 unchanged across repeat runs.

`node .devtests/e2e.mjs`: 41/41. `npm run editor:test`: 104/104.

## Data note (pre-existing, also on main)

`data/editor/hesi-world-build.json` contains two `place-custom` ops
("Macchinetta_primo_test", ×2) referencing `custom:0001`, an asset id that no
longer exists in `data/editor/custom-assets.json`. They are skipped at load
(`applied: 150, skipped: 2`) — those two vending machines silently never
appear on the highway. Re-placing them from a live asset in the editor will
re-emit valid ops.

## Truthful limitations

- The budget applies to editor-imported textures (everything routed through
  `textureFromSource`, including world road/wall overrides). Procedural map
  textures already have fixed small sizes and are untouched.
- Geometry/material sharing does not merge draw calls across placements; it
  bounds memory and build time. Chunk streaming is what bounds draw calls.
- A placed object larger than a chunk-visibility margin could pop at the
  radius edge, same as generated content.
- `releaseGarageTextures` runs on garage exit only; the road scene keeps its
  textures while in the garage (driving resumes immediately after exit, and
  re-upload stutter there would be worse than the small held allocation).
