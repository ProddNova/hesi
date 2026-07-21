# Night-runners lighting pass (2026-07-21)

Scope: rework the highway night lighting toward a Night-Runners mood — a
continuous, soft, warm sodium wash along the road instead of a string of hard
"perfect circles" under each lamp — and stop distant traffic from visibly
popping in as the player approaches. Hard constraint: **no measurable frame
cost**. No new dynamic lights, draw calls, geometries or textures were added.

## Why it looked wrong before

- Each lamp dropped one small additive glow plane (`11 × 15.5 m`) on the
  asphalt. Lamps sit `42 m` apart, so the lit pools were isolated ~15 m circles
  separated by ~27 m of darkness — the road read as disconnected bright dots
  with big unlit gaps, exactly as reported.
- The pool sat at the pole base and barely reached the near lane, so the rest
  of the carriageway stayed dark.
- The pool texture had a hard-ish core, reinforcing the "perfect circle" look,
  and every lamp was identical, so the repetition was mechanical.
- Traffic: `frontSpawnDistance` was `340 m`. At the old fog density a car
  spawning 340 m ahead was ~75 % visible through the haze, so it appeared to
  "switch on" / spawn in view.

## Architectural constraint that shaped the fix

The scene uses **no per-lamp lights** on purpose: the renderer's light census is
baked into every shader program's cache key, so a light appearing/disappearing
with chunk streaming would re-link every visible program mid-drive (see
`HighwayMap._addChunkMesh` and `game.js prewarmGpuResources`). All lamp lighting
is therefore faked with additive instanced planes. This pass stays entirely
within that model — it only changes the **size, softness, placement and tint**
of the planes that already existed.

## Changes

`js/map.js`
- `_glowTexture()` — softer, higher-res radial (128² instead of 64²) with a long
  low-alpha tail. The gentle falloff is what lets neighbouring pools blend into
  one seamless ribbon with no visible pool boundary.
- `lightPool` / `lightStreak` materials — pool base colour is now white (per-lamp
  tint comes from instance colour); opacities retuned for the larger, overlapping
  planes so additive stacking in the overlaps does not blow out.
- Lamppost loop — each lamp now emits:
  - a **ground pool** whose length exceeds the lamp spacing (`≈ 1.2 × lampStep`)
    so consecutive pools overlap into a continuous warm ribbon; width reaches
    across the near lanes; the body is offset over the road toward the centreline
    instead of only lighting the pole base;
  - deterministic **per-lamp jitter** (length / width / lateral + longitudinal
    offset / a few degrees of yaw / brightness tint), hashed from the lamp's
    distance so it is stable across rebuilds but no two pools look identical;
  - a longer **wet-asphalt streak** that bridges the lamp spacing (Medium+; Low
    hides the streak and lets the pool carry continuity on its own).

`js/game.js`
- Fog nudged `0x07101c @ 0.0015` → `0x080f1e @ 0.0017` for a slightly hazier
  night-runners atmosphere that also softens the far horizon and helps mask
  spawns. The city skyline still reads clearly.

`js/traffic.js`
- `frontSpawnDistance` default `340 → 600 m`. New cars can no longer appear in
  view closer than the fog horizon, so they fade in gently as they are
  approached rather than popping/​"spawning" on screen. Traffic count, density
  and behaviour are otherwise unchanged.

## Performance verification

The change adds **no** draw calls, geometries, textures or lights — only the
fill (overdraw) of the existing instanced planes grows.

- `.devtests/pool-cost-probe.mjs` — noise-free in-session A/B (same frame, toggle
  the whole pool+streak layer on/off): the entire layer (365 instanced meshes in
  view) costs **+0.06 ms/frame** on headless SwiftShader CPU rasterisation, which
  over-counts overdraw relative to a real mobile GPU. Effectively free.
- `.devtests/landmarks.mjs` — draw calls **111 / 117** (1× / 3× traffic, ceiling
  175), visible triangles ~35 k (ceiling 70 k), textures/geometries unchanged,
  no page errors.
- `.devtests/performance.mjs` — draw calls, triangle counts and texture counts
  match the pre-change baseline measured on the same machine; the absolute
  build-time / frame-p95 limits in that probe are calibrated for a faster
  reference box and are exceeded by the *baseline* here too, so they are not a
  valid regression signal on this runner. p95 frame time was identical
  (199.9 vs 200.1 ms) between baseline and this change.

## Repeatable probes added

- `.devtests/lighting-probe.mjs [tag]` — driver-view before/after shots on three
  lamp-lit sections.
- `.devtests/aerial-probe.mjs [tag]` — elevated drone shots down a straight, so
  pool-to-pool overlap and coverage are actually visible.
- `.devtests/pool-cost-probe.mjs` — isolates the pool layer's marginal render
  cost with an in-session visibility toggle.

Real-device iPhone validation remains a manual release check; SwiftShader timing
is useful for regression comparison, not as a proxy for iPhone GPU behaviour.

## Round 2 — warm palette + traffic visibility (2026-07-21)

Follow-up from reference footage (osoi.dev): the night was too cold and blue,
there were still black "no-light" zones, and — most reported — distant traffic
cars were pure-black silhouettes that only "switched on" (showed their colour)
once the player's headlights reached them.

Root cause of the traffic issue: the only moving lights in the scene are the
**player's two head SpotLights** (`game.js createCarMesh`, ~58 m range). Traffic
bodies are plain Lambert with no emissive, so beyond that cone they were lit only
by a cold, low ambient and fell to black. More dynamic lights are not an option —
the renderer bakes the light count into every shader program's cache key (see
`prewarmGpuResources`), and extra forward lights also cost per-fragment across the
whole scene. So all of Round 2 is **recolouring existing lights + one material
property**: no new lights, draw calls, programs or textures (verified: draw calls
111/117, textures/geometries unchanged, no errors).

Changes:
- `js/traffic.js` — the traffic body Lambert now carries a self-lit floor
  (`emissive = its own colour`, `emissiveIntensity 0.34`), set per vehicle in
  `_applyVehicleType`. The fluorescent fleet now reads its colour at any
  distance; closing on a car no longer looks like it just spawned/switched on.
  Emissive is a standard Lambert uniform, so no new shader program.
- `js/game.js setupLights` — shifted the night from cold blue to a warm sodium
  haze and lifted the floor just enough to kill the pure-black zones while
  keeping the mood dark: hemisphere `0x35476b/0x0c101c @1.35 → 0x564a40/0x1e1510
  @1.58`, ambient `0x3c4a66 @0.5 → 0x64524a @0.66`, fog `→ 0x16110d`, background
  `→ 0x080605`. The moon stays a slightly-cooled rim (`0x9aa6c4 @0.72`) for
  colour contrast. Additive lamp pools and emissive windows still carry the scene.
- `js/game.js createCarMesh` — player head SpotLight intensity `1350 → 900` so
  the car stops being the scene's dominant light source; with the lifted warm
  ambient the road ahead still reads clearly.

Probe added: `.devtests/traffic-visibility-probe.mjs` (populates cars ahead at a
readable range to check distant-car colour).
