# Progressive Merge Checkpoint Status

## Checkpoint 2 — live status (2026-07-16)

Checkpoint 2 supersedes the Checkpoint 1 eligibility conclusions below while
retaining its implementation history and visual evidence. The candidate set is
still exactly P1–P4; no network-wide rollout is active.

### Phase A complete — deck classification and legacy restoration

The generic classifier in `js/progressive-junction-classifier.js` now consumes
the same per-cross-section `row.merged` decision used by rendering and
collision. A simple lateral transition must remain one owned deck while its
paved envelopes overlap in plan. If ownership breaks before measured lateral
separation, the case is multi-level/vertical and is not passed into the shared
progressive model.

The old audit was a false positive because it considered only the maximum
vertical delta inside the short crossable mouth. That accepts a branch which is
nearly level at transfer but becomes a ramp while still overlapping the host in
plan. The corrected invariant measures ownership all the way to physical
lateral separation:

| Pin | Junction | Driver side | Classification | Deck evidence | Runtime |
| --- | --- | --- | --- | --- | --- |
| P1 | `J8:merge:r11_0:ramp_1:end` | right | `vertical-ramp-complex` | 27 overlap rows lose ownership; vertical span 2.777 m | deferred; legacy restored |
| P2 | `J0:merge:c1_0:c1_3:end` | left | `vertical-ramp-complex` | 9 overlap rows lose ownership; vertical span 2.620 m | deferred; legacy restored |
| P3 | `J10:merge:wangan_1:ramp_3:end` | right | `vertical-ramp-complex` | 9 overlap rows lose ownership; vertical span 2.186 m | deferred; legacy restored |
| P4 | `J2:diverge:c1_0:r1_0:start` | left | `same-level-simple` | continuous ownership through 152 m of planar overlap | active prototype |

The side correction is data-derived, not junction-specific:
`horizontalNormal()` is documented as the driver's right, so a negative
`zone.side` is left. P4's source geometry and travel direction therefore agree
with the reported left departure; Checkpoint 1's presentation label was
reversed.

The developer map still consumes the four-item shared candidate configuration.
It shows P4 as the magenta active prototype and P1–P3 as hollow amber deferred
candidates, with stable P1–P4 IDs, full topology/classification metadata, phase
boundaries for P4, and click-to-teleport on every pin. Mobile and desktop use
the same map renderer and records.

Focused verification after Phase A:

- progressive junction classification: PASS;
- progressive model: PASS (1 active, 3 deferred, 0 active in legacy mode);
- progressive geometry/paint/rail/collision probe: PASS for P4 baseline;
- Dev Map Playwright regression: PASS 34/34;
- A–B clipping, guardrail, merge-guardrail and merge-marking probes: PASS.

Checkpoint 2's supplied attachment directory contained the textual brief but
no image files. The described P4 defect is being reproduced from deterministic
repository cameras and geometry instrumentation; no missing visual is being
invented.

Phase A commit: `19d710e` (`Classify progressive junction deck topology`),
pushed to `origin/codex/progressive-merge-prototype`.

### Phase B complete — P4 failing-first evidence

`.devtests/p4-diverge-continuity-probe.mjs` derives the expected handoff from
the actual `r1_0` lane-0 trajectory. It holds the fully opened auxiliary centre
until that source lane reaches it, then uses a zero-slope blend into the branch.
It also grades the emitted parapet vertices, production corridor collision and
transition-owned paint. No threshold is inferred from the output under test.

The unmodified Checkpoint 1 P4 correctly fails seven assertions, recorded in
`docs/progressive-merges/checkpoint-2/P4-BEFORE.json`:

- usable extra width falls to 0.847 m before source-derived alignment (3.55 m
  is required), with premature closure beginning at host s=10968.401;
- the auxiliary endpoint is 9.390 m from `r1_0` lane 0;
- three emitted host-parapet samples lie inside the authoritative shared paved
  union after the branch becomes the exterior;
- 17.098 m of progressive solid edge marking crosses the exit handoff;
- the temporary boundary ends 5.537 m from its branch boundary;
- the intended reference path itself currently has no production-corridor
  pavement holes or collision corrections, so the repair must preserve that
  existing collision connectedness rather than masking the topology defect.

