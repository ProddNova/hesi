# Junction Finishing Checkpoint Status

- Date: 2026-07-15
- Branch: `claude/junction-merge-finishing`
- Base: `origin/main` at `6c1cf18`
- Pre-rescue branch head: `a830dd6`

## Checkpoint purpose

This is a rescue checkpoint of the junction-finishing work left in the
worktree after the previous session ended. It records the implementation as
found, the two narrow post-Phase-3 acceptance fixes, and the current validation
state. It is not a claim that every junction-finishing acceptance criterion is
complete.

No new visual-polish pass was started during the rescue. Vertical crossings,
global guardrails, PA access-road design, terrain, elevation, and the road
editor remain outside this checkpoint's repair scope.

## Preserved work

The branch already contained four ordered commits:

1. `fbae266` — diagnostic and representative before/after SVGs.
2. `5de90bf` — lane-aligned endpoint anchoring, plan-space trajectory blend,
   junction-zone records, and side-correct traffic lane mapping.
3. `3c16ba5` — zone-owned host edge suppression and dashed merge/diverge
   boundaries.
4. `a830dd6` — zone-driven visual rail ownership plus tapered/capped rail
   terminals.

The rescued uncommitted implementation adds:

- a second glue-line lead point in `_anchorEndpoint`, pinning the open
  Catmull-Rom endpoint tangent to the host direction; and
- host rail open/on boundaries tied to the same sampled envelope tip as the
  branch outer rail, removing the large equal-width hand-off gap.

The untracked focused probe and all six Phase-2/Phase-3 SVG outputs were also
preserved. The Phase-2 and Phase-3 SVGs are byte-identical to their matching
Phase-1 SVGs: the diagnostic SVG renderer does not draw the later
zone-controlled marking/rail behavior, so these files are milestone provenance,
not independent visual proof.

## What is complete

- The project remains a static browser application with no separate build
  step. The modified map and focused probe parse, `HighwayMap` constructs, and
  the full browser session boots and runs.
- Branch trajectories are anchored to the host lane grid. Current acceptance
  measurements show a worst transfer tangent mismatch of `2.73°` and worst
  sampled traffic hand-off excess displacement of `1.45 m`.
- The host/branch marking ownership mechanism is active. The focused probe
  finds zero solid host-edge stations across mergeable openings and zero
  duplicate-boundary stations.
- Zone rail ownership and visual terminal treatment are active. The rescued
  same-tip boundary fix reduces the measured worst host/branch rail hand-off
  to `2.0 m`.
- Existing lateral-junction surface, adaptive road-surface, traffic runtime,
  and end-to-end regressions remain green.

## What is partial or broken

The new `.devtests/junction-finishing-probe.mjs` runs but currently fails. It
reports `96` failures: `85` collision-height switches and `11` relative
steering-rate failures. The passing trajectory, marking, rail, and hand-off
metrics above therefore do not make the overall probe green.

The main unresolved mismatch is between representations:

- junction zones classify a row as continuous at up to `1.5 m` of branch/host
  deck-height difference;
- the rendered mouth union uses much tighter coplanar/apron thresholds
  (`0.18 m` / `0.35 m`); and
- asphalt and traffic still consume mouth/edge records rather than the zone
  object directly.

As a result, `getRoadInfo` can switch between branch and host deck candidates
inside a zone called crossable. The worst sampled switch is `2.228 m`. Fixing
this coherently requires reconciling zone, rendered-surface, and physics
semantics; changing route heights would enter the explicitly excluded
elevation/vertical-crossing scope.

Other remaining issues found by the audit:

- relative steering reaches `34.4°/8 m` in the Hakozaki
  `ramp_46`/`ramp_27` data-kink family, with smaller `4.7–5.6°/8 m` outliers
  elsewhere;
- a zone range currently stores one min/max interval, so disjoint qualifying
  samples can suppress markings or rails across an intervening non-qualifying
  span;
- the focused probe's header and executable contract differ: the transfer,
  zone-angle, and steering thresholds described in prose are not the exact
  gates in code; the zone angle is report-only, and the diverge hand-off check
  samples geometry rather than exercising `advanceTraffic`;
- the probe includes service/PA collision samples even though PA access-road
  work is out of scope; and
- Phase 3's already-committed terminal taper is route-generic and can affect
  non-junction visibility boundaries. The rescue did not broaden or redesign
  that behavior.

These items are documented rather than repaired here because they require a
new design pass or enter prohibited scope. The checkpoint stops before that
work.

## Validation results

| Check | Result | Evidence |
| --- | --- | --- |
| JavaScript syntax / map construction | PASS | Modified map and focused probe parse; map constructs without an exception |
| Junction-finishing probe | **FAIL** | 58 zones, 67 transfers, 96 failures; tangent `2.73°`, steering `34.4°/8 m`, rail hand-off `2.0 m`, collision switch `2.228 m`, transfer excess `1.45 m` |
| Lateral-junction probe | PASS | 58 mouths / 20,636 points; 0 holes, 0 steps, 0 rails, 25 duplicate pairs (`<= 60` ratchet) |
| Road-surface probe | PASS | Worst refinable angle `0.7499°`, vertical error `0.02977 m`, lateral error `0.05998 m`, 0 dash-phase errors |
| Traffic test | PASS (runtime smoke) | 20 simulated seconds, 23 active vehicles, finite sampled position; the script has no assertions |
| `osm-validate` | **EXPECTED FAIL** | Rail 0, overlap 23, ramp-drive 44, smoothness 60, geometry hygiene 0; 127 known failures in existing vertical/elevation families |
| End-to-end | PASS | 25/25 checks, including boot and no console errors |

`osm-validate` was run against a hash-verified temporary copy because failure
output overwrites a tracked artifact. Its fresh 127-line output is now stored
in `.devtests/osm-validate-failures.txt`. Compared with the rescued stale
snapshot, ramp-drive improves from 45 to 44 and smoothness from 61 to 60;
there is no new validator section or failure family.

## Remaining work after this checkpoint

1. Define one authoritative notion of a physically crossable/rendered junction
   seam and make zones, mouth geometry, physics, and traffic consume it.
2. Represent disjoint zone ranges as interval pieces or select only the
   mouth-connected component.
3. Reconcile the focused probe's documented and executable contract, including
   explicit out-of-scope ratchets/exclusions.
4. Resolve steering and height-transition failures in a separately authorized
   pass that can address vertical/elevation data where required.

No further visual polishing is included in this checkpoint.
