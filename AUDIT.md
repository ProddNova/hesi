# Shutoko Nights — Map Rebuild Audit (Phase 0, 2026-07-11, second pass)

Audit performed before the Shutoko map rebuild / world dressing / traffic /
physics fix pass. Findings drive the work in this branch
(`claude/shutoko-map-physics-rebuild`). The older full-codebase audit from the
mobile-polish pass is preserved below.

## Map module (js/map.js — the rewrite target)

- Single `HighwayMap` class (~2,240 lines): six Catmull-Rom routes (`c1`,
  `wangan`, `yokohane`, `shinjuku`, `rainbow`, `bay_link`) in a generic layout
  that shares nothing with the real Shutoko beyond names. All geometry is
  built eagerly into one `THREE.Group`; no chunking/LOD (fog + far plane do
  all the hiding).
- **Junctions are just points where splines touch.** `_connectRoutes` records
  a point + radius; junction "platforms" are flat cylinders, and — critically —
  `getWallCollisionBounds` returns `disabled: !!junction`, i.e. **walls are
  turned off inside every junction radius**. That is both the "junction lanes
  cross each other" complaint (routes pass through each other at grade at
  similar Y) and an escape hatch through which a fast car can leave the world.
- Elevations are gently rolling (28–83 m) with no levels, no over/underpasses;
  "tunnels" are shells placed on top of the deck (the road never dips).
- Parking areas are floating box decks beside the road with a one-way access
  spline whose entry/exit only roughly touch the mainline; guardrail gates are
  authored per-PA with magic offsets (the "broken exits").
- Public API surface that game.js / traffic.js / ui.js consume (must be
  preserved by the rewrite): `sampleLane`, `getRoadInfo`, `getNearestRoute`,
  `advanceAlongRoute`, `advanceTraffic`, `getTrafficLanes/-Spawn`,
  `sampleTrafficLane`, `getAdjacent-/getNextTrafficLane`, `projectToTrafficLane`,
  `getServiceAreas/-Proximity`, `isPointDrivable`, `getGarageTransition`,
  `resolveWallCollision`, `sweepWallCollision`, `getWallSegments`,
  `getMinimapData`, `worldToMinimap`, `getNetworkStats`, `getInitialSpawn`,
  `update`, `dispose`, plus fields `initialSpawn`, `serviceAreas`, `routes`,
  `junctions`, `minimapData`, `trafficLanes`.

## Physics findings (js/physics.js — surgical fixes only)

1. **Low-speed slide at 60 km/h.** Steering authority is capped at the
   Ackermann angle for **1.15×** the grip-limited lateral acceleration
   (`gripLimitedSteer`, physics.js:541). Steering input is binary (keyboard /
   touch buttons), and the steer rate reaches that cap in ~50 ms. So *any*
   full press at *any* speed requests ~115 % of what the tires can do —
   fronts and then rears saturate instantly and the car "drifts" at 60 km/h.
   Fix: cap authority just *below* the grip limit (~0.92×) with the existing
   slip-angle allowance, and slow the ramp so breakaway is progressive.
2. **Tunneling through walls.** The frame-level sweep (game.js
   `resolveMapCollision` → `map.sweepWallCollision`, 2.5 m steps) is sound,
   but resolution can (a) hit a junction zone where bounds are `disabled`,
   (b) latch onto the *wrong deck* near crossings since `getNearestRoute` is
   3-D nearest with a soft ±8 m vertical window, or (c) find no route at all
   (`maxDistance` 90) once the first frame outside the corridor has passed.
   Fix comes with the new map: corridor-union bounds that are never disabled,
   elevation-aware route matching, plus per-substep CCD via a live adapter.
3. **Stuck inside guardrails.** `_resolveRoadBounds` (physics.js:790) clamps
   `info.lateralOffset` against `info.halfWidth` **every 1/120 s substep using
   the same stale roadInfo snapshot** taken before the frame moved the car. A
   0.5 m penetration report is therefore re-applied up to 8× per frame, each
   time shoving the car 0.5 m sideways along a stale `right` vector — the car
   gets rammed *through* or *pinned inside* the barrier. Fix: pass a live
   `getRoadInfo`/`sweep` adapter (already supported by `_readRoadSurface`) so
   every substep sees fresh geometry, and resolve penetration along the
   surface normal with an epsilon so contact always ends free.
4. Fixed timestep is verified OK: `update()` substeps at ≥120 Hz regardless
   of frame dt (50 ms clamp in game.js), and NaN/velocity guards recover to a
   safe pose. Post-impact yaw damping from the previous pass is retained.

