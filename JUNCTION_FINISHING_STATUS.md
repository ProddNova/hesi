# Junction Visual Finishing Status

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
