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

## Remaining / debt

- The real lot is a wedge that tapers into the gores; the deck rectangle
  keeps full width and paints the taper instead (collision slab stays
  rectangular by design).
- The editor's published `tatsumi_pa_entry`/`tatsumi_pa_exit` overrides in
  `data/routes-smoothed.js` are still skipped as stale (console warning at
  load). Republish from the editor against the live deck — or clear them —
  to silence the warnings.
- The direct `wangan_0` exit anchor (`futureAnchors.wanganExit`) is still
  unbuilt (deliberate).
- Map build time and the junction-finishing/network-test failures inherited
  from the editor map edits are unchanged (pre-existing, see Verification).
