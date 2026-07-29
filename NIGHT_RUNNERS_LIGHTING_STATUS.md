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

## Round 3 — bank-conforming pools + warmer sodium (2026-07-21)

Reported: driving over the lit areas produced big elongated dark shapes on the
road (visible in noclip too), and a request for warmer lights.

Cause of the dark shapes: the ground pool is one big flat quad, but the deck is
banked/crowned. `_deckPoint` bank-corrects the anchor's *height*, yet the quad
was oriented by yaw only, so it lay dead flat and cut through the banked asphalt;
the half that dips below the surface is depth-occluded, reading as a large
elongated dark lozenge. The old 11×15.5 m pool was too small to show it; the new
large pool made it obvious.

Fix (`js/map.js`, lamppost loop):
- Tilt the pool (and streak) to lie PARALLEL to the banked deck — rotate by the
  bank angle about the road tangent (`premultiply(bankQuat)`) so the quad hugs
  the asphalt across its whole width instead of intersecting it.
- Raise the lift a touch (0.07 → 0.14 pool, 0.10 → 0.17 streak) for margin
  against longitudinal grade. Build-time only; no runtime cost, no new
  instances/materials/draw calls. Straight sections are unchanged (bank ≈ 0).
- Curves add only a *horizontal* overhang of the straight quad, which does not
  darken; the dark-shape artifact was purely the vertical bank mismatch.

Warmer lights (per request):
- Sodium pool tint `0xff9a45 → 0xff8a2e`, streak `0xffbe7a → 0xffa858`, and the
  emissive lamp lens `lampSodium 0xff9b42 → 0xff8a2e` — a deeper amber sodium
  glow. Player headlights stay warm-white (orange headlights read wrong).

Probe added: `.devtests/pool-artifact-probe.mjs` (low/skim/curve ground-level
shots to catch pool-vs-deck intersection artifacts).

### Round 3 correction — bank tilt sign

The first cut of the bank tilt rotated by `+bank`, which is the wrong direction:
it tilts the quad *against* the deck and doubles the cross-slope mismatch, so on
banked sections the pool still cut through the asphalt and left a hard diagonal
light/dark edge running down the road (reported in-game / noclip).

Derivation of the correct sign: `_deckPoint` raises height toward `+normal` by
`tan(bank)·lateral`, and with `horizontalNormal = (-Tz,0,Tx)` we have
`T × UP = +normal`, so the deck's upward normal is `UP·cos(bank) − N·sin(bank)`.
Rotating the quad about the tangent by angle φ gives normal `UP·cosφ + N·sinφ`,
which matches only at `φ = −bank`. Fixed to `-frame.bank`.

Verified with a same-spot A/B at the most-banked section (`.devtests/
pool-topdown-probe.mjs`, which scans `_bankAt` for the steepest lamp): `+bank`
compresses the pool to one side and darkens the other; `-bank` spreads it evenly
across the full carriageway with no hard edge, confirmed again at a driver's-eye
angle. Straights (bank ≈ 0) are unaffected either way.

## Round 4 — runtime-rig pop-in, under-deck Tatsumi, matte asphalt (2026-07-24)

Three reports: (1) lamps appear to "switch on" 10-20 m ahead of the car while
driving; (2) badly-distributed lighting with dark "shadow cuts" at merges,
Tatsumi PA and its ramps pitch-black; (3) the asphalt looks like glossy plastic.

Root causes found with headless probes (density sweep across wangan/C1/K1 +
same-spot before/after shots):

- **Pop-in** is the *runtime road-light rig* (`js/lighting-config.js`), a separate
  system from the additive pools — 4 real PointLights that snap to the nearest
  authored fixtures. Fixture density within a light's 36 m range is p50=3 but
  **p95=8, max=9** on the C1/K1 loops and ramp merges, so with only 4 slots the
  5th-9th in-range lamps had no light and popped on/off as slots reshuffled; on
  sparse straights the steep range-36/decay-1.8 cutoff still read as a hard
  switch-on right in front of the car.
- **Plastic asphalt** is mostly the user's own saved lighting: `hesi-world-build`
  sets `streetLampIntensity 2.45`, and `applySceneLighting` scaled the additive
  ground-pool opacity **1:1** with it → 0.28 × 2.45 = 0.69 additive opacity, a
  glossy orange wash on flat untextured Lambert.
