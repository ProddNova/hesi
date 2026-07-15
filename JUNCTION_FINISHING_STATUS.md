# Junction Visual Finishing Status

## Exact A-B merge-marking clipping pass (2026-07-15c)

- Branch: `codex/merge-marking-ab-clipping`
- Base: `origin/main` at `edd31f9918af49d86d9e4aa1657d2f342e77fe4e`
- Scope: marking diagnostics, the authoritative same-level opening,
  route-local marking clipping and explicit boundary ownership only. Road
  centrelines, paved geometry, collision, vehicle physics, traffic topology,
  elevation and guardrail architecture are unchanged.

### A-B model and demonstrated root cause

For a host carriageway and a joining branch, A-B is the mouth-connected
component where the renderer's own `_mouthClipAt` removes a host-covered,
coplanar branch strip and the crossed top surface is shelf-free. It is the
same `continuous = merged && physical overlap` decision already consumed by
the rendered paved union and collision hand-off. A is the first exact
transition into that component and B is the exact transition out.

The old marking system did not clip a continuous marking path at A/B:

1. `_prepareJunctionZones` sampled the shared geometry every 4 m and stored
   coarse min/max chainages.
2. The branch host-facing solid edge used the coarse zone hand-off, while
   other branch markings still made independent per-render-frame mouth-clip
   decisions.
3. `_paintStrip` rejected a complete surface-frame span when either endpoint
   was suppressed. With frames up to 8 m apart, a true intersection could be
   moved by almost one whole frame; no split vertex was emitted at A or B.
4. Branch internal dividers had no junction ownership rule, so 24 route-local
   divider/edge pieces survived inside legal openings in the instrumented,
   behavior-unchanged baseline. The host, branch and junction systems could
   consequently paint the same physical region without an explainable owner.

This was an ownership/clipping defect, not a road-shape defect. Expanding the
old intervals or adding route-specific offsets would only move the error.

### Authoritative opening and exact cutter

`HighwayMap._junctionMouthRow` now evaluates a branch section using the
renderer-authoritative mouth clip and records the removed/covered band,
host/branch chainage, deck edges, union width and shelf decision. The 4 m rows
locate topology only. `_refineJunctionTransition` bisects each boolean
transition by fresh geometry evaluations to a bracket below 5 mm. Only the
mouth-connected component is refined; disconnected overlaps cannot own this
mouth.

Each zone stores `markingOpening` with:

- exact branch and unwrapped-host A/B chainages;
- the geometry source (`rendered-mouth-clip-connected-component`);
- sampled removed/covered envelope rows;
- a world-space opening polygon.

Before tessellation, `_paintStrip` detects any span containing A or B and
hands it to `_paintMouthStripSegment`. That helper inserts exact A/B cut
stations, classifies each independent interior piece, discards only forbidden
pieces, and emits separate quads. A quad can therefore never bridge the
removed interval. Normal spans retain the established surface-frame/deck-plane
path, and dash phase remains route-absolute.

The host solid edge is suppressed over the complete authoritative opening.
The branch edge facing the host and absorbed branch dividers are absent
inside A-B; the far branch edge remains the physical outside edge. Host lane
dividers remain route-owned and are not suppressed. An optional dashed merge
boundary is junction-owned only where the same opening geometry says the
extra lane is usable.

Every zone exposes `markingBoundaries`: physical meaning, route/lateral,
interval, outside owner, opening owner (`host`, `branch`, `junction`, or
`none`) and the reason for that decision. Painted and suppressed debug pieces
also expose owner, type, positions, chainage, tangents, route/junction class,
zone memberships, true-opening intersection and suppression reason.

### Six recorded representative cases

The current line range is the surviving branch host-facing solid edge nearest
the opening. No host lane divider was wrongfully suppressed in any case.

