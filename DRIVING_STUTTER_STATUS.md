# Driving stutter / freeze fix status (2026-07-20)

Scope: the frequent micro-stutters and occasional multi-hundred-ms freezes
while driving (frame-time spikes up to ~292 ms in user logs while average FPS
stayed 80–110), which could make the car swerve. RAM was not the issue; the
spikes correlated with chunks / geometries / textures / traffic / route
content changing mid-drive.

## Confirmed causes (measured, not guessed)

Measured with the new `.devtests/driving-stutter-probe.mjs`: it drives the
real game with a lane-following autopilot for 75 s in Chromium and attributes
every frame to physics / traffic / map streaming / render, while tracking
`renderer.info` resource-count deltas per frame.

1. **Lazy GPU resource creation during driving (primary).** The map is fully
   built at boot but chunks are only *visibility-toggled* while driving.
   three.js creates GPU resources the first time an object is actually
   rendered, so first-time chunk visibility uploaded multi-MB merged vertex
   buffers, traffic vehicles uploaded their merged geometries on first
   display (3 buffers per car), imported textures uploaded mid-drive, and at
   least one shader program compiled mid-drive. Baseline probe: **120
   geometry uploads, 2 texture uploads and 1 program link during 75 s of
   driving**. On real drivers (the reported RTX 5050 laptop) buffer/texture
   uploads and above all program links are exactly the class of driver stalls
   that produce 100–300 ms frames.
2. **Full-network route scan while off every corridor.** When the car left
   every road corridor (junction gaps, deep run-offs), the deep-escape branch
   of `resolveWallCollision` called `getNearestRoute(maxDistance: Infinity)`
   — an unseeded projection against every sample of every route — once per
   sweep step per physics substep (a dozen+ calls in one frame). Observed as
   an **87 ms** single-frame physics stall in the baseline probe. This is the
   "freeze that makes the car swerve": it fires exactly when the car is
   somewhere unusual.
3. **Synchronous save while driving.** `syncFuelFromPhysics` called
   `persist()` with probability 0.004/frame (≈ every 2.3 s at 110 fps): two
   JSON serializations + two `localStorage` writes on the main thread inside
   a driving frame.
4. **Steady allocation churn (GC pressure).** ~23 MB collected per ~25 s in
   the probe: fresh road-info objects (with vector clones) 2–3× per frame
   for physics substeps plus a spread copy per call in the road adapter, a
   ~6-vector player normalization per traffic update, and unbounded
   traffic density-cull scans.
5. **Late shader-program variants.** The traffic brake-lamp material is
   created lazily on first braking and never went through
   `applyRetroMaterials` (which sets `dithering` on every scene material),
   so its program cache key could never hit the tail-lamp's program — the
   first braking car near the player compiled a shader mid-drive.

## Fixes

### GPU prewarm at boot (js/game.js `prewarmGpuResources`)

After the editor builds land, one render of the road scene runs with every
object visible and frustum culling off. Every draw call executes, uploading
all vertex buffers and textures and compiling all shader programs, then
visibility/culling flags are restored exactly. Two subtleties:

- It renders **to the canvas**, not an offscreen target: three.js hardcodes
  linear output color space for non-XR render targets, and output color
  space is part of the program cache key — an offscreen prewarm compiles
  throwaway variants and leaves the real sRGB compiles to happen mid-drive
  anyway (verified with `.devtests/diag/find-late-program.mjs`; the linear
  duplicates also disappeared: 41 → 25 live programs at drive start).
- The frame is harmless: the normal boot view with distant chunks also
  visible, behind the boot overlay.

Chunk streaming behaviour is unchanged — chunks still pop in/out on the same
radius; making one visible now costs nothing GPU-side because everything is
resident. No visual quality was reduced anywhere.

### Deep-escape memo (js/map.js `resolveWallCollision`)

The nearest-route snap target barely moves between probe points centimetres
apart, so it is memoized while the query stays within 2 m of the cached
position. One full scan per escape episode instead of a dozen per frame.

### Save cadence (js/game.js `syncFuelFromPhysics`)

Fuel now persists on a fixed 10 s cadence instead of randomly every ~2.3 s.
Fuel is also persisted on tab hide, garage entry and every menu transaction,
so nothing is lost. `persist()` is timed into the frame profiler (`save`
column) so any future save stall names itself in the log.

