# Tatsumi No.1 PA — real-footprint deck, aerial-accurate lot, traffic ban

Checkpoint status: **the deck now sits on the real lot's OSM footprint and
carries the real aerial layout.** The previous checkpoint's 110 m deck with
two generic small-stall rows read as a random draft; this one re-fits the
deck to the real ~190 m strip centred on the committed OSM parking-polygon
centroid and rebuilds the dressing from the real Tatsumi No.1 PA plan and
its official inventory (29 small + 17 large + 1 disabled stalls, toilets +
vending only — 首都高速道路サービス). Traffic is provably unable to enter
the lot (see §4). The entry/exit connectors, garage, spawn and left-hand
traffic rules from the earlier checkpoints are kept, re-derived against the
longer deck.

## 1. Real-footprint deck (js/map.js `_defineTatsumiDeck` §4b)

`TARGET_LENGTH` 110 → 190 and the trim window is no longer centred on the
corridor's fit centre: it clamps around the station of `def.x/def.z`, which
IS the real OSM parking-polygon centroid extracted by tools/extract-osm.js
(3618.2, −4069.4 — extractPaCentroids, not the hand-set fallback). The
corridor between the ramps supports ~206 m; the fitted deck comes out
25.9 × 190.0 m at the real centre, matching the real strip's proportions.

## 2. Real cross-section and aerial layout (§8/§9 + `_buildTatsumiPaDressing`)

Cross-section, derived from the fitted width (`area.tatsumiPlan`, aisleV):

- **ramp_8 edge** — 17-stall large-vehicle DIAGONAL row (the aerial's
  signature comb): 45° nose-in stalls, ~10.5 m projected depth, box trucks
  at ~35 % occupancy (deterministic from the map seed).
- **single one-way aisle** (6.6 m) just past the deck axis — the aisle is no
  longer welded to the ramp side; both connectors, the gates, the spawn at
  u=0 and the painted arrows follow `aisleV` parametrically.
- **far edge** — 29 perpendicular small-car stalls (2.5 m pitch, backed-in
  meet look, ~50 % occupancy) behind a painted kerb-front line, plus ONE
  wider disabled stall (blue pad) right before the toilet walkway.