- **Tatsumi dark** is structural: the deck sits ~8.9 m over the wangan and a
  standard 9.26 m lamppost can't fit under it, so the clearing suppresses every
  lamp/pool/light-source in its footprint — including the mainline passing below.

Changes (all index-safe — no `_instance` calls added/removed/reordered, verified
`editor-build-ops-probe` byte-identical: 118/123 on target, same 5 pre-existing
`chunk 6,-7` drifts as before):

`js/lighting-config.js`
- Runtime rig range `36 → 52`, keeping decay 1.8 / intensity 180 so the
  brightness *directly under* a lamp is unchanged — only the tail is longer.
- **Player-anchored proximity fade** (`FADE_FULL 18 m … FADE_ZERO 50 m`), applied
  every frame (the fixture *re-selection* stays distance-throttled, the fade does
  not). A slot only ever re-points near the selection edge where the fade is ~0,
  so the swap is invisible and the lamp then ramps up smoothly on approach.
- `applySceneLighting` pool/streak opacity now **compresses** above 1× lamp
  intensity (`1 + (I-1)·0.32`): 2.45 → 1.46, so 0.28 → 0.41 not 0.69. Lamp heads
  and the real road lights still take the full intensity, so lamps stay bright
  while the asphalt reads matte again.

`js/game.js`
- Rig light **count scales with quality** (low 4 / medium 6 / high 8) so dense
  stacks stay covered on capable hardware; fixed for the session (shader census).

`js/map.js`
- `_lightTatsumiUnderdeck()` (called from `_buildWorld` after service-area
  dressing): drops under-deck light **sources only** (~26 m spacing, hung below
  the deck soffit) along the wangan where it runs beneath the Tatsumi footprint.
  The runtime rig lights them like a PA's underside luminaires — road + deck
  soffit now read clearly instead of black. No geometry, so no instance indices
  move. Spacing keeps local fixture count (r36 ≈ 6) within the rig's slot budget.

Merge "shadow cuts" are only *partially* addressed: the wider-reach rig now
carries real light across route boundaries, but the additive pools still end per
route. A dedicated cross-route pool/gore fill is a possible follow-up.

Verified: game boots with no page errors; before/after driver + aerial shots on
the wangan straight (matte vs glossy), under Tatsumi (soffit + road lit vs black),
and density within the rig budget.

### Round 4b — traffic reads as lit + headlight toggle (2026-07-24)

Two follow-ups.

- **Traffic looked lit only by the player's headlights** (dark until you close on
  a car). The runtime rig follows the *player*, so distant traffic can't be lit
  by real lamps; the stand-in is the body's self-lit emissive floor. It was too
  low — raised `js/traffic.js makeTrafficMesh` `emissiveIntensity 0.34 → 0.6`
  (still emissive = the car's own colour, so the fleet keeps its identity; a
  material uniform, no light/program added). Cars now read at distance instead of
  switching on when the headlights arrive. Tunable if it glows too much.
- **Headlight toggle on `L`** (`game.js`). `KeyL` in driving → `toggleHeadlights()`
  drives the two player head SpotLights' **intensity to 0** (not `visible`): a
  light going invisible drops the scene's spot-light census and forces a full
  program re-link (stutter), whereas intensity is a uniform and keeps the
  prewarmed programs valid. State (`headlightsOn`) is re-applied in `createCarMesh`
  so it survives a vehicle refresh; base intensity is captured per light.
  Verified: 900 → 0 → 900 round-trip, headlight cone gone in-shot, no page errors.

### Round 4c — kill the "motion-sensor" fade + brighter fleet + rig micro-opt (2026-07-24)

Follow-up to 4/4b feedback: the Tatsumi exit ramp still had lamps that visibly
*brightened as you approached* ("sensore di movimento"), and traffic still read
dark far / lit near ("looks like it just spawned").