The measured landmarks are host/branch s=10982.425/148 for lane alignment,
10991.072/156 for physical planar separation, and 10973.973/140 for exterior
ownership handoff. The eight fixed cameras in
`.devtests/p4-diverge-shots.mjs` do not depend on progressive phases. Their
directly inspected before set is in `docs/progressive-merges/checkpoint-2/before/`
and includes plan, approach, auxiliary, branch handoff, guardrail, collision
hitbox, host continuation and branch continuation views. The plan/hitbox views
show the host envelope and red wall path returning across the exit instead of
handing exterior ownership to the branch.

**Exact resume point:** Phase C will implement the source-derived P4 lane-0
handoff and paved-envelope phase boundaries in the shared model. Rail and paint
ownership will then be corrected against the same exterior/split landmarks.
P5 remains disabled unless P4 passes all gates.

### Phase C complete — P4 topology and paved handoff

The shared diverge model now distinguishes four source-derived events:

- exterior ownership handoff: host/branch s=10973.973/140;
- branch feed lane reaches the auxiliary corridor: 10982.425/148;
- physical paved separation: 10991.072/156;
- safe gore-rail start: derived from at least 1.5 m clear planar separation.

The final mapping is explicit: `c1_0:0` and `c1_0:1` both continue on the
two-lane host; the outside host lane also splits into `aux:0`; `aux:0` follows a
cubic position/tangent-continuous path into the hostward `r1_0:0`; `r1_0:1`
forms as the second branch lane. The temporary state has three readable host
corridors and the finalized state has two host plus two branch lanes. Branch
lane centres and the transition boundary path are retained explicitly in the
record rather than inferred by paint or rails.

The host-only width easing is no longer treated as the final branch path. It
holds full usable width until the source lane is available, while the auxiliary
centre begins its tangent-continuous handoff when the real branch becomes the
union exterior. The visible/collision branch deck uses an exact host-plane
offset through the shared portion and eases to its source bank after lane
alignment. This removes the old 0.75 m ownership-height disagreement.

Focused results after Phase C:

- model probe: PASS (temporary 3, final 2 host + 2 branch);
- progressive shared probe: PASS; lane step 2.99 m, tangent step 2.88°,
  source-authoritative outer step 0.86 m, height switch 0.044 m;
- production `VehiclePhysics` branch traversal: PASS, 160.1 m, 0 collisions,
  0 wall correction, 0.12 m maximum lane error, one `c1_0 -> r1_0` ownership
  change;
- A–B marking clipping: PASS with every violation counter at zero;
- dedicated P4 gate: geometry/topology/collision assertions now pass; only the
  intentionally unmodified rail and solid-marking assertions remain red.

**Exact resume point:** Phase D will transfer outer rail ownership from the
host to the branch at s=10973.973/140, delay the gore rails until physical
clearance, and split transition-owned host/branch marking paths at the same
landmarks. No geometry outside P4 is authorized.

## Checkpoint contract

- Branch: `codex/progressive-merge-prototype`
- Base: `origin/main` at `e960f501776552cca3e46b911c7f46f684d45dfd`
- Scope: catalogue every same-level merge/diverge, define one shared phased
  transition model, and enable it for exactly four representative junctions.
- Non-goal: network-wide rollout. All other junctions must retain legacy
  behaviour during this checkpoint.

## Phase 0 — true baseline

The branch was created from a clean, freshly fetched `origin/main`. That base
contains the developer map (`DEV_MAP.md`, `js/dev-map.js`), the exact A–B
marking-opening model and cutter, boundary ownership, merge-local marking
finishing, and guardrail-opening/terminal fixes merged by PRs 21–23.

### Existing architecture and consumers

`HighwayMap._discoverJunctionMouths` derives branch/host/side/span records from
the runtime graph. `_prepareJunctionZones` evaluates the renderer-authoritative
mouth clip, refines the mouth-connected A–B component, and publishes shared
crossable, marking, and rail intervals. The existing consumers are:

- `_emitMouthDeck` / `_mouthClipAt`: visible paved union and surface clipping;
- collision and road-bound resolution: the same sampled surface corridor;
- `_queueRouteDetails`: route edge/divider clipping plus junction-owned dashes;
- `_computeBarrierVisibility` / `_buildRouteGeometry`: rail openings, ownership,
  tapered terminals, and the recorded `_railRuns` diagnostics;
