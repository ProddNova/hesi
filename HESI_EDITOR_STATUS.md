# HESI Editor Status

Date: 2026-07-17

Branch: `kimi/hesi-world-editor-foundation`

Checkpoint: **1 of 5 — real map and navigation complete**

## Delivered at this checkpoint

- the default `/editor` URL generates the real HESI `HighwayMap`
- `?world=demo` is the only explicit demo mode; real-load fallback is prominent
- no gameplay, traffic, physics, audio, economy, garage, player, or game HUD
- measured 41.44 × 51.36 km world bounds, 1 unit/metre scale, OSM origin,
  exact inverse local projection, 66 runtime routes, 4 service areas, 26
  junctions, and 234 chunks
- metadata-derived Tatsumi PA and initial-spawn views plus map center and full
  world framing
- no-clip fly navigation with mouse look, horizontal/vertical movement,
  boost, wheel speed, three speed presets, and safe pointer-lock release
- fly/orbit switching without camera reset, camera-driven chunk streaming,
  loading/progress UI, visible mode/state, and deterministic cleanup
- unit/server/isolation tests and real in-app Chromium inspection

## Evidence

- `npm --prefix tools/hesi-editor test`: 5 unit + 3 server tests pass
- real browser DOM: `WORLD: REAL HESI WORLD`, 66 routes, 234 chunks, no warning
- real browser fly-mode interaction: `FLY · 45 M/S`
- screenshot: `tools/hesi-editor/test/smoke/artifacts/checkpoint-1-real-map-navigation.png`
- production `index.html` isolation assertion remains green

## Current limitations (next checkpoints)

- the real world is still one high-level registry entity
- semantic discovery, selection, editing, persistence, debug visualization, and
  asset placement are not part of checkpoint 1 and remain mandatory MVP work
- collision is known to be analytic runtime corridor/wall metadata; its editor
  visualizer arrives in checkpoint 5

## Exact next checkpoint

Checkpoint 2: deterministic semantic entity discovery, stable-ID repeatability,
searchable hierarchy, layer locking, viewport/hierarchy selection, highlight,
and detailed read-only inspector data.