| Topology | Connection | Side / lanes | Exact branch A-B (m) | Current branch line near A (m) | Active owners near opening |
| --- | --- | --- | ---: | ---: | --- |
| one-lane into two-lane merge | `ramp_1 -> r11_0` | left, 1 -> 2 | 315.02-335.57 | 195.7-315.0 | `route:r11_0`; branch boundary becomes `none` |
| two-lane into two-lane merge | `c1_3 -> c1_0` | right, 2 -> 2 | 328.04-447.31 | 282.5-328.0 | `route:c1_0`, `route:c1_3`, `junction:J0` |
| two-lane into three-lane merge | `ramp_3 -> wangan_1` | left, 2 -> 3 | 919.36-1087.59 | 879.7-919.4 | `route:wangan_1`, `route:ramp_3`, `junction:J10` |
| left-side merge | `c1_6 -> c1_2` | left, 2 -> 2 | 254.20-351.70 | 202.2-254.2 | `route:c1_2`, `route:c1_6`, `junction:J1` |
| right-side merge | `r6_3 -> c1_0` | right, 2 -> 2 | 1778.77-1940.43 | 1755.7-1778.8 | `route:c1_0`, `route:r6_3`, `junction:J5` |
| diverge | `c1_0 -> r1_0` | right, 2 -> 2 | 0.00-153.93 | 153.9-164.5 | `route:c1_0`, `route:r1_0`, `junction:J2` |

### Parent-fail / branch-pass proof

The same `.devtests/ab-marking-clipping-probe.mjs` executable was run against
the detached parent worktree and this branch.

- Parent `edd31f9`: **FAIL (57)**, exact openings 0/56; all 56 zones lack an
  authoritative geometry-refined A-B record and 113,699 pieces lack the new
  ownership diagnostics.
- Behavior-unchanged diagnostic commit `d14bda1`: **FAIL (135)** with 0/56
  exact openings, maximum cut error 7.992 m, 24 route-local pieces inside
  openings, shortest accidental fragment 0.100 m, longest illegal penetration
  5.016 m and one duplicate boundary.
- Final branch: **PASS**, 56/56 exact openings, 112,605 painted pieces, maximum
  observed A/B error 0.000 m, and zero route-local opening pieces, solid-edge
  penetrations, bridging quads, accidental fragments, illegal penetration,
  duplicate boundaries, wrongful host-divider suppressions and invented
  one-lane dividers.

### Identical-camera visual evidence

`.devtests/ab-marking-shots.mjs` serves either checkout and derives each camera
from the unchanged route/zone geometry. Fade completion, chunk visibility and
two rendered frames are awaited before capture. Every case was inspected in
plan, chase and close views. The after images show the host-facing branch line
ending at the real opening, host dividers continuing longitudinally, and no
crossing solid, slash fragment, duplicate boundary, asphalt change or rail
regression.