- junction transfer/traffic graph creation: host/branch connectivity;
- developer map and minimap data: route polylines plus graph junction markers;
- A–B, marking, guardrail, finishing, lateral, surface, traffic and OSM probes:
  direct inspection of the same runtime records.

The existing zone is an authoritative *opening* model, but it does not model a
longitudinal process with approach/opening/parallel/absorption/finalized phases,
temporary lane topology, or an explicit progressive paved envelope. Those are
the architectural gaps this checkpoint addresses.

### Baseline validation (2026-07-16, Windows workspace)

Local test dependencies were restored with the repository-documented
`three@0.166.1` and `playwright` versions; dependency files remain ignored and
the source worktree was unchanged before this diagnostic commit.

| Check | Baseline result |
| --- | --- |
| A–B marking clipping | PASS; 56/56 exact openings, 112,605 strips, all violation counters 0 |
| Merge marking | PASS; 56 zones, all four counters 0 |
| Marking orientation | PASS; 0 diagonal pieces, 0 alternating runs, 0 chevrons on crossable boundaries |
| Merge guardrail | PASS; 52 convergence checks, worst 2.00 m, 0 opening crossings/gaps |
| Guardrail | PASS; 211 runs / 88 gaps, 0 unexplained, doubled, or inside-asphalt rails |
| Junction finishing | Known FAIL (6): five source-curve steering families plus `ramp_0` collision-height step |
| Lateral junction | PASS ratchet; 56 mouths / 20,185 points, 0 holes/steps/rails, 22 duplicate samples ≤ 60 |
| Road surface | PASS; build 6,350.8 ms, worst lateral 0.060 m, vertical 0.030 m |
| Traffic runtime smoke | PASS; 23 active after 20 s, finite sample, 5 meshes/vehicle |
| OSM validation | Known FAIL (329): rail 0, overlap 22, ramp-drive 247, smoothness 60, hygiene 0 |
| Performance | PASS; Node median 3,785.3 ms, browser build 3,706.3 ms, 1,005,534 scene triangles, 169 draw calls, frame p95 83.4 ms |
| Complete mobile e2e | PASS 34/34; no console errors |

### Known residual defects at the base

- Steering-rate source-curve kinks: `r6_0`, `ramp_18`, `ramp_21`, `ramp_27`,
  and `ramp_46` families.
- Collision-height mismatch: `ramp_0` / `r1_3` overlap family.
- OSM validation retains the documented 22 overlap, 247 ramp-drive, and 60
  smoothness failures.
- Lateral audit retains 22 duplicate-surface samples under its ratchet.
- PA access lanes remain deliberately disabled pending their separate rebuild.

None is silently reclassified as progressive-transition work.

### Baseline visual evidence

`.devtests/progressive-merge-shots.mjs` derives repeatable cameras from the
unchanged host/branch curves. The complete 16-image baseline set is in
`docs/progressive-merges/baseline/`. Representative views inspected directly:

- [elevated plan](docs/progressive-merges/baseline/one-to-two-merge-plan-baseline.png)
- [driving/chase](docs/progressive-merges/baseline/two-to-two-merge-chase-baseline.png)
- [close road marking](docs/progressive-merges/baseline/two-to-three-merge-marking-baseline.png)
- [guardrail side](docs/progressive-merges/baseline/right-diverge-guardrail-baseline.png)

The baseline still reads as intersecting or independently overlapping road
ribbons; it does not yet present a deliberate parallel carriageway followed by
lane absorption.

## Later phases

## Phase 1–2 — catalogue and representative selection

`.devtests/progressive-merge-audit.mjs` constructs the runtime map and walks the
same 56 authoritative junction zones used by rendering. Its deterministic
machine-readable output is `.devtests/progressive-merge-audit.json`; the full
readable table is [docs/progressive-merges/AUDIT.md](docs/progressive-merges/AUDIT.md).

Audit summary:

- 56 same-level graph connections: 27 merges, 29 diverges;
- 37 left-side and 19 right-side connections;
- 16 simple one-lane merges, 17 simple one-lane diverges, 11 multi-lane
  merges, and 12 multi-lane diverges;