## Traffic findings (js/traffic.js)

- **Indicators inverted.** `_considerLaneChange` sets `indicator = direction`
  (lane-index delta) and `_setLights` matches it to lamp meshes whose `side`
  is a local-X sign. Local +X on the traffic mesh is the car's **left** (the
  same right-handed-basis trap the steering audit found), while lane index
  increases toward the **outer/left** edge only for direction +1 travel — for
  direction −1 carriageways the world side flips but the lamp side does not.
  Net effect: blinker side disagrees with the actual move on half the network.
  Fix with an explicit lane-sign convention in the new map + a headless test
  asserting lamp world-side == lane-change world-side.
- Route-following itself is sound (lane sampling via the map adapter), but
  route transfers clamp lane index into the next route (3-lane → 1-lane ramp
  = up to ~7 m instant lateral teleport, visibly clipping the gore barrier).
  Needs a short lateral blend after every transfer.
- Density: default 30 cars (touch) at 0.78 density within an 850 m spawn
  radius across both carriageways — far too sparse for No Hesi. `setDensity`
  exists but is clamped to 2 and exposed nowhere. Admin slider (0.5×–3×)
  plus a higher default and a per-car draw-call diet (9 → ~5 meshes via
  vertex-color merges) are needed to hold iPhone frame rate at max density.

## Garage findings (js/garage.js)

- `build()` has several exactly-coplanar face pairs that z-fight: the ceiling
  beams at z=±14 share the z=−13.825/+13.825 plane with the wall faces; the
  shutter slats (z 13.535–13.805) intersect the shutter body face at 13.695;
  wall stripe faces sit 5 mm from panel faces which flicker at PSX precision;
  the back-wall/side-wall corners interpenetrate. Rebuild the shell with a
  consistent clearance constant while keeping every interaction point (PC at
  (7.5, −9.3), exit at (0, 12.6→13), car at origin, delivery zone at
  (−7.2, 10.3), walk clamp ±10.25/±13.1) byte-identical for the logic.

---

# Shutoko Nights — Codebase Audit & Fix Log (2026-07-11)

Full-codebase audit performed before any change (Phase 0), then fixed in
severity order (Phase 1), then regression-verified end-to-end (Phase 2) with
headless physics simulations (`.devtests/*.mjs`) and a Playwright run on an
iPhone-like touch viewport (`.devtests/e2e.mjs`, 25/25 checks).

Severity: 🟥 game-breaking · 🟧 major · 🟨 minor

## A. Input / touch

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| A1 | 🟥 | **Steering inverted for ALL input, not just touch.** The physics lateral basis `right = (cos h, 0, −sin h)` points to the *visual left* of the chase camera, so `steer:+1` (D key / ▶ button) yawed the car screen-left. Verified with a headless sim reproducing the camera math. | Flipped the input mapping in `getInput()` (left→+1, right→−1) — fixes keyboard and touch in one place — and flipped the front-wheel visual to match (`game.js`). |
| A2 | 🟥 | **`setPointerCapture` throws `NotFoundError`** when a pointer has already ended (surfaced by the e2e run). The uncaught throw aborted the whole press handler, silently dropping held buttons — the most likely cause of the "held buttons don't register" report. | All captures wrapped in try/catch (`game.js`, `ui.js`). Pointer-id tracking, per-button capture and multi-touch were already sound and are covered by an explicit multi-touch e2e check (GAS + steer held simultaneously). |
| A3 | 🟥 | Long-press triggered iOS text selection/callout; pinch/double-tap could zoom the page; `touch-action` is not inherited so phone/PC buttons were zoomable. | Global `-webkit-user-select:none`, `-webkit-touch-callout:none`, `touch-action:manipulation` on all interactive elements, `touch-action:none` on canvas/controls, `gesturestart/change/end`, `dblclick` and `contextmenu` preventDefault, non-passive `touchstart/move` preventDefault on canvas + controls, `body{position:fixed}` against rubber-banding. |
| A4 | 🟧 | Layout collisions: instrument cluster (translated −118px) sat inside the CAM/HB action cluster; utility buttons (PHONE/RESET) overlapped the BANK readout; portrait crushed the route chip under the lives bars; walk-pad had A on the top row. | Cluster moved to bottom-center (landscape) / floated above the pedal band (portrait); HUD top row inset in landscape, utility buttons stacked below the top row in portrait; toasts moved below the score; WASD diamond fixed; buttons enlarged (steer 76px, GAS 124px) with invisible −13px hit halos; verified by an automated bounding-box overlap audit in both orientations (0 overlaps). |
| A5 | 🟥 | Mobile players could not enter the garage: the interact (E) prompt had no touch button in driving mode (`.touch-interact` is garage-only; KeyE only existed as the shift-up "+" button). | `updateServices` flags `body.interact-available`; CSS surfaces the USE button above the steer cluster while the garage-entry prompt is up. |
| A6 | 🟨 | New CSS hit-halo rule (`.touch-controls button{position:relative}`) out-specified `.touch-interact{position:absolute}`, beaching the USE button at the top-left. | Selector bumped to `button.touch-interact` (caught by screenshot + computed-style check). |