- **The ramp breathing was my own proximity fade.** `maxLitGap` along both PA
  ramps is only 8 m, so it was never a coverage hole — with `FADE_FULL 18` a lamp
  only reached full brightness within 18 m, so on the sparse ramp (lamps ~70 m
  apart, so usually 25-45 m away) it sat dim and swelling the whole approach.
  Widened to `FADE_FULL 36`, `FADE_ZERO 54`, range `52 → 56`: lamps are now
  CONSTANT (full) within 36 m — real streetlight behaviour, its only falloff the
  natural decay — and only the dim far tail past 36 m fades, which still hides the
  re-selection swap (that happens out near the selection edge). Verified: a
  fixture at 30 m now computes proximity 1.00 (was ~0.68).
- **Traffic: emissive floor `0.6 → 0.85`, kept the pure neon.** The whole fleet
  is one fluorescent green (`0x39ff14`, deliberate high-visibility fleet), so the
  fix is just a stronger self-lit floor: a far car is already clearly visible, so
  closing on it adds little and it no longer "switches on". A warm-tint blend was
  prototyped and **rejected** — it only muddied the signature neon and helped
  nothing, since there are no dark bodies in the fleet. One dial
  (`makeTrafficMesh emissiveIntensity`) if it glows too hot up close.
- **Rig micro-optimisation** (per the perf ask): the per-frame rig update no
  longer rebuilds each light's colour / temperature every frame — that now
  happens only on re-selection (throttled). The per-frame pass is scalar-only
  (`intensity = storedIntensity × proximityFade`). Light count unchanged
  (quality 4/6/8); real forward lights remain the main rig cost lever.

  Verified: boots clean (no page errors), headlight toggle still 900→0→900 after
  the refactor, fade numbers as above.

## Round 5 — static road lighting, unlimited traffic coverage (2026-07-24)

The moving runtime-light rig has been removed from the playable highway. It
could not satisfy coverage and performance at the same time: 4/6/8 PointLight
slots visibly changed fixture as the player moved, distant traffic necessarily
sat outside the player-centred pool, and every extra forward light ran inside
every affected material's fragment shader.

The replacement has a fixed cost:

- Lamp heads stay emissive and every authored lamp keeps its static additive
  asphalt pool. There is no player-distance fade and no light slot to reassign,
  so a lamp can no longer switch on while the car approaches.
- The saved highway look now keeps a nonzero hemisphere/ambient/directional
  fill (`ambient 0.72`, `direct 0.82`, master `0.9`) instead of tinting the
  global lights black. This reaches the full scene and all traffic at any
  distance without adding local lights.
- Procedural fallback traffic bodies use a small emissive floor in their own
  realistic paint colour (`0.18`). Modeler traffic keeps its authored,
  photographic materials untouched and relies on the static scene fill, so
  distant vehicles remain readable without a green cast or extra lights.
- Tatsumi under-deck coverage is 16 warm decals in one late-built
  `InstancedMesh`; it does not alter editor instance indices and adds one draw
  call only when visible.
- The always-present Tatsumi PointLight beacon is gone; its MeshBasic marker
  already supplies the visual cue.
- The player's two almost-overlapping SpotLights are represented by one wider
  cone. The visible pair of headlamp meshes remains unchanged, as does the `L`
  toggle.
- The game opts out of HighwayMap's duplicate fallback hemisphere/directional
  rig, leaving one authoritative global rig.

Verified in the real browser build at a mobile viewport:

- highway light census: `point 0`, `spot 1`, `directional 1`, `hemisphere 1`,
  `ambient 1`;
- 16 Tatsumi baked pools, no page errors;
- mobile probe: frame p50 `14.0 ms`, p95 `34.7 ms`, 43 active traffic vehicles;
- editor entity stability and lighting/model tests pass; editor build indices
  retain only the same five pre-existing Tatsumi marking drifts.

---

# Round 5 — light pools now sit ON the asphalt (2026-07-26)

Two user reports, one root cause:

1. *"passing over the lit areas the shadows deepen, the light seems to vanish,
   and there is a hard light/dark edge — an annoying line."*
2. *"going downhill the light does not follow the asphalt; trying to follow the
   profile it makes steps (gradoni) instead of tilting with the surface."*