Longitudinally (entry → exit), following the aerial: entry gore with zebra
paint + PA/P signage + the garage ENTER ring (the real gore is stall-free,
so the ring displaces nothing and sits between the aisle edge and the stall
fronts); large diagonal row + small row amidships; zebra walkway → toilet
block (トイレ/TOILET, the PA's only building) → 5-machine vending row →
smoking corner past mid-lot on the far side; and painted wedge gores
tapering BOTH ends toward the gates the way the real wedge-shaped strip
does. Sodium poles stand on the stall kerb lines (2 ramp-side, 3 far-side).
No shop, no fuel — like the real PA. Props stay visual-only; lot collision
is still the flat slab. (The post-2020 anti-meet view fence and speed bumps
are deliberately NOT modeled — the game depicts the classic meet-era lot.)

## 3. Corridor/override hardening the longer deck exposed

- **Service-connector corridors end at the lot** (`_endIsOpen`): a service
  route whose terminus lands on a lot slab now counts as an OPEN end, so
  its corridor is dropped past the terminus (and no phantom end wall is
  applied there). Before, the exit's on-deck start was a CLOSED end whose
  corridor extended ~120 m backwards at deck height and captured samples of
  the entry's descent (0.75 m collision step in the flow probe).
- **Stale-override guard compares against the live connector**
  (`_syntheticOverrideIsStale`): the old rectangle test would now ACCEPT
  the pre-checkpoint editor overrides, because the grown deck encloses
  their old termini — landing a published lane across the stall rows. The
  guard now measures the override terminus against the runtime connector's
  own terminus (12 m / 1.5 m vertical), with the rectangle as fallback;
  both stale overrides in data/routes-smoothed.js are still skipped with
  the same console warning, and a legit editor republish (which traces the
  live lane) still applies.

## 4. Traffic cannot enter the lot

By construction (unchanged): both connectors are `traffic: false`, the
entry diverge carries probability 0, and no traffic lane references a
Tatsumi route. New enforcement in the flow probe §6: every traffic lane
polyline is sampled every 2 m and must never come inside the deck rectangle
plus a 1.5 m fence margin at deck height — the flanking ramps stay outside
the fence line, not just outside the slab (closest lane sample ≈ 5 m
beyond the fence on the live fit). Ramp/Wangan capture is separately
banned by the placement probe (§6) as before.

## Verification

- `.devtests/tatsumi-pa-flow-probe.mjs` — updated: deck length gate is now
  170–212 m (real strip), requires `rampSideSign`/`tatsumiPlan`, and adds
  the no-traffic-lane-inside-the-fence sweep. PASS.
- `.devtests/tatsumi-pa-placement-probe.mjs`, `.devtests/pa-access-probe.mjs`
  — PASS, unchanged.
- Progressive suite (`progressive-merge-probe/-handoff/-model/-drive`,
  `progressive-junction-classification`, `p4-diverge-continuity`) — PASS.
- Generic gates: road-surface, guardrail probe + audit, merge-marking,
  marking-orientation, ab-marking-clipping, lateral-junction, grip,
  traffic-test. PASS.
- `junction-finishing-probe` — FAIL(27), identical to the baseline
  (pre-existing mouth-local noise from the editor map edits).
- `e2e.mjs` — 39/41, `dev-map-test.mjs` — 30/31: identical scores and
  identical failures at the baseline (a 404'd resource logged as a console
  error, pre-existing).
- `performance.mjs` — on this machine: node map build median 8853 ms vs
  8958 ms at the baseline, frame p95 200 ms vs 217 ms — no regression (the
  4000 ms build gate fails on both sides, pre-existing).
- Screenshots (`.devtests/shots/`, gitignored): `FLOW-top-down` (camera
  raised to 320 m for the longer deck) and the dressing close-ups —
  `DRESS-lot-overview/stall-row/truck-row/toilets-vending/ring-forecourt/
  entry-signage/exit-signage` — via the two updated shot scripts.

## 2026-07 line/barrier refinements

- **Truck stall dividers no longer cross the aisle-edge line**: divider
  length now derives from the kerb-to-line depth (stops 0.35 m short)
  instead of the full truck depth (`_buildTatsumiPaDressing`). The line
  audit (`.devtests/tatsumi-pa-line-audit.mjs`, new) reports only the 4
  intentional arrow-head pairs as crossing segments.
- **Connector strips hug the parking**: the exit lane's on-deck leg now
  begins past the last furniture (u = L/2−49, the smoking corner) instead
  of mid-deck (u = 8), and the entry lane ends where the truck row starts
  (u = −L/2+14) instead of running to u = −8 — the two strips no longer
  overlap along the whole aisle (`_defineTatsumiDeck` §8).
- **Shutoko-style parapet** replaces the dark fence slab on every PA
  perimeter: concrete base wall + coping + twin steel-pipe rail on posts
  (`box:barrier`/`box:concrete`/`box:railMetal`), with the deck-end walls
  split around the aisle gate on decks whose connectors pass through the
  ends. The old `box:fence` perimeter slabs are gone (the editor build's
  fence-hide ops now simply no-op where the mesh no longer exists).
- New QA scripts: `.devtests/tatsumi-pa-topdown-shots.mjs` (PLAN-* close
  plan/barrier shots) and `.devtests/tatsumi-pa-line-audit.mjs`.
- Verification: tatsumi flow/placement/pa-access, guardrail, road-surface,
  merge-marking, marking-orientation, ab-marking-clipping, lateral-junction
  probes PASS; junction-finishing FAIL(27) and e2e 39/41 / dev-map 30/31
  identical to the pre-existing baseline.

## Remaining / debt

- The real lot is a wedge that tapers into the gores; the deck rectangle
  keeps full width and paints the taper instead (collision slab stays
  rectangular by design).
- The editor's published `tatsumi_pa_entry`/`tatsumi_pa_exit` overrides in
  `data/routes-smoothed.js` are still skipped as stale (console warning at
  load). They predate the `base` stamp (see below), so the stale guard still
  judges them by geometry alone. Re-edit and save either connector in the
  editor — the save is stamped and applies from then on — or adopt the saved
  shape as-is with `node tools/hesi-editor/stamp-road-overrides.mjs --write
  --publish`, or clear them, to silence the warnings.

## Amendment (26 Jul 2026): editor edits of the connectors now survive publish

`_syntheticOverrideIsStale` protects the lot from an override captured against
an older deck fit, but its only evidence was geometric: an override whose
terminus no longer sat on the generated curve was discarded. Reshaping a
connector in the world editor produces exactly that, so every Apply to Game
reverted the connector to the generated lane — the edit looked like it had
never been made.

Saved synthetic overrides now carry `base`, the generated polyline the edit was
drawn on top of (`route.generatedPoints`, stamped in `_registerRoute` for every
`synthetic` route). A matching base means the edit was authored against this
exact deck fit, so it is applied verbatim, endpoints included; a missing or
mismatched base falls through to the original heuristic unchanged. The stamp
travels through the editor draft, the publish merge and `meta.editorRoadOverrides`
(`tools/hesi-editor/src/overrides/road-route-schema.js`,
`route-persistence.js`, `road-edit-controller.js`). Covered by
`tools/hesi-editor/test/unit/synthetic-route-override.test.mjs`.
- The direct `wangan_0` exit anchor (`futureAnchors.wanganExit`) is still
  unbuilt (deliberate).
- Map build time and the junction-finishing/network-test failures inherited
  from the editor map edits are unchanged (pre-existing, see Verification).

## Amendment (23 Jul 2026): trucks + open lot edge, and the bay swell

Three requested tweaks, all visual-only (lot collision stays the flat slab):

- **Box-truck row parked empty.** The 17-stall diagonal large-vehicle row is
  still painted, but the truck bodies/cabs that filled it are removed for
  good — `_buildTatsumiPaDressing` now instances them at zero scale (this
  file's removal convention, cf. the `_buildDeadEnd` cushion tombstones). The
  rng draws and instance slots are kept: `random` is one stream shared by
  every service area, so dropping the draws would re-roll every parked car
  after it, and dropping the instances would shift the `parkedBody`/
  `parkedGlass` indices the editor's saved edits address. This also retires
  the user's editor hides on `prop:ramp-8:0086..0089` (the four cabs) —
  now permanent in the generator. Small-car row is untouched.
- **Open lot edge (no parapet).** The Shutoko parapet is skipped for the
  Tatsumi deck (`openEdged = area.dressing === 'tatsumi'`): the wall/coping/
  rail/posts instance at zero scale, kerb line stays. Same index-preservation
  reason as above.
- **Tokyo Bay reads as a night sea.** `_waterTexture()` builds a seamless
  256² greyscale swell tile (three sine lobes + sparse crest glints) that only
  darkens the dark-navy `water` material (`0x121e2a`, opaque now so it no
  longer sorts against the reflection streaks 0.12 m above it); the tile is
  ~220 m across the bay and drifts in `update()`. Deliberately understated —
  no bright blue. New QA: `.devtests/bay-water-shots.mjs` (BAY-* grazing/
  top-down/deck-edge).

Editor-address safety: `.devtests/editor-refs-snapshot.mjs` diffed byte-for-
byte identical across every instanced bucket and every discovered entity id
before/after (0 drift); `editor-build-ops-probe` still reports only the 4
pre-existing `chunk 6,-7 box:marking` drifts. The saved `Tokyo Bay` visibility
hide was dropped from `hesi-world-build.json`/`hesi-world-project.json` so the
bay shows.

---

## Interaction points — holographic disc (2026-07-27)

Every interaction anchor in the game now uses one marker, `js/hologram-marker.js`
(`createHologramMarker` / `animateHologramMarker` / `hologramBaseLift`), and the
crystal prism is gone. The disc is a squat cylinder of light with **no thickness
and no end caps** — the cylinder wall only, additive, brightest at its base and
fading upward via baked vertex colours, closed by a hairline ring at the top so
it keeps a silhouette at distance. It hovers (rise-only, so the base never sinks
through the floor), breathes and flickers.

**One wall, not two.** The first pass stood the glow layer off at 1.2× and made
the top ring 6% of the radius, and the marker read as two nested tubes. The glow
now hugs the sheet (1.015×, ~7 mm at the default size) and the ring is 2.8% —
the cut edge of the sheet rather than a rim. There is exactly one surface in the
silhouette; you see the far wall through the near one.

Why it replaced the gem: the prism floated and said *look here*; a disc standing
on the floor says *stand here*, which is what these anchors actually are.

Users:
- `GarageSystem` — exit (blue), market PC (yellow), bed (red, 0.84×).
- `TatsumiPaSystem` — the lot's exit marker (blue).
- `HighwayMap._buildZoneEntrances` — **new**: the PA gate forecourt gets a
  car-scale disc (3×) at the zone-entrance trigger, so the way in is a thing you
  aim at rather than a prompt that appears. It is a Group of additive meshes
  pushed through `_addChunkMesh` + `animatedMarkers` (`userData.hologramMarker`),
  never `_instance` — the bay is inside the Tatsumi clearing (hence
  `tatsumiClearingSurface`) where instances are zero-scaled, and added meshes
  cannot shift the (mesh, index) addresses saved editor edits use.

**`hologramBaseLift()` is compatibility, not styling.** The marker group's origin
is the anchor the world editor moves, and the markers the user has already moved
were dragged while the visual was the prism (centre 1.35 m up, half-height 0.44):
each was pulled DOWN until the gem's lowest point met the floor — that is why the
garage anchors sit at y ≈ −0.87 / −0.65 / −0.72. The disc's base therefore
inherits the prism's lowest point, and every saved placement keeps standing where
it was put instead of sinking a metre into the floor. Code-driven placements
(garage/PA defaults, the road gate) subtract the same lift so they touch the
ground.

QA: `node .devtests/hologram-marker-shots.mjs` → `HOLO-garage`, `HOLO-pa-gate`
(+ `-drone`, the only angle the bay walls do not block) and `HOLO-pa-lot`.
`tatsumi-pa-zone-probe` 10/10, `editor-build-ops-probe` unchanged at 96/101 on
target with the same 5 pre-existing drifts.

---

## Amendment (31 Jul 2026): the WALKABLE lot is built — `js/tatsumi-pa-lot.js`

`js/tatsumi-pa.js` had shipped as "deliberately EMPTY for now — asphalt, the
perimeter wall and the way back out". It is now the real PA, dressed from the
reference photography of 辰巳第一PA at the scale you walk it.

**The drivable deck is untouched and stays a bare paved clearing.** A first
pass put this layout out on the expressway deck instead; that was the wrong
scene and has been reverted — `js/map.js` carries no reference to this module.

### Layout (scene frame: X across, Z depth, +Z is the gate)

- **Back wall** — the service building (30 × 6 × 3.4) with a tiled dado; the
  backlit glass-block wall is a canvas texture of individual pressed-glass
  blocks in a steel surround, not a green panel with drawn-on mullions; the
  toilets with トイレ/TOILET; and a 7-machine vending bank whose fronts are
  textured with product rows and price strips, under a flat canopy with a white
  soffit and a lit fascia, plus the tall lit pylon at the corner.
- **Over the forecourt** — THE CANOPY, which is what the place is recognised
  by, at real proportions: 26 m along the frontage, 16 m of forecourt covered,
  crown ~10.5 m over a 5 m eave. It is an ARCH in section (a dome flattens it
  into a disc — that reads worse than the plain vault it replaced), with the
  arch amplitude TAPERED towards both ends so they sweep down to the eave line
  instead of being a cylinder cut off square, plus a rake towards the building
  and a sweep along the frontage so the rim is not planar. Glazing is one
  parametric surface over the (u, s) grid, vertex-coloured by how high the arch
  stands — bright across the crown, deep green at the eaves. On it: 9 ribs
  across, 6 purlins along, one alternating brace per bay (which is what gives
  the reference lozenges without a scribble of full diagonals), a bold white rim
  running both eaves and closing round the swept ends, two stayed columns in
  front of the building, and the flying strut with its knuckle off the
  cantilevered end.

  That 16 m depth is why `PA_LOT` went 64 × 44 → 80 × 56 and why the parked car
  moved to z = +2: squeezed into the old 9 m forecourt this arch reads as a lid,
  and the car sat under it.

- **Forecourt edge** — the kerb BOWS out into the parking and turns back at both
  ends (the reference kerb is a curve, and the lot is laid out around it), with
  the pipe railing following it, a break for the walkway and a zebra to the
  doors. The 二輪車 board is the white square with the motorcycle pictogram.
- **Parking** — parallel bays along the kerb (the middle one is the stall
  `TatsumiPaSystem` parks YOU in, at z = −3); the 45° large-vehicle comb with
  大型 painted in every bay and two box trucks on one side; the 小型 row with
  parked cars and one wide accessible bay on the other.
- **Gate** — concrete piers and a lintel framing the exit, positioned onto
  `exitPortal` at refresh time so it follows whatever the saved build pinned.
- **Lighting** — the saved build hides all four original sodium masts, so the
  lot brings its own: four cool-white masts with PointLights, a green wash
  under the shell, a warm one on the vending row. The masts are twin-headed
  like the reference. Every light is tagged `userData.gameSceneLight`.

`PA_LOT` grew 46 × 30 → 64 × 44: the building and its canopy alone are ~30 m
across and the comb needs depth to lean into. The deck plane and the perimeter
wall follow it for free; no saved op addresses either.

### Editor safety

Everything is APPENDED after every existing child, as named groups (`PA paint`,
`PA parking`, `PA building`, `PA vending`, `PA canopy`, `PA forecourt`,
`PA gate`, `PA lighting`). `data/editor/tatsumi-pa-build.json` hides children
5..10 (the four masts, the stall decal, the exit portal) and those indices are
unchanged. Solid pieces register on `staticColliders` individually; the
repeated flat/overhead pieces are InstancedMesh batches, which must NOT be
colliders — one AABB over a batch would wall the lot off.

Road TEXT is a canvas tile of stacked glyphs. The tile's top row lands on the
decal's local −Z, so every call passes the direction from the paint towards the
reader — that is what makes it read the right way up with the first character
farthest, the way road paint is actually laid.

### Verification

- `node .devtests/tatsumi-pa-lot-shots.mjs` — `PALOT-pa-spawn` (what you see
  getting out of the car), `-building`, `-comb`, `-small`, `-gate`, `-plan`.
  It also reports the group list, the collider count (33) and asserts the
  painted-glyph tiles carry ink (大型 7223 px, 小型 6630 px) rather than
  silently rendering blank.

### Known gaps

- The middle of the lot between the parking row and the gate is open asphalt.
- Seen from directly overhead the canopy reads as a filled green vault.