## B. Physics

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| B1 | 🟥 | **Endless post-contact spin.** `resolveCollision()` injected a yaw impulse (clamped ±1.4 rad/s) on *every call*, and wall scrapes call it every frame from two paths (game sweep + physics lateral clamp), driving yawRate to 3.25 rad/s with only `exp(−0.14·dt)` damping — ~5 s of pirouette (measured). | Yaw kick now requires severity > 1.2 m/s and a 0.45 s per-contact cooldown, is computed from pre-response velocity, scaled down and clamped to ±1.6 total; a 0.9 s post-impact window raises yaw damping ~9×; base damping raised 0.14→0.32. Measured: angled 150 km/h wall hit settles in 0.5 s, no oscillation on release. |
| B2 | 🟥 | Any wall graze cost a life (default severity 4), so a scrape-spiral ended runs instantly. | Real impact speed into the barrier is now computed and passed through; scrapes (< 2.5 m/s into the wall) reset combo only, real hits still cost a life. |
| B3 | 🟧 | On/off touch steering at speed requested ~4.6 g of lateral acceleration → instant tire saturation and slides. | Grip-aware steering authority: lock is capped at the Ackermann angle for ~1.15× the grip-limited lateral acceleration (+ small slip allowance), on top of the existing speed-sensitive scale. Full lock preserved below ~30 km/h; sustained full lock at 160 km/h now yields a progressive, catchable drift (verified in sim). |
| B4 | 🟧 | No NaN/explosion guard: a bad frame could leak NaN into the renderer permanently. | Position/heading/velocity validated after every update; on NaN or > 900 km/h the car resets to the last known-good on-road pose. `reset()`/`setPosition()` now also clear steering, accel filters and impact timers so R always fully recovers. |
| B5 | 🟨 | `dt` clamp of 33 ms meant < 30 fps devices ran in slow motion. | Clamp raised to 50 ms (physics already substeps at a fixed ≥120 Hz internally, so behavior is framerate-independent; player-vs-traffic collision is swept, walls are swept at ≤5 m steps — no tunneling). |

## C. Graphics / performance

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| C1 | 🟧 | Internal resolution was a fixed 480px long side (~480×222 on a phone) — pixel mush. | Render quality Low/Medium/High as a fraction (0.32/0.5/0.72) of true device pixels, capped at 1.6 MP and DPR 3; default Medium (≈1266×585 on iPhone). Legacy numeric setting migrates automatically. `image-rendering:pixelated` only on Low; Medium/High upscale bilinearly. Settings UI updated. |
| C2 | 🟧 | **Stray polygons:** the PSX vertex-snap shader snapped vertices *at/behind the near plane* (`abs(w)` fallback), hurling triangles across the screen whenever road geometry crossed behind the camera; the fixed 210-unit grid also wobbled hard. | Snap skipped for `w ≤ 0.4`; grid is now a uniform tied to render height (×0.72), so the retro jitter stays subtle at any resolution. Near plane raised 0.08→0.3 for depth precision. |
| C3 | 🟧 | **Pop-in:** map fog density 0.000095 left geometry ~98.6% visible at the 1250 m far plane — decks/buildings blinked in and out. | Fog density raised to 0.00125 so geometry fades fully inside the far plane. |
| C4 | 🟧 | **Z-fighting:** junction platform tops protruded 15 mm *above* the crossing road decks. | Platforms lowered 80 mm below deck level. |
| C5 | 🟧 | Draw calls: 377 loose meshes in the map (gantry posts/beams, portal frames, PA guardrails each a separate Mesh + unique geometry) plus ~15 meshes per traffic car (≈450 for 30 cars). | Gantries, portals and guardrails moved into the existing InstancedMesh pipeline (377→220 map meshes, remainder mostly frustum-culled signs); traffic car boxes baked per-material into merged BufferGeometries without the addons dependency (15→8 meshes/car). Same visual output. |
| C6 | 🟨 | Two conflicting fog/background setups (game.js then map.js override). | Left as-is; map's values win deliberately (documented by C3 fix). |