There are no shadow maps in this game (`renderer.shadowMap.enabled = false`), so
the "shadow" was never a shadow. Each lamp's additive pool is a large flat quad
(up to `19 × 55 m`) laid on the deck. It was oriented with `yawQuaternion`, which
**flattens the tangent and throws the grade away**, plus a bank roll. On any
graded road the quad therefore stayed horizontal while the deck pitched beneath
it: one end sank under the asphalt and was depth-occluded, the other floated. A
plane cutting a plane meets along a *straight line* — which is exactly the hard
diagonal light/dark edge that was reported, and a run of such quads down a
descent reads as light "steps".

## Fix (all build-time; zero runtime cost)

- **`surfaceQuaternion(tangent)`** (js/map.js) builds the decal basis from the
  full 3D tangent, so a ground quad follows heading **and** grade. Used by the
  lamp pool and the wet-asphalt streak; `bankQuat` still applies the roll.
- **Per-lamp sag clearance.** A quad is a plane but the road also curves
  *vertically*; through a sag the plane's tips still bury themselves. Two extra
  curve samples per lamp measure the local sag and lift the decal just clear of
  it (capped at `0.4 m`). A soft additive glow floating a few centimetres reads
  as nothing; a hard black line reads as a bug.
- **`_deckPoint` now gets `route`/`distance` for the decals.** Without them the
  progressive-junction deck offset silently evaluated to `0`, so through a
  merge/diverge transition the decals were pinned to the unadjusted centreline
  while the asphalt had eased onto the host plane. Currently `0` everywhere a
  lamp lands, so no visual change today — correctness hardening only. The
  lamppost/lens instances deliberately keep their old positions so saved editor
  edits (addressed by index, verified by matrix) cannot move.
- **`anisotropy = 4`** on the shared `128 × 128` glow texture: these quads are
  stretched ~3:1 and almost always seen at a grazing angle, the case isotropic
  mipmapping handles worst. One small shared texture, negligible bandwidth.

## Verified

`node .devtests/pool-deck-fit-probe.mjs` (new, headless) samples a grid over all
4089 pools and reports how much of each is buried under the deck:

| buried by | before | after | reduction |
| --- | --- | --- | --- |
| any amount | 15287 samples (16.4%) | 2091 (2.2%) | 86% |
| > 25 cm | 6564 | 218 | 96.7% |
| > 50 cm | 3895 | 78 | 98.0% |
| > 1 m | 1608 | 29 | 98.2% |

Pools showing any hard edge: `59.0% → 22.3%`; what remains is overwhelmingly
under 10 cm, i.e. below the visible threshold for a soft additive glow.

- **No frame cost**: same scene, before vs after — draw calls `118 → 118`,
  triangles `109714 → 109714`. Orientation is baked into the instance matrix, so
  nothing new happens per frame. (The on-screen FPS readout moved *both* ways
  between runs — 128→113 at one spot, 138→141 at another — i.e. software
  rasteriser noise, not signal.)
- `node .devtests/editor-build-ops-probe.mjs`: `99/104` on target, the same five
  pre-existing Tatsumi drifts as before the change — no new index drift.
- Two full game boots, `page errors: none`.
- A/B screenshots on the steepest rescued ramps (`ramp_17 @ 378 m`, was buried
  `3.55 m`, now `0.03 m`): the near lane goes from dark-with-an-abrupt-bright-
  patch to a continuous warm ribbon flowing down the grade.

---

# Round 6 — the headlight brightness dial did nothing (2026-07-27)

**Report:** the player's headlights light the traffic ahead the same way no
matter what — lowering the brightness in the Car Modeler leaves the cars looking
"as if the light were powerful".

**It was not the traffic system.** Traffic bodies are ordinary Lambert surfaces
and they do receive the beam; the problem is exposure. The beam is a nearly
horizontal pencil (lamp ~0.6 m up, aimed at 0.1 m thirty metres out), so it
barely grazes the road but lands square on whatever is in the lane ahead. At the
authored 650 cd, with `decay 1.35` and a 31.75 m cutoff, a surface nine metres
ahead receives several times the night scene's white point — the fill is ~1.5.
It clips, and once it clips the dial only moves the part of the range that is
already off the top of the picture.

Measured on a car-rear stand-in nine metres up the lane (unlit it reads
64/255):

