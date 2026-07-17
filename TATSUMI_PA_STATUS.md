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

## 2. Compact empty deck, garage + spawn (refined 2026-07-17)

The fitted rectangle is trimmed to a fixed 110 m around its centre
(re-fitted, so the shorter window keeps the extra width its own pinches
allow — now 27.5 m wide) and the lot is deliberately BARE
(`area.dressingMinimal`): no stalls, parked cars, konbini, vending, lamps,
signs or refuel/PA markers — only the slab, the support pillars in the
Wangan median gap, the unbroken perimeter kerb/fence, the end rails on the
outward halves, and the pulsing garage ENTER ring + beacon
(`_buildGarageExterior` builds just the ring for minimal lots).
`_defineServiceAreas` still clears every other lot's garage flag; the
`paAccessLanes:true` twin keeps the legacy Shibaura garage.

- ENTER ring at deck u=−24, on the far side of the aisle; `initialSpawn`
  (boot, garage exit, tow, crash recovery) sits at deck u=0 on the aisle
  (v=−3.2), facing the exit end — outside both the 13 m transition radius
  and the 18 m proximity-prompt radius.

## 3. ramp_8 access — one entry, one exit (refined 2026-07-17)

Both connectors pass through the deck ENDS, exactly like the legacy access
lanes did (their lot legs attached at ±0.52 L — the end rails only ever
covered the outward half of each end, so the gates are open by
construction and the side fence stays unbroken):

- **Entry** (`tatsumi_pa_entry`, 260 m): probability-0 diverge from ramp_8
  upstream (player-only, like legacy PA entries), a 60 m legacy mouth pair
  + glide riding INSIDE the ramp's paved band exactly ON its banked deck
  plane (`_frameAt` + `_deckPoint` at each point's own lateral), pinned
  hand-off points just off the band, then a descent through the leftover
  fitted-corridor channel (the ramps keep their clearance for ~60 m past
  each deck end) resampled every ~9 m with a trapezoidal ease — grade
  ≤ 4.7 % — flush at the end line, then the aisle.
- **Exit** (`tatsumi_pa_exit`, 202 m): aisle → end gate (flush) → eased
  descent over the void → band join on the ramp plane → glide to the
  legacy mouth inset → 60 m mouth pair → merge edge, downstream of which
  ramp_8 continues into `wangan_0` (the Bayshore continuation). Grade
  ≤ 3.6 %.
- Band ride lateral is 3.55 m (inside the 4.5 m half-width, clear of the
  corridor outer-wall correction band at car radius ~0.8).

**Sinking root cause + fix.** The previous glue drew its own descending
strip up to ~0.9 m above the ramp plane while `getRoadInfo` scored the
ramp corridor best — the car rode the ramp plane *under* the drawn branch
asphalt (and scraped the rail between the two strips). Now every point
that can overlap the ramp corridor lies exactly ON the ramp's banked
plane, the descents are sole-owner (over the void), and the deck sections
are flush with the lot — rendering, collision and road lookup share one
profile everywhere (probe: collision-vs-render ≤ 0.063 m, steps ≤ 0.113 m
per 0.5 m station across centreline and both wheel tracks, zero
wall-collision hits sweeping both lanes at car radius).

One shared-machinery fix fell out of this: `_surfaceDefersToHost` handed a
branch centreline to the host as soon as its coplanar strip was covered by
the host's DRAWN deck, but the host's drivable band is ~0.4–0.9 m
narrower, so crossing the host's edge line left a no-man's ring that
wall-corrected (scraped) the car mid-crossing. The non-progressive defer
now keeps the branch corridor alive in that margin (heights agree either
way — the dy gate already guarantees coplanarity).

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

- `.devtests/tatsumi-pa-flow-probe.mjs` — garage/spawn on the bare deck,
  entry+exit continuity + one-height-authority (incl. physics wall sweeps
  and visible-rail gap coverage at both edge crossings), end gates,
  grade separation, left-hand traffic, nothing-else-enabled. PASS.
- `.devtests/tatsumi-pa-placement-probe.mjs` — updated to the live-garage
  state (exactly the entry+exit pair allowed; thresholds scaled to the
  compact deck; twin reversibility kept). PASS.
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
- Screenshots (`.devtests/shots/`, gitignored): `FLOW-top-down` (compact
  empty deck), `FLOW-spawn-chase`, `FLOW-entrance`, `FLOW-exit`,
  `FLOW-drive-entry`/`FLOW-drive-exit` (the car mid-transition, no
  sinking), `FLOW-side-elevation`, `FLOW-markings-chase(-before)`,
  `FLOW-traffic-directions` — via `.devtests/tatsumi-pa-flow-shots.mjs`.

## Remaining / debt

- The entry descent peaks at 4.7 % and the exit at 3.6 % — comfortably
  drivable; a longer swing could soften them further.
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