- 22 curved but measurable/suitable cases;
- 4 manual-review cases, all excluded from the prototype allow-list:
  `J27` (`r6_0 -> ramp_18`), `J31` (`ramp_21 -> ramp_18`), `J36`
  (`r6_3 -> ramp_27`), and `J53` (`ramp_46 -> ramp_27`);
- `J36` and `J53` have only 72 m / 60 m available, while all four exhibit
  extreme local curvature or relative-tangent change. They are not forced
  through automation.

Every audit row retains host/branch lane counts and widths, side/type, transfer
tangent, maximum relative tangent, curvature, bank delta, transfer/opening/mouth
height deltas, existing A–B and rail openings, available combined width,
possible parallel/taper length, source quality, suitability, classification,
manual-review reason, and world coordinates.

### Exactly four selected prototypes

The single allow-list is `js/progressive-merge-prototypes.js`.

| Junction ID | Traffic route pair | Side | H/B lanes | World X, Y, Z | Selection reason |
| --- | --- | --- | ---: | --- | --- |
| `J8:merge:r11_0:ramp_1:end` | `ramp_1 -> r11_0` | left | 2/1 | `-1128.45, 73.04, -3825.43` | canonical 1→2 merge; only 20 m is currently crossable despite 136 m measured taper and 76 m parallel opportunity |
| `J0:merge:c1_0:c1_3:end` | `c1_3 -> c1_0` | right | 2/2 | `-897.45, 52.37, -2806.42` | equal-width multi-lane merge with 164 m taper / 128 m parallel opportunity and known baseline lane-centre wall-hit samples |
| `J10:merge:wangan_1:ramp_3:end` | `ramp_3 -> wangan_1` | left | 3/2 | `696.08, 29.71, -5832.86` | broad 2→3 motorway merge with 204 m taper / 172 m parallel opportunity |
| `J2:diverge:c1_0:r1_0:start` | `c1_0 -> r1_0` | right | 2/2 | `-1094.38, 57.33, -3014.18` | curved inverse case with 164 m taper / 120 m parallel opportunity; prevents a merge-only design |

The set deliberately spans left/right, merge/diverge, one-/two-lane branches,
two-/three-lane hosts, a constrained opening, a broad opening, and curved
geometry. No fifth connection is enabled.

## Phase 3 — one authoritative transition model

`js/progressive-merge.js` builds one record for each allow-listed zone after
the existing A–B zone has measured source geometry and before any route mesh is
built. The four records are exposed as `map.progressiveTransitions`, keyed by
`map.progressiveTransitionById`, and linked from the host, branch, and source
zone. `?legacyProgressiveMerges=1` (or `progressiveMerges: false` headlessly)
builds zero active records without changing any other junction.

Each record owns:

- ordered `approachStart`, `openingStart`, `parallelStart`,
  `absorptionStart`, and `transitionEnd` chainages;
- host/branch/temporary/final lane counts and explicit per-lane mappings;
- sampled lane-centre paths, surviving/absorbed/separated lanes, and boundary
  paths;
- a one-sided paved envelope using zero-slope quintic width easing, plus the
  legal crossable envelope;
- exactly one marking owner for every surviving, temporary, outer, or
  superseded boundary;
- the progressive guardrail envelope;
- automation status/manual-review reason and reversible prototype identity.

All four use one auxiliary lane because measured width supports that topology
cleanly without forcing every two-lane branch into a four-/five-lane permanent
carriageway:

- `J8`: 2 + 1 → temporary 3 → final 2;
- `J0`: 2 + 2 → temporary 3 → final 2;
- `J10`: 3 + 2 → temporary 4 → final 3;
- `J2`: inverse 2-lane diverge through temporary 3 → finalized 2-lane host.

`.devtests/progressive-merge-model-probe.mjs` passes: exactly four active and
zero legacy records; strict phase order; 136.6–203.4 m transition lengths;
continuous sampled lane paths; valid temporary/final counts; complete mapping
and ownership records; usable auxiliary width; and base width restored at both
ends.

## Phase 4–8 — geometry, lanes, markings, rails, and drivability

The allow-list records feed the existing map build once, before route meshes
are emitted. No topology is rebuilt per frame and no route-pair scan was added
to gameplay. The consumers now share the record as follows:

- road rendering reads its asymmetric `pavedEnvelope` and adaptive host frames;
- branch mouth clipping and vertical hand-off use the same host plane and
  quintic phase blend, removing coplanar ribbons and height lips;
- road lookup, collision bounds, swept wall collision, and route ownership use
  the same envelope and retain a branch corridor until the host can contain a
  full vehicle footprint;
- host and branch route painters yield their claimed paths to one transition
  owner, which paints the moving exterior solid and auxiliary dashed boundary;
- guardrails follow the progressive exterior, while the source rail is removed
  only for the phases in which the combined carriageway owns that edge;
- legacy gore hatching/cushions are omitted only in the four claimed auxiliary
  lanes because those areas remain drivable;
- all other junctions continue through the unchanged legacy zone consumers.

The implementation uses a zero-slope quintic envelope through all five phases.
The branch remains locally sourced; global route centrelines and vertical
crossings were not changed. `?legacyProgressiveMerges=1` restores legacy
behavior for identical-camera and user comparisons.

### Focused prototype gates

`.devtests/progressive-merge-probe.mjs` checks the shared model, pavement,
temporary lane paths/mappings, marking ownership, solid/dash alignment,
guardrail envelope, branch/host height hand-off, route ownership, and a 1 m
vehicle-footprint collision sweep. It passes all four cases:

| Prototype | Length | Max lane step | Max tangent step | Max width step | Height switch | Source-lane drive samples |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| P1 / `J8` | 136.6 m | 2.66 m | 2.19° | 0.60 m | 0.003 m | 69 |
| P2 / `J0` | 163.1 m | 2.89 m | 2.43° | 0.55 m | 0.001 m | 166 |
| P3 / `J10` | 203.4 m | 2.49 m | 1.66° | 0.49 m | 0.000 m | 206 |
| P4 / `J2` | 160.7 m | 2.99 m | 2.67° | 0.56 m | 0.002 m | 166 |

`.devtests/progressive-merge-drive.mjs` additionally drives the production
`VehiclePhysics` bicycle model, production surface sampler, and swept collision
adapter along each source lane at about 50 km/h. All four complete their full
132–200 m driven intervals with 0 collision events, 0 wall correction, and
0.10–0.14 m maximum lane-following error. Ownership changes exactly once:
`ramp_1 → r11_0`, `c1_3 → c1_0`, `ramp_3 → wangan_1`, and inverse
`c1_0 → r1_0`; no oscillation remains.

### Emitted-rail and collision invariants

The original guardrail probes classified a rail from route chainage alone: a
host rail overlapping a former mouth interval was assumed to remain on the
stable host edge and was therefore reported as interior. That became a false
positive for a progressive transition, where a rail legitimately remains at
the same chainage after moving laterally to the widened paved exterior.

The corrected invariant does not waive the opening check. The map records the
outer and base laterals of the parapet vertices actually emitted over the four
prototype host intervals. Both guardrail probes compare those emitted values,
including terminal squeeze, with the authoritative progressive paved envelope
to a 0.03 m tolerance. A rail left on the old host edge still mismatches the
envelope and fails; only a correctly relocated exterior rail passes.

A final broad regression also exposed a real P4 collision-height switch of
0.24 m. Rendering already applied the progressive branch-to-host deck offset,
but collision corridor and barrier suppression sampled the unblended branch
deck. The shared `_progressiveBranchDeckOffsetAt` helper now feeds rendering,
collision corridors, and barriers. P4's measured height switch is 0.002 m and
the finishing probe is back to exactly the six inherited baseline findings.

## Developer-map prototype pins

The four modified locations are pinned in the existing developer map as bright
magenta diamonds `P1`–`P4` in the read-only `progressive-prototype` hit
category. Press `M`, choose **Fit network**, hover a diamond to inspect its
junction ID, host/branch routes, merge/diverge type, side, lane counts, and
`prototype-enabled` status, then click the diamond itself to teleport safely to
the host transition. The info line confirms `4 pinned (P1, P2, P3, P4)`.