| beam | panel luma | what a 2× change buys |
| --- | --- | --- |
| 650 cd (authored) | 233.5 | 221.0 → 233.5 = **+5.4%** |
| 169 cd (calibrated) | 200.9 | 170.0 → 200.9 = **+15.4%** |

**Fix — two parts, both in `js/game.js`:**

1. `HEADLIGHT_BEAM_CALIBRATION = .26` scales the authored candela into the
   exposed range. The Modeler value is untouched on disk; the light gets
   `authored × calibration × multiplier`. The authored figure is now kept in
   `light.userData.authoredIntensity` and the effective value is computed in
   `_headlightBeamIntensity()` on every apply, so nothing is baked at attach
   time — the beam never has to be rebuilt to change brightness, which matters
   because re-creating a SpotLight mid-drive forces a shader relink.
2. A live **LUMINOSITÀ FARI** slider in the dev panel (`admin.headlightBrightness`,
   0…250%) to trim the result by eye. The road wash is the same light at a
   grazing angle, so it scales with the beam; this is the knob for putting it
   back where you want it.

Toggling headlights (`L`) still works by intensity, never `visible` — the light
census must not change.

Verified: `node .devtests/headlight-response-probe.mjs` → **8/8**, byte-identical
across three consecutive runs (traffic off, adaptive render scale pinned and
`timeScale` stopped, so only the beam changes between samples).

# Round 7 — the ground murk (the "nube", 2026-07-27)

**Asked for:** not just a dark floor. The reference frame has an *aura* rising
off the ground that swallows the first few metres of everything standing in it —
the blocks read as standing IN something, not on a black plate.

Distance fog cannot do that: it grades a fragment by how far it is, not by how
low it is. So `GROUND_MURK` (top of `js/map.js`) is a second, height-graded blend
to a near-black colour, patched into every lit world material:

    color: 0x02030a   bottom: -1 m   top: 26 m   strength: 0.92

