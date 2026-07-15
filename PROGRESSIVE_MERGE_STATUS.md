# Progressive Merge Checkpoint Status

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

The geometry/physics/marking/rail consumers, legacy/progressive image matrix,
performance comparison, limitations, and developer-map pin instructions will
be appended as the remaining phases land.