### Allocation trims (js/game.js, js/traffic.js)

- The road adapter annotates the (per-call, fresh) road-info object in place
  instead of spread-copying it per physics substep.
- Traffic reuses a scratch player object (`copyVector3` helper) instead of
  allocating ~6 vectors per frame; events already clone anything they keep.
- Traffic density culling is bounded to 3 despawns/frame (was: entire
  surplus in one frame with an O(n) scan per removal).
- The game passes its already-computed `roadInfo` into `traffic.update`, so
  spawn attempts skip a redundant `map.getRoadInfo` call.

### Brake-lamp program reuse (js/traffic.js `_brakeMaterial`)

The lazily created brake material copies the tail-lamp's `dithering`/`fog`
flags, so it resolves to the already-compiled program.

## Diagnostics added (see DEBUG_STATS.md)

- Per-frame subsystem profiler in the game loop
  (`phys/traffic/map/render/save/other`).
- Stats overlay (`I`) shows a `SPIKE` line: the last frame > 40 ms with its
  breakdown.
- Stats log (`P`) rows gained `max_*` columns (the worst frame in each
  window, broken down by subsystem) and `d_geometries/d_textures/d_programs`
  (resource uploads/compiles in the window). A long frame in a recording now
  names its cause on the same row.
- `.devtests/driving-stutter-probe.mjs` — repeatable 75 s autopilot drive
  with spike attribution; writes `.devtests/diag/stutter-<label>.json`.
- `.devtests/diag/find-late-program.mjs` — diffs live shader programs across
  a drive to catch anything that still compiles late.

## Before / after (same container, headless Chromium, 75 s autopilot drive)

|                              | before   | after |
|------------------------------|----------|-------|
| mid-drive geometry uploads   | 120      | **0** |
| mid-drive texture uploads    | 2        | **0** |
| mid-drive shader compiles    | 1        | **0** |
| frame p50 / p95 / p99 (ms)   | 9.1 / 14.8 / 31.5 | 8.6 / 11.4 / 13.1 |
| worst frame (ms)             | 72.5     | 25.2  |
| frames > 25 ms               | 11       | 1     |
| frames > 50 ms               | 2        | 0     |

(SwiftShader hides real-driver upload/link cost, so on the reported RTX 5050
laptop the before/after gap for the eliminated uploads is expected to be much
larger than these CPU-side numbers — driver stalls of tens to hundreds of ms
per upload burst simply no longer have a trigger. Full logs:
`.devtests/diag/stutter-before.json`, `stutter-final.json`.)

## Regression evidence (this container, 2026-07-20)

- `node .devtests/e2e.mjs` — 41/41
- `node .devtests/debug-stats-test.mjs` — 19/19
- `node .devtests/custom-content-optimization-probe.mjs` — 13/13
- `npm run editor:test` — 104/104
- `node .devtests/traffic-test.mjs` — ALL OK; `grip-test.mjs` — pass
- `node .devtests/progressive-merge-drive.mjs` — PASS (exercises the
  modified collision fallback against every progressive lane)
- `node .devtests/performance.mjs` vs a clean HEAD checkout on the same
  container: frame p50/p95 identical (133.4 / ~166.6 ms — container speed,
  both runs), draw calls 155→154, triangles unchanged, map build within
  noise. Intended delta only: resident geometries 201→3406 and textures
  18→181 at the driving landmark (that is the prewarm).

## Truthful limitations

- All GPU resources are now resident from boot, so VRAM holds the whole
  map's buffers/textures up-front (order tens of MB at current content;
  bounded by the existing texture-size budget and stored-triangle limit).
  This is the standard trade for stutter-free streaming and is nothing for
  the target hardware, but a future very-low-memory profile could skip the
  prewarm.
- Entering the garage still uploads garage-only textures (deliberate:
  `releaseGarageTextures` frees them for driving; the cost sits behind the
  garage fade, not in a driving frame).
- The remaining worst frame (~25 ms in the probe) is physics + road-info on
  a busy frame, not resource creation; further gains would come from
  slimming `getRoadInfo`'s returned object, which is a wide API touched by
  physics, traffic, HUD and probes — deliberately not risked here.
- Buying a different car mid-session builds its mesh in the garage; its
  first road render happens under the exit fade, so it was left out of the
  prewarm.