| Case | View | Parent | Branch |
| --- | --- | --- | --- |
| 1 -> 2 merge | plan | [before](docs/junctions/ab-clipping/AB-one-to-two-merge-plan-before.png) | [after](docs/junctions/ab-clipping/AB-one-to-two-merge-plan-after.png) |
| 1 -> 2 merge | chase | [before](docs/junctions/ab-clipping/AB-one-to-two-merge-chase-before.png) | [after](docs/junctions/ab-clipping/AB-one-to-two-merge-chase-after.png) |
| 1 -> 2 merge | close | [before](docs/junctions/ab-clipping/AB-one-to-two-merge-close-before.png) | [after](docs/junctions/ab-clipping/AB-one-to-two-merge-close-after.png) |
| 2 -> 2 merge | plan | [before](docs/junctions/ab-clipping/AB-two-to-two-merge-plan-before.png) | [after](docs/junctions/ab-clipping/AB-two-to-two-merge-plan-after.png) |
| 2 -> 2 merge | chase | [before](docs/junctions/ab-clipping/AB-two-to-two-merge-chase-before.png) | [after](docs/junctions/ab-clipping/AB-two-to-two-merge-chase-after.png) |
| 2 -> 2 merge | close | [before](docs/junctions/ab-clipping/AB-two-to-two-merge-close-before.png) | [after](docs/junctions/ab-clipping/AB-two-to-two-merge-close-after.png) |
| 2 -> 3 merge | plan | [before](docs/junctions/ab-clipping/AB-two-to-three-merge-plan-before.png) | [after](docs/junctions/ab-clipping/AB-two-to-three-merge-plan-after.png) |
| 2 -> 3 merge | chase | [before](docs/junctions/ab-clipping/AB-two-to-three-merge-chase-before.png) | [after](docs/junctions/ab-clipping/AB-two-to-three-merge-chase-after.png) |
| 2 -> 3 merge | close | [before](docs/junctions/ab-clipping/AB-two-to-three-merge-close-before.png) | [after](docs/junctions/ab-clipping/AB-two-to-three-merge-close-after.png) |
| left merge | plan | [before](docs/junctions/ab-clipping/AB-left-merge-plan-before.png) | [after](docs/junctions/ab-clipping/AB-left-merge-plan-after.png) |
| left merge | chase | [before](docs/junctions/ab-clipping/AB-left-merge-chase-before.png) | [after](docs/junctions/ab-clipping/AB-left-merge-chase-after.png) |
| left merge | close | [before](docs/junctions/ab-clipping/AB-left-merge-close-before.png) | [after](docs/junctions/ab-clipping/AB-left-merge-close-after.png) |
| right merge | plan | [before](docs/junctions/ab-clipping/AB-right-merge-plan-before.png) | [after](docs/junctions/ab-clipping/AB-right-merge-plan-after.png) |
| right merge | chase | [before](docs/junctions/ab-clipping/AB-right-merge-chase-before.png) | [after](docs/junctions/ab-clipping/AB-right-merge-chase-after.png) |
| right merge | close | [before](docs/junctions/ab-clipping/AB-right-merge-close-before.png) | [after](docs/junctions/ab-clipping/AB-right-merge-close-after.png) |
| diverge | plan | [before](docs/junctions/ab-clipping/AB-right-diverge-plan-before.png) | [after](docs/junctions/ab-clipping/AB-right-diverge-plan-after.png) |
| diverge | chase | [before](docs/junctions/ab-clipping/AB-right-diverge-chase-before.png) | [after](docs/junctions/ab-clipping/AB-right-diverge-chase-after.png) |
| diverge | close | [before](docs/junctions/ab-clipping/AB-right-diverge-close-before.png) | [after](docs/junctions/ab-clipping/AB-right-diverge-close-after.png) |

### Full regression comparison

| Check | Parent | Branch | Assessment |
| --- | --- | --- | --- |
| A-B clipping | FAIL 57; 0/56 exact openings | PASS; 56/56, all violation counters 0 | intended fix |
| merge-marking | PASS, 113,699 strips | PASS, 112,605 strips | fewer forbidden pieces; all four counters 0 |
| marking orientation | PASS, 0 diagonal / 0 lateral jump / 44 clean chevrons | same, 112,605 strips | unchanged geometry quality |
| junction finishing | FAIL 6 | FAIL same 6 and identical maxima | pre-existing, out of scope |
| lateral junction | PASS, 56 mouths / 20,185 points / 22 doubles | identical | unchanged |
| road surface | PASS | PASS; identical frame/length/angle/vertical/lateral metrics | one extra exact dash call only |
| merge guardrail | PASS, worst 2.00 m | identical | unchanged |
| guardrail | PASS, 211 runs / 88 gaps | identical | unchanged |
| traffic smoke | PASS, 23 active / finite positions | identical deterministic result | unchanged |
| performance | absolute 4 s limit fails in this container; node median 7,244.1 ms | same environmental fail; node median 7,458.0 ms (+3.0%) | expected bounded cost of exact 56-zone refinement; 168 vs 169 draw calls and 2,188 fewer stored triangles |
| osm-validate | 329 known failures (22 overlap, 247 ramp-drive, 60 smoothness) | identical counts and first failures | unchanged |
| complete mobile e2e / iPhone viewport | PASS 34/34, no console errors | PASS 34/34, no console errors | unchanged |

The performance probe's browser run is single-sample and noisy (branch booted
faster, 8.06 s vs 9.83 s, while its isolated browser map-build sample was
slower). The three-run Node median is the comparison used above. Build-time
bisection rows are cached only within one zone and released immediately, so
the exact model does not retain thousands of scratch frames at runtime.