`groundMurk()` in `_createMaterials` hooks `onBeforeCompile` and rebuilds the
world Y in the vertex shader (`instanceMatrix` first when `USE_INSTANCING` — most
of this geometry is instanced, so `modelMatrix` alone is the chunk's transform,
not the copy's), then mixes towards the murk colour **after** `<fog_fragment>`:
a surface deep in the nube stays swallowed however far away it is, instead of
being handed back by the haze. All the materials share one
`customProgramCacheKey`, so they still share programs. The facades are
`MeshBasicMaterial` and the mass is `MeshLambertMaterial` — the patch hooks the
chunks both have, so it works on either.

- The expressway decks sit at 30 m and up, so `top: 26` keeps the road, its
  lamps, the pools and the traffic entirely out of it. This is a city-floor
  effect, by construction.
- Light sources are exempt (`MURK_EXEMPT`) so a fixture that ever does sit down
  in it still burns through.
- **Deeper nube** → raise `top`. **Thicker** → raise `strength` (1 = the base of
  a building is pure murk). **A haze instead of a void** → lift `color`.

## What this replaced

Two earlier attempts at the same request are now redundant, and one is reverted:

1. **Terrain.** `materials.ground` keeps `fog: false` and its near-black colour.
   Measured then: against a pure-black ground the terrain's own lit colour was
   worth ~0.2 luma of ~14 — `FogExp2` was what lifted the land, because a black
   plate still comes back as the haze colour and the terrain is the one surface
   seen for kilometres.
2. **Tokyo Bay — reverted to its authored colour.** Tinting each material and
   re-shooting settled that the navy field along the Bayshore, and the whole
   ground plane at the K1, is the **water** plane and not the terrain (the
   buildings there stand in it). It lies at y≈0, so the murk swallows it at any
   camera height and any distance. Cutting its colour as well was a second dial
   doing the first one's job, so `water` is back to `0x121e2a` / `0x0b131c`:
   lower the murk strength and the sea comes back exactly as authored.
3. **The saved `ground` surface override.** A textured slot's tint *replaces* the
   generated colour (`applyWorldTextureOverrides`), so `brightness: 3` in
   `data/editor/custom-assets.json` was what put the lamp splash back on the
   land, and no colour in `js/map.js` could win against it. It was lowered to
   0.3, and the editor re-saved the document back to 3 an hour later — which no
   longer matters: at ground level the murk leaves 8 % of whatever that slot
   resolves to. The look is code-side now and survives an editor save.

Shots: `node .devtests/building-shots.mjs` → `.devtests/shots/buildings-murk2-*.png`
(c1-canyon and k1-works are the ones that carry it).

---

# Both kerbs, and the lamps the Tatsumi clearing ate (2026-07-29)

Two reports: the ramps around the Tatsumi PA (ramp_8 above all) had stretches
with no lampposts at all, and on the normal carriageways the lamps only ever
stood on **one** side of the road.

## What was actually happening

- **One kerb.** `_queueRouteDetails` alternated the lamp side only when
  `route.bidirectional` — and no route in this world is bidirectional, so every
  carriageway resolved to `side = 1` and lit a single edge for its whole length.
- **The Tatsumi hole, part 1.** The PA bay on `ramp_8` is a lay-by, so the drawn
  edge the pole rides swings ~10 m outward — straight onto the PA deck, where
  the clearing zero-scales anything standing in the footprint. The poles beside
  the PA were tombstoned.
- **The Tatsumi hole, part 2 (the big one).** `_instance` tested the clearing by
  padding the deck rectangle with **half the instance's longest axis, used as a
  radius**. A lamp's ground pool is a ~13 × 84 m ribbon, so that padding was
  42 m in every direction: every pool and streak within 42 m of the slab died,
  including the ones lying on ramp_8 twenty metres to the side that never touch
  the deck. That is what left ~200 m of the ramp pitch black.

## Changes (`js/map.js`)

- `_queueRouteLamps(route, mirror)` — the lamp walk lifted out of
  `_queueRouteDetails` verbatim, with `mirror` flipping it to the opposite kerb.
  `_decalSagClearance` came out with it (the tunnel dressing shares it).
- `_buildMirrorSideLamps()` — second row, run from `_buildWorld` **after every
  other instancing pass**, the same index discipline as `_buildInfill` and
  `_buildLaybyDressing`: it only appends to the instance buckets, so no index a
  saved editor edit addresses can move. Folding it into the first walk would
  have shifted roughly half the world's instanced indices.
- The mirror row's ground pool is `0.6 ×` width at `0.42 ×` brightness
  (`MIRROR_LAMP_POOL_WIDTH` / `MIRROR_LAMP_POOL_GAIN`). The first row's pool
  already reaches across the carriageway; two full-strength additive pools stack
  to clipped white. Together they land ~1.4 × the old peak — brighter, still
  sodium.
- `_lampHeadObstructed()` — the mirror row alone may skip a station where a deck
  passes overhead within the 9.26 m pole (the Wangan pair under the PA slab, or
  any flyover). The first row may move a pole but never drop one: its instance
  count is frozen by the editor saves that address it.
- `_tatsumiClearingBlocks()` replaces the radius test: the instance's oriented
  box is projected onto the deck's own axes, so a decal only dies when it
  genuinely reaches onto the slab. The cheap circle test still rejects the whole
  world first; only instances near the deck pay for the exact one.
- Lamp mounting retreats from the lay-by edge to the through-lane edge when the
  drawn edge would put the pole inside the clearing — the ramp_8 poles now stand
  on the ramp's own kerb instead of vanishing.

## Measured

`node .devtests/lamp-coverage-probe.mjs [--verbose]`

- 4177 lampposts on the first kerb, 4057 on the mirror kerb (a station is
  skipped where the pole would stand in another carriageway or under a deck).
- Routes with no lamps at all: four 86–160 m ramp stubs whose **both** kerbs sit
  inside a neighbouring carriageway. Correct — a pole there would be inside the
  road next door.
- Saved editor instance ops: 95 still on target, 4 drifted, 1 unresolved —
  **identical to the numbers before this change**; the drift predates it.
- Live instances standing inside the Tatsumi clearing: 0. The deck is still an
  empty slab.
- World build time and frame time unchanged within noise (the mirror pass is
  ~0.45 s of a ~13 s build; the additive pools measured ~1 % of frame time under
  software rasterization).

Shots: `node .devtests/lighting-probe.mjs <tag>` — the `ramp8-pa-approach` and
`ramp8-pa-bay` spots were added to frame the reported hole.
