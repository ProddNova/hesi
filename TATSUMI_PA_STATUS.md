# Tatsumi No.1 PA — live garage, ramp_8 exit, left-hand traffic

Checkpoint status: **the deck is the live player location.** The elevated
deck between ramp_8 and ramp_9 (placed by the previous checkpoint, see the
history below) now owns the active garage and every spawn flow, has a built
player exit onto `ramp_8`, and the whole network runs Japanese left-hand
traffic. Lane dashes are shorter and denser network-wide.

## 1. Left-hand traffic (`reverseNetworkData`, js/map.js)

The OSM ways are digitised along the real (left-hand) travel direction, but
the lon→x / lat→z projection renders a mirror image of Tokyo, so driving the
data forward *looked* like right-hand traffic — the opposing carriageway sat
on the driver's left everywhere. `reverseNetworkData` reverses every
carriageway polyline (rebasing edges, tunnel/bridge ranges and PA side labels
onto the flipped chainage) at load time; `ROUTE_DATA` itself is never
mutated and `options.legacyFlow === true` builds the original flow for
probes. Verified around Tatsumi (tatsumi-pa-flow-probe):

- opposing carriageway on the driver's **right** along the Wangan pair;
- every traffic lane runs direction +1 and lane sampling faces the tangent;
- `ramp_8` (reversed) descends from Route 9 past the deck and **merges into
  `wangan_0`** with >20 km of Bayshore mainline ahead — the PA exit joins it
  upstream of that merge;
- `wangan_1` (the opposite direction) terminates in the Tatsumi turnaround
  (`wangan_uturn_0`) back onto `wangan_0`.

**Progressive prototypes are legacy-flow-bound.** Reversal flips both
junction senses (P1 diverge→merge, P2 merge→diverge) and the transition
builder cannot reproduce the engineered treatments in the flipped sense
(missing lane mappings, marking targets missed, a 144 m A-B suppression
error at J2). The prototypes file is untouched from main; `js/map.js` simply
passes an empty prototype list unless `options.legacyFlow` is set. The live
network uses the standard junction treatment at J2/J48 (all generic gates
pass there), the live dev map shows no prototype pins (DEV_MAP.md), and the
whole progressive probe suite now constructs `legacyFlow` maps — including
the re-recorded P1 geometry digest, which was already stale on the
pre-continuation baseline (every hashed field is byte-identical to 34909c3).

## 2. Garage + spawn on the deck

- `_defineTatsumiDeck` section 9 marks the deck `hasGarage`, fits a
  20 × 9.4 × 26 shell at the south-west end (shutter facing the parking
  rows along the deck axis — `area.garageShell`, consumed by a
  parameterised `_buildGarageExterior`), and puts the ENTER trigger on the
  aisle 8 m in front of the shutter. `_defineServiceAreas` then clears every
  other lot's garage flag (single active garage); the `paAccessLanes:true`
  twin never activates the deck garage, so Shibaura keeps it there.
- `initialSpawn` (used by boot, garage exit, tow and crash recovery alike —
  `game.js placeAtSpawn`) sits on the aisle at deck u=−39, v=−3.2, facing
  the exit end, 0.65 m above the lot collision, outside the ENTER radius,
  clear of the parked rows / lamp line / shell (probe-asserted).
- `area.dressingKeepouts` clears stalls, parked cars and lamps out of the
  shell zone and out of an exit-side swathe from just before the spawn
  through the fence opening, so the departure never threads between props.

## 3. ramp_8 player exit

`tatsumi_pa_exit` (service, 1 lane, traffic:false) leaves the parking rows,
crosses the deck edge through a fence/kerb opening (split runs + end posts,
`area.fenceOpenings`), descends an apron and glues onto ramp_8's deck-facing
edge with a standard merge edge (zone J56 machinery: deck blending, host
guardrail opening 651–754, dashed boundary). The vertical profile holds deck
height until the lane clears the kerb line, then tracks the **banked ramp
deck plane** at each point's own lateral (`rampYAt` via `_frameAt` +
`_deckPoint`) so the collision hand-off is step-free — the interrupted
session's flat apron left a 0.9 m ledge beside the lane and a 0.33 m step
under it. Measured now: worst collision step 0.093 m per 0.5 m station
across the centreline and both wheel tracks (continuous ~10 % crest, 0.038 m
at 0.25 m sampling), zero undrivable stations, no wall/rail crossing.