| Pin | Junction ID | Host | Branch | Type / side | H/B lanes | Status | World X, Y, Z |
| --- | --- | --- | --- | --- | ---: | --- | --- |
| P1 | `J8:merge:r11_0:ramp_1:end` | `r11_0` | `ramp_1` | merge / left | 2/1 | `prototype-enabled` | `-1128.45, 73.04, -3825.43` |
| P2 | `J0:merge:c1_0:c1_3:end` | `c1_0` | `c1_3` | merge / right | 2/2 | `prototype-enabled` | `-897.45, 52.37, -2806.42` |
| P3 | `J10:merge:wangan_1:ramp_3:end` | `wangan_1` | `ramp_3` | merge / left | 3/2 | `prototype-enabled` | `696.08, 29.71, -5832.86` |
| P4 | `J2:diverge:c1_0:r1_0:start` | `c1_0` | `r1_0` | diverge / right | 2/2 | `prototype-enabled` | `-1094.38, 57.33, -3014.18` |

The pins consume the same prototype selection/transition data as geometry;
there is no per-junction map presentation logic. The developer-map Playwright
smoke passes 33/33, including exact metadata, hover content, four direct pin
teleports, visible P1–P4 pixels, freeze behavior, route/elevation hit-testing,
phone minimap preservation, and no console errors.

The shared map is also reachable from the generic mobile utility controls via
the `DEV MAP` button. The same overlay supports safe-area-aware portrait and
landscape layouts, one-finger pan, two-finger pinch zoom, tap teleport, and its
existing Close control without a device-specific renderer or state path.

## Mandatory visual matrix and direct review

The final matrix contains 32 committed images: four cases × four camera types ×
legacy/progressive. Cameras use identical host phase chainages in both modes.

- [legacy matrix](docs/progressive-merges/final/legacy/)
- [progressive matrix](docs/progressive-merges/final/progressive/)
- P1: [plan](docs/progressive-merges/final/progressive/one-to-two-merge-plan-progressive.png), [chase](docs/progressive-merges/final/progressive/one-to-two-merge-chase-progressive.png), [marking](docs/progressive-merges/final/progressive/one-to-two-merge-marking-progressive.png), [guardrail](docs/progressive-merges/final/progressive/one-to-two-merge-guardrail-progressive.png)
- P2: [plan](docs/progressive-merges/final/progressive/two-to-two-merge-plan-progressive.png), [chase](docs/progressive-merges/final/progressive/two-to-two-merge-chase-progressive.png), [marking](docs/progressive-merges/final/progressive/two-to-two-merge-marking-progressive.png), [guardrail](docs/progressive-merges/final/progressive/two-to-two-merge-guardrail-progressive.png)
- P3: [plan](docs/progressive-merges/final/progressive/two-to-three-merge-plan-progressive.png), [chase](docs/progressive-merges/final/progressive/two-to-three-merge-chase-progressive.png), [marking](docs/progressive-merges/final/progressive/two-to-three-merge-marking-progressive.png), [guardrail](docs/progressive-merges/final/progressive/two-to-three-merge-guardrail-progressive.png)
- P4: [plan](docs/progressive-merges/final/progressive/right-diverge-plan-progressive.png), [chase](docs/progressive-merges/final/progressive/right-diverge-chase-progressive.png), [marking](docs/progressive-merges/final/progressive/right-diverge-marking-progressive.png), [guardrail](docs/progressive-merges/final/progressive/right-diverge-guardrail-progressive.png)

The images were inspected directly, not merely generated. The four progressive
views show a longitudinal approach/opening/parallel/absorption process instead
of a short intersecting ribbon; pavement and lane paths are continuous; the
temporary lane is readable; solid/dash paths meet without a lateral step; no
slash/backslash fragments or unrelated host-line crossings are visible; and
rails remain on the true exterior without a drivable-opening crossing. P1/P3
are deliberately subtle from high plan view because the branch surface is
properly absorbed into one widened host rather than left as an overlapping
ribbon; chase and marking views expose the temporary topology more clearly.

## Final regression comparison

Results below are from the final implementation unless identified as an
unchanged baseline failure.