Cache versions: `map.js?v=20260715h`, service worker
`shutoko-nights-v19`.

### Remaining limitations

This pass does not claim every junction subsystem is perfect. The unchanged
six finishing failures remain: five steering-rate route-data kink families
and the `ramp_0`/`r1_3` 0.332 m collision-height step. OSM validation likewise
retains the same 329 data/topology issues, and PA access lanes remain disabled
pending their dedicated rebuild. None is caused by marking clipping, and none
was modified here.

---

## Merge-local markings + guardrails finishing pass (2026-07-15b)

- Branch: `claude/merge-markings-guardrails-final-id16mj`
- Base: `origin/main` at `0572fc4` (after PR #20, the pass documented
  below this section)
- Scope: **merge-local only** — lane-marking ownership through
  same-level merge/diverge zones, and merge-local guardrail hand-off
  continuity. No change to junction geometry, vertical crossings, PA
  access lanes, or map generation; the paved envelope and crossability
  rules from the prior passes are untouched.

### User-observed defects (2026-07-15, second visual bug report)

1. One-lane branches still occasionally showed diagonal `/ \` marks.
2. A line belonging to the incoming road appeared 50-100 m before the
   real merge and cut across the host road.
3. In multi-lane merges (2-lane into 3-lane), the incoming outer solid
   line appeared too early and overwrote/duplicated the host's dashed
   lane line.
4. Guardrails: visible step discontinuities, accidental 20-40 m gaps,
   bad convergence on outer rails (2-lane → 3-lane called out as the
   worst case), and openings slightly too long or poorly placed.

### Phase 1 — classification

Reproduced against four representative cases (right/left, 1→2/2→3
lane merges): `k1_0 ← ramp_42` (1→2, right), `wangan_1 ← ramp_9` and
`wangan_0 ← ramp_47` (2→3, right), `c1_0 ← r6_3` (left, equal-width).
`.devtests/merge-marking-probe.mjs` (new) formalises the classification
and fails 272 times on this base commit; `.devtests/merge-guardrail-probe.mjs`
(new) fails 40/47 checked zones, up to 59 m of hand-off mismatch.

Root cause of defects 2/3 (marking): `_prepareJunctionZones` derives the
host's dashed merge boundary and edge-line suppression (`dash`,
`hostEdgeSuppress`) from `crossOuter`, which carries an extra 0.18 m
lip-veto on top of the union width — meaningful for genuinely stacked
wings, but pure interpolation noise on a shallow, level merge taper,
where it flickered the derived interval down to a short window near one
end of the true taper. Separately, a branch's own edge line was only
ever suppressed by its per-frame coplanar-overlap clip (`_mouthClipAt`),
which on the same shallow taper lags the zone's "one drivable union"
verdict by tens of metres. The two effects combined: the host's own
edge line would vanish (correctly) while the branch kept independently
painting a "ghost" edge line through the same stretch — the reported
early/duplicate line.

Root cause of defect 4 (guardrail): the branch's own outer-rail hand-off
(`tipIndex`) was derived from a stricter, *different* threshold
(union width past host by 0.6 m) than the host's own rail-opening band
(`railBlocked`, 0.15 m) — despite a code comment already asserting they
were "bound to the same tip row." They weren't, and disagreed by tens of
metres on a shallow taper: the host's rail opens (correctly, a real
paved conflict) well before the branch's own outer rail turns on,
leaving the stretch between with no rail on either route.

Defect 1 (diagonal one-lane marks) was not reproduced on this base commit
— the prior pass's `_dressGores` fix (zone-aware parallel gore hatching)
already holds network-wide (`marking-orientation-probe`: 0 diagonal
pieces, 0 alternating chevron runs).

### Phase 2 — marking ownership fix

`js/map.js`, `_prepareJunctionZones` + `_queueRouteDetails`:

- `hostEdgeSuppress`/`dash` now derive from `unionOuter` instead of
  `crossOuter`, but only within rows already inside the zone's
  `crossable` run — every such row already cleared the looser 0.35 m
  `shelfFree` test to get there, so the extra 0.18 m veto could no
  longer be distinguishing a genuine wing from taper noise.
- A branch's own edge line is now suppressed on the host-ward side
  throughout the zone's `crossable.branch` span — the zone is the
  single authority on that boundary once a station is inside crossable,
  not the branch's independent per-frame clip. The branch's *far*
  (outer) edge line is untouched: it correctly becomes the widened
  road's new outer boundary, exactly as before.

`.devtests/merge-marking-probe.mjs` goes from 272 failures to 0.
Confirmed visually at the two 2-lane→3-lane cases (`wangan_1 ← ramp_9`,
`wangan_0 ← ramp_47`): a duplicate/converging solid line that used to
run alongside the host's resumed edge line is gone, leaving one clean
boundary (`docs/junctions/marking-2to3-merge-*-before/after.png`).

### Phase 3 — guardrail continuity fix

`js/map.js`, `_prepareJunctionZones`:

- The branch's outer-rail tip (`tipIndex`) now derives from the SAME
  `railBlocked` band used to build the host's own opening
  (`hostRailOpen`), instead of a separate, stricter width threshold —
  the hand-off happens at one shared physical row by construction.
- The forced-on span is built as separate pieces bounded by
  `railBlocked`, not one interval blindly spanning to the last sampled
  row: a route whose data kinks back near the host well beyond the
  merge (the pre-existing, documented steering-snap families —
  `r6_0`/`ramp_18`, `ramp_21`, `ramp_46`) can carry a second, disjoint
  engaged stretch with a genuinely clear gap in between; forcing "on"
  straight through that gap put the branch's outer rail parallel to,
  and within a metre of, the host's own independently-visible rail
  there (a new doubled-rail regression caught by `guardrail-probe`
  during this fix and corrected before landing).

`.devtests/merge-guardrail-probe.mjs` (new) goes from 40/47 zones
failing (up to 59 m apart) to 0/52, worst case 2.0 m — exactly the
deliberate padding built into the opening bounds. `guardrail-probe`,
`junction-finishing-probe` and `lateral-junction-probe` are unchanged
(same pass/fail split as before this pass, including the same 6
documented, out-of-scope failures).

### Before/after images (docs/junctions/)

| Case | Before | After |
| --- | --- | --- |
| `wangan_1 ← ramp_9` (2→3, right) merge paint | `marking-2to3-merge-wangan1-ramp9-before.png` | `marking-2to3-merge-wangan1-ramp9-after.png` |
| `wangan_0 ← ramp_47` (2→3, right) merge paint | `marking-2to3-merge-wangan0-ramp47-before.png` | `marking-2to3-merge-wangan0-ramp47-after.png` |
| `c1_0 ← r6_3` (left, equal-width) merge paint | `marking-left-merge-c1_0-r6_3-before.png` | `marking-left-merge-c1_0-r6_3-after.png` |

### Probe results (this pass)

| Check | Result | Evidence |
| --- | --- | --- |
| Merge-marking probe (new) | PASS | 56 zones, 113,699 strips: 0 early-incoming-edge (was 272), 0 host-edge-inside-suppress, 0 dash-outside-overlap, 0 one-lane-zigzag |
| Merge-guardrail probe (new) | PASS | 52 zones checked: worst outer-rail convergence 2.0 m (was up to 59 m, 40/47 zones failing), 0 opening-crossed, 0 unexplained branch gaps |
| Marking-orientation probe | PASS | 113,699 strips, 0 diagonal, 44 chevrons all clean — unchanged |
| Guardrail probe | PASS | 211 runs / 88 gaps / 52 zone openings, 0 unexplained gaps, 0 doubled, 0 inside asphalt — unchanged pass |
| Junction-finishing probe | 6 failures (unchanged set) | same 5 steering-rate data kinks + 1 collision-step family as the base commit, none touched by this pass |
| Lateral-junction probe | PASS | 56 mouths / 20,185 pts, 0 holes/steps/rails-across, duplicates 22 (ratchet 60) — unchanged |
| Road-surface probe | PASS | refinement + dash phase, 0 errors |
| osm-validate | unchanged | 22 overlap / 247 ramp-drive / 60 smoothness failures — identical counts to the base commit; pre-existing data families |
| Traffic runtime smoke | PASS | 20 s, 23 active vehicles, finite positions |
| Performance | no regression | map build 6.89 s vs base 6.94 s on this container (container fails the absolute limits identically at base, documented pre-existing) |
| End-to-end | PASS | 34/34 checks, no console errors across the whole session |

Cache versions bumped per convention: `map.js?v=20260715g`, service worker
`shutoko-nights-v18`.

### Remaining open issues (unchanged, out of scope for this pass)

Same as documented below: the steering-rate route-data kinks
(`r6_0`/`c1_2`, `ramp_18`, `ramp_21`, `ramp_27`, `ramp_46`), the
`ramp_0`/`r1_3` collision-height overlap family, and PA access lanes
(disabled, pending their own rebuild). None of these are merge-marking
or merge-guardrail defects — they are route-data/vertical-crossing
issues explicitly out of scope for this pass.

---

# Junction Visual Finishing Status (previous pass)

- Date: 2026-07-15
- Branch: `claude/junction-markings-rails-cleanup-33r2nb`
- Base: `origin/main` at `8e4467a` (after the junction-merge-finishing PR #19)
- Scope: junction lane-marking finishing, junction-local guardrail
  finishing, temporary removal of PA access roads. The paved merge
  geometry from PR #18/#19 is preserved untouched.

## User-observed defects (visual bug report, 2026-07-15)

1. Road markings did not merge correctly at junctions.
2. One-lane branches merging into two-lane roads produced diagonal
   alternating slash/backslash marks (`/ \ / \`) instead of longitudinal
   dashed lines — reproduced 1:1 at `k1_0 ← ramp_42` and along the long
   `r1_3 ← ramp_12` funnel (the junction in the user's portrait
   screenshot), and at `c1_0 ← c1_3` / `c1_0 ← r6_3`.
3. Solid and dashed markings overlapped or continued through areas where
   they should end.
4. Guardrails sometimes terminated with a visible lateral step.
5. Guardrails disappeared for ~20–30 m (up to 70 m measured) outside the
   necessary opening.
6. At some junctions a guardrail remained across the joining road
   (14 junctions measured: `ramp_42`/`k1_0`, `ramp_36`, `ramp_39`,
   `ramp_25`, `ramp_29`, `ramp_31`, `ramp_35`, `ramp_37`, `ramp_40`,
   `ramp_41`, `ramp_43`, `ramp_47`, `ramp_27`, `ramp_22` hosts).
7. The one-lane PA/parking connectors were still visible (the Shibaura
   garage connector was the survivor of the earlier PA disable).

## Root cause of the zig-zag marking bug

The dashed/edge strip painters were measured CLEAN — the new
instrumentation (`options.markingDebug` logs every painted piece;
`.devtests/marking-orientation-probe.mjs` measures it) found **0**
diagonal strip pieces and **0.00 m** lateral jumps across 114,004 painted
dash/edge pieces. The `/ \ / \` pattern was entirely `_dressGores`:

- it painted its gore "chevron" stripes with an **alternating ±0.62 rad
  (±35.5°) skew** (`flip *= -1`) every 9 m;
- its wedge test (host edge ↔ ramp edge wider than 1.1 m before the paved
  split) is satisfied across the whole merged union, so the stripes
  marched straight down the **crossable merge lane** where the
  longitudinal dashed boundary belongs — measured: 622 chevrons, 49
  alternating ±36° runs, **369 chevrons on crossable zone intervals**
  (worst: ~300 m down the `ramp_12 → r1_3` funnel).

Defect 3 was the same paint: hatching stacked on top of the zone's dashed
boundary and the through-going lines.

### Fix (one authoritative layout)

`_dressGores` now consumes the shared junction-zone record (the same one
markings, rails, physics and probes read):

- no hatching on crossable stations — the zone's dashed boundary owns the
  merge/exit lane;
- no hatching between split-level decks (edges must be within 0.25 m —
  a wedge between decks 0.3+ m apart is two separate surfaces, which is
  what the honestly-closed `ramp_12` funnel band is);
- a 6-stripe (~54 m) nose cap;
- all stripes of one gore lean the SAME way, mirrored by connection side
  (real 導流帯 hatching), never alternating.

44 chevrons remain network-wide, all on genuine gore noses. The rest of
the marking layout was already zone-owned and stays: host edge line
suppressed exactly over `hostEdgeSuppress`, dashed boundary at the
host's outer lane edge through `dash` with route-absolute phase, branch
lines clipped to the drawn deck via the mouth clip (obsolete inner edge
line disappears under the union; outer edge line becomes the joining
road's outer line). One owner per boundary; finishing probe reports
0 solid-across, 0 duplicate boundaries.

## PA access roads disabled (temporary)

`PA_ACCESS_LANES_DISABLED` now covers **all four** access lanes —
`shibaura_pa_access` (the garage connector) included. No PA route is
registered at runtime, so connector asphalt, collision corridors, wall
segments, markings, guardrails, traffic connections, advance boards and
minimap polylines are all absent together. Raw and smoothed route data
are untouched; `options.paAccessLanes = true` (or `?paAccessLanes=1` in
the browser) restores every lane.

Garage flow without its lane:

- initial spawn / tow return / garage exit already landed on the R11
  mainline (`initialSpawn`, 620 m past the lot) — unchanged;
- the ENTER GARAGE trigger (`area.garageEntrance`, read by
  `getGarageTransition`, service-area proximity and the minimap marker)
  moved to the host carriageway's shoulder beside the lot; the physical
  building keeps its lot anchor (`area.garageLotAnchor`), and the pulsing
  transition ring/beacon follow the shoulder trigger;
- the lots themselves stay visible (dressing, refuel, proximity).

`.devtests/pa-access-probe.mjs` proves the disabled state: no registered
geometry, no collision corridor along the old connector paths, no
traffic lanes/graph edges, no minimap polylines, no junction artefacts,
garage flow preserved, and the `paAccessLanes: true` twin restores 4/4
lanes.

## Guardrail interval architecture

Junction rail openings previously came from two disagreeing sources: a
tip-tied zone interval (when the union out-poked the host edge) and a
~9 m-cached point probe with a ±4 m vertical band. Both directions
failed: openings ran ~300 m past the physical envelope, or the rail was
blanket-forced ACROSS the exit path with the ragged cache deciding the
real opening up to 9 m off.

Now ONE physical rule derives every opening (`_prepareJunctionZones`):

- per zone row, the host rail (footprint laterals
  `[hostHalf − 0.42, hostHalf]`) is **blocked** when the branch pavement
  reaches under it (outer edge past `hostHalf − 0.15`) while the
  hostward edge has not cleared it (`innerEdge < hostHalf + 0.5`), at
  barrier-conflict height (`dy ∈ (−1.6, 1.35)` — the same window
  `_barrierSuppressed` uses);
- the contiguous blocked band **is** the opening (`hostRailOpen`);
  mouthward of it the rail is forced ON through the covered union (the
  yield probe would otherwise kill the widened host edge's rail); outward
  the exact point probe rules;
- `_barrierSuppressed` conflict band tightened from ±4 m to the barrier's
  own height (deck between 1.35 m below and 1.6 m above the base):
  parapets on decks bridging another road 2–4 m away no longer vanish —
  this was the unexplained 20–70 m rail-hole family at close grade
  separations (`k5_1`/`wangan_1`, `ramp_25`/`r9_1`, the `r1_0`/`r1_3`
  overlap…);
- doubled-rail tie-break: where another carriageway's own rail line runs
  within 1 m at the same level (chain abutments, u-turn stubs, braids)
  the earlier-registered route owns the shared edge;
- rail visibility probes **every** surface frame exactly (the 9 m verdict
  cache is gone; a grid-distance rejection keeps the map build at its
  previous cost), and `_computeBarrierVisibility` records the drawn runs
  + cut causes on `route._railRuns` for the probes;
- terminals keep the ramped `_parapetProfile` taper + end caps; measured
  restart continuity is 0.02 m lateral / 19° tangent worst-case.

## Before/after images (docs/junctions/)

| Case | Before | After |
| --- | --- | --- |
| `k1_0 ← ramp_42` merge paint | `marking-left-merge-k1_0-ramp42-before.png` (alternating `/ \` down the merge lane) | `marking-left-merge-k1_0-ramp42-after.png` (longitudinal dashes only) |
| `r1_3 ← ramp_12` funnel paint | `marking-right-merge-r1_3-ramp12-before.png` (~300 m of zig-zag) | `marking-right-merge-r1_3-ramp12-after.png` (clean) |
| Shibaura PA connector | `pa-shibaura-connector-before.png` (descent loop + lane) | `pa-shibaura-connector-after.png` (gone; shoulder ring marks the garage trigger) |
| `k1_0`/`ramp_42` rail opening | — | `rail-opening-k1_0-ramp42-after.png` (tapered terminals, no rail across the exit, no step) |

`.devtests/shots/` additionally holds identical-camera before/after pairs
for all seven `J-*` junction cases (top/oblique/chase), the `JC-*`
close-ups and the `T-*` rail-terminal zooms, all at an iPhone-like
viewport (844×390 touch) plus the chase (gameplay) camera; portrait
overlap check passes at 390×844.

## Probe results

| Check | Result | Evidence |
| --- | --- | --- |
| Marking-orientation probe (new) | PASS | 114,004 strip pieces: 0 diagonal (2 deck-kink followers excluded, data families), lateral jump 0.00 m; 44 chevrons: 0 alternating runs, 0 on crossable boundaries (was 69 failures) |
| Guardrail probe (new) | PASS | 202 runs / 80 gaps / 52 zone openings: 0 rail-across-opening, 0 unexplained gaps, 0 doubled, 0 inside asphalt; restart step 0.02 m; every opening justified by its own paved envelope |
| PA access probe (new) | PASS | 536 connector stations: no geometry/corridor/traffic/edges/minimap; garage flow preserved; reversible 4/4 |
| Junction-finishing probe | 6 failures (unchanged set) | all in documented-excluded families (5 steering-rate data kinks `r6_0`,`ramp_18`,`ramp_21`,`ramp_27`,`ramp_46`; 1 collision step `ramp_0`/`r1_3` overlap family); rail check now measures real guarding from recorded runs: union edge never unguarded > 8 m where wide enough for a rail |
| Lateral-junction probe | PASS | 56 mouths / 20,185 pts; 0 holes, 0 steps, 0 rails-across, duplicates 22 (ratchet 60) |
| Road-surface probe | PASS | refinement + dash phase, 0 errors |
| Elevation-offset probe | PASS | garage connector expected disabled |
| osm-validate | unchanged | 22 overlap / 247 ramp-drive / 60 smoothness failures — identical counts on the base commit (stale committed file refreshed); pre-existing data families |
| Traffic runtime smoke | PASS | 20 s, 23 active vehicles, finite positions |
| End-to-end | PASS | 34/34, garage/tow flows work without the connector, no console errors |
| Performance | no regression | map build 6.98 s vs base 6.94 s on this container (documented container fails absolute limits identically at base); frame p95 within run noise |

Cache versions bumped per convention: `map.js?v=20260715f`,
`game.js?v=20260715f`, service worker `shutoko-nights-v17`.

## Remaining genuinely vertical/elevation-related junction defects

Unchanged from the previous checkpoint — all need the separately
authorized vertical/extractor pass:

1. Deck-attitude/height blending through mouths: the `ramp_12` funnel and
   `ramp_22` exit wedge stay honestly closed (crossable ends where the
   deck steps 0.3–1 m), and the residual steering-kink families
   (`r6_*`, `ramp_18/21/27`, `ramp_46`) live in the route data.
2. Overlapping-carriageway height disagreements outside mouths
   (`r1_0`/`r1_3` family — osm-validate "overlap"). With the tightened
   rail band both stacked decks now draw their own parapet where they are
   ≥ 1.6 m apart; the underlying double-deck data defect remains.
3. PA access lanes themselves: disabled at runtime pending their own
   rebuild (geometry in raw/smoothed data untouched).

Vertical crossings, global elevation, terrain, the road editor and
unrelated traffic work remain untouched, as required.
