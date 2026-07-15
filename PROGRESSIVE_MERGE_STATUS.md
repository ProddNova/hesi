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

The deterministic audit, four selected records, architecture, prototype test
results, legacy/progressive image matrix, performance comparison, limitations,
and developer-map test instructions will be appended here as each coherent
phase lands.