## 4. Dashed markings

Centralised in js/map.js: `LANE_DASH_LENGTH 3.0` / `LANE_DASH_PERIOD 8`
(route dashes, was 6.2/15), `SERVICE_DASH_PERIOD 14` (was 26),
`ZONE_DASH_LENGTH 3.0` / `ZONE_DASH_PERIOD 6` (junction-zone broken lines,
was 5/10). The progressive-transition divider reuses the same constants so
its phase mapping stays 1:1. No boundary types, junction suppression or
ownership changed (`road-surface`, `ab-marking-clipping`, `merge-marking`,
`marking-orientation` probes all pass). Before/after:
`.devtests/shots/FLOW-markings-chase-before.png` vs `FLOW-markings-chase.png`.

## Verification

- `.devtests/tatsumi-pa-flow-probe.mjs` — NEW: garage/spawn/exit/mouth/
  grade-separation/left-hand-traffic/nothing-else-enabled. PASS.
- `.devtests/tatsumi-pa-placement-probe.mjs` — updated to the live-garage
  state (exactly one service route/edge allowed; twin reversibility kept). PASS.
- `.devtests/pa-access-probe.mjs` — updated: deck garage instead of the
  Shibaura shoulder trigger; twin still restores all 4 legacy lanes. PASS.
- Progressive suite (`progressive-merge-probe/-handoff/-model/-drive`,
  `progressive-junction-classification`, `p4-diverge-continuity`) — all on
  `legacyFlow` maps. PASS (model digest re-recorded, see §1).
- Generic gates: road-surface, guardrail probe + audit, merge-marking,
  marking-orientation, ab-marking-clipping, lateral-junction, grip. PASS.
- `network-test.mjs` — same two pre-existing failures as the baseline
  (stale total-km expectation; stale legacy route ids crash the tail).
- `junction-finishing-probe` — FAIL(6) both here and at baseline (pre-existing
  mouth-local noise at unrelated r6/ramp junctions).
- `e2e.mjs` — 41/41 (boot → garage exit spawn on the deck → drive, recover,
  tow, save/reload, no console errors). `dev-map-test.mjs` — 31/31 (no
  prototype pins under live flow). `performance.mjs` — map build over its
  4000 ms limit like the baseline (7.3 s vs 6.1 s; frame p95 improved
  166.7 → 150.1 ms).
- Screenshots (`.devtests/shots/`, gitignored): `FLOW-top-down`,
  `FLOW-spawn-chase`, `FLOW-exit-inside`, `FLOW-exit-from-ramp`,
  `FLOW-side-elevation`, `FLOW-markings-chase(-before)`,
  `FLOW-traffic-directions` — via `.devtests/tatsumi-pa-flow-shots.mjs`.

## Remaining / debt

- The deck→ramp apron crest is briefly ~10 % — continuous and drivable, but
  a longer diagonal would read softer.
- game.js debug capture views (`p2-*`, `auxiliary`) reference legacy-flow
  transitions/chainages; they no-op safely under live flow.
- The direct `wangan_0` exit anchor (`futureAnchors.wanganExit`) is still
  unbuilt (deliberate).
- Map build time regressed ~1.2 s from the load-time reversal clone; the
  4000 ms performance gate was already failing before it.

## History

The elevated-deck placement checkpoint (corridor discovery, axis fit,
rectangle search, elevation, `_pushServiceArea` registration, pillar
offsets in the median gap) is documented in the git history of this file
(`34909c3` and earlier) and remains accurate for `_defineTatsumiDeck`
sections 1–7.