## D. Phone UI

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| D1 | 🟧 | **Map app rendered black** until you had driven at least once (it replayed a cached HUD-minimap snapshot that only driving produced), and in the garage it rebuilt the app's innerHTML *every frame*. | Map app rewritten: draws live from `map.getMinimapData()` via a new `getMinimap` callback — routes, service areas, garage marker, player arrow — with drag-pan, pinch-zoom, double-tap zoom, follow-my-car recenter button and a 650 ms refresh. Per-frame rebuild hack removed. |
| D2 | 🟧 | Driving + browsing simultaneously impossible on touch. | World (physics, traffic, scoring, fuel) freezes while phone/PC is open on touch devices; desktop behavior unchanged. |
| D3 | 🟧 | Phone overflow risk from iOS dynamic viewport (100% vs browser chrome). | `100dvh` sizing, `position:fixed` body, safe-area insets kept; `visualViewport`/orientation resize listeners settle the canvas after rotation/chrome changes. Verified portrait + landscape via screenshots. |
| D4 | 🟨 | HUD minimap player arrow pointed 180° wrong (heading 0 = +Z = canvas-down, arrow drawn up). | Rotation corrected to `π − heading` (HUD minimap + phone map). |

## E. General robustness

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| E1 | 🟧 | Broke + out of fuel + tow refused = permanent soft-lock on the expressway. | Tow never refuses; it takes what money is available. Fuel-empty warning re-arms after refuel/fuel-can/tow. |
| E2 | 🟧 | Progress persisted only on explicit events (+0.4%/frame lottery for fuel); killing the tab lost recent state. | `persist()` on `pagehide` and on `visibilitychange→hidden`. |
| E3 | 🟨 | `mode='crashed'` fell through to the boot-screen camera orbit — camera teleported behind the run-over modal. | Boot orbit now only runs in boot mode; crash view keeps the last driving frame. |
| E4 | 🟨 | NEW GAME kept the previous run's score/lives. | Run state reset in `newGame()`. |
| E5 | 🟨 | Combo drain bar never moved (`comboTimerFraction` was never set). | Set each frame from the 4.5 s combo window. |
| E6 | 🟨 | Garage flavor text said "Tatsumi" but the garage lives at Shiba PA on the map. | Labels unified to Shiba PA. |
| E7 | 🟨 | Stale clients: SW cache + module query strings pinned old code. | Service-worker cache bumped to v4; all module URLs cache-busted (`?v=20260712a`). SW is already network-first, so updates propagate. |
| E8 | 🟨 | Audio on iOS requires a user gesture. | Already handled correctly (capture-phase pointerdown/touchstart/keydown unlock + resume, visibility suspend) — verified wiring, no change needed. |

## Deliberately NOT changed

- **Save system double-stack** (`game.js` runtime key + `save.js` SaveSystem with its own richer schema). Redundant but working, and both sides normalize defensively; consolidating it would be a rewrite with save-migration risk for zero player-visible gain.
- **Traffic AI adapter layer** (many duck-typed map-adapter fallbacks in `traffic.js`) — dead flexibility, but harmless and exercised by tests.
- **Desktop keyboard behavior, scoring economy, handling character** — steering fix changes *direction* only; weight transfer, slip and drift behavior retained (see B3 sim numbers).
- **Distance boards / signs** stay individual textured planes (unique canvas textures can't be instanced); they frustum-cull well.
- **CRT overlay + 31-level color posterization** — part of the look, kept as-is.

## Verification artifacts (`.devtests/`)

- `steer-test.mjs` — steering direction vs. camera basis
- `spin-test2.mjs` — impact settle, step-steer, release oscillation, low-speed lock
- `traffic-test.mjs` — 20 s traffic sim: spawns, advancement, near-miss events
- `map-stats.mjs` — mesh/instance counts, junction platform height
- `e2e.mjs` — 25-check Playwright regression on a touch viewport (boot → garage → phone/map → settings → drive → multi-touch steer → pause-on-phone → near-miss → bank → wall hit → recover → PC parts/auction → delivery → install → refuel → tow → save reload → layout overlap audit → console-error sweep)
- `portrait-shot.mjs` — portrait screenshot + overlap audit

Run with `npm i --no-save three@0.166.1 playwright` from the repo root.