| Check | Final result and baseline comparison |
| --- | --- |
| Progressive model + focused probe | PASS; exactly 4 active / 0 legacy; all geometry/topology/paint/rail/physics gates pass |
| Dynamic prototype drive | PASS; four full traversals, 0 collision events/corrections, no ownership oscillation |
| A–B marking clipping | PASS; 56/56 exact, 112,703 strips, every violation counter 0 (98 intentional prototype-owned strips over baseline) |
| Merge marking | PASS; 56 zones, all counters 0 |
| Marking orientation | PASS; 0 diagonal pieces, 0 alternating runs, 0 crossable-boundary chevrons; max lateral jump 0.15 m |
| Merge guardrail | PASS; 52 convergence checks, 0 opening crossings/gaps |
| Guardrail | PASS; 207 runs / 84 gaps, 0 unexplained/doubled/inside-asphalt rails; emitted progressive parapet laterals match the paved exterior; four legacy run/gap pairs replaced intentionally |
| Junction finishing | Known unchanged FAIL (6), exactly the six baseline source-curve/collision-height families |
| Lateral junction | PASS ratchet; exact baseline totals: 56 mouths, 20,185 points, 0 holes/steps/rails, 22 duplicate samples |
| Road surface | PASS; 40,046 surface / 17,644 render frames, worst lateral 0.060 m, vertical 0.030 m, dash phase errors 0 |
| Traffic runtime | PASS; 23 active after 20 s, finite position, 5 meshes/vehicle |
| OSM validation | Known FAIL improves 329 → 315: rail 0, overlap unchanged 22, ramp-drive 247 → 233, smoothness unchanged 60, hygiene 0; selected route pairs have 0 ramp-drive failures |
| Developer map | PASS 33/33 focused, including exact four-pin metadata, hover, direct teleport, and phone/touch preservation |
| Complete mobile e2e | PASS 41/41 at generic landscape and portrait touch viewports, including DEV MAP entry/pinch/pan/close; no console errors |

No non-prototype lateral, finishing, overlap, smoothness, rail, or hygiene
ratchet moved. The global OSM improvement is entirely the removal of selected
prototype wall-hit samples. Existing non-prototype OSM ramp-drive failures are
still out of checkpoint scope.

## Performance comparison

The final topology is precomputed during map construction. It adds no per-frame
network scan, no per-marking draw call, and avoids empty-array allocation in
the hot deck/rail helpers.

A same-machine `origin/main` worktree control was necessary because the current
host made the historical 4,000 ms Node threshold fail on the base itself:

| Metric | `origin/main` control | Prototype | Delta |
| --- | ---: | ---: | ---: |
| Node map-build median | 4,759.6 ms | 4,712.9 ms | −1.0% |
| Browser map build | 4,141.8 ms | 4,351.1 ms | +5.1% |
| Scene triangles | 1,005,534 | 1,005,178 | −356 |
| Stored triangles | 960,054 | 959,698 | −356 |
| Draw calls | 169 | 169 | no change |
| Frame p95 | 99.9 ms | 83.4 ms | −16.5 ms |

An earlier isolated repeat ranged to 5,062.9 ms Node / 4,741.0 ms browser,
confirming large host timing variance. The final performance script reports
FAIL only on its absolute 4,000 ms map-build threshold, which also failed on the
same-machine base control. The 169 draw calls now pass the 170-call ratchet;
geometry budgets and frame p95 remain inside limits, and mobile e2e passes.
Rechecking on the target evaluation hardware is recommended before any later
rollout decision.

## Checkpoint limitations and stop condition

- Traffic uses the existing graph/lane behavior; no progressive traffic-AI
  rewrite was attempted. The runtime smoke is clean, but final traffic lane
  choice through temporary lanes belongs to a later checkpoint.
- Four audit rows remain manual-review-only because of short/extreme source
  geometry (`J27`, `J31`, `J36`, `J53`); they were not forced through the model.
- The inherited six junction-finishing and 315 OSM findings remain documented;
  none is reclassified as fixed.
- The absolute 4,000 ms map-build threshold remains base-reproducibly red on
  this host despite the final prototype median being 1.0% faster than its
  same-machine base control; hardware timing variance remains an evaluation
  limitation.

Rollout is intentionally and verifiably limited to exactly four records in one
data-driven allow-list. No fifth junction is enabled, no network-wide rollout
has begun, and `legacyProgressiveMerges=1` remains the comparison/rollback path.
