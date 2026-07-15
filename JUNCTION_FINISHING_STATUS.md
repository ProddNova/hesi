# Junction Finishing Checkpoint Status

- Date: 2026-07-15
- Branch: `claude/junction-merge-trajectory-edn20k`
- Base: `origin/main` at `6c1cf18`, continuing `claude/junction-merge-finishing`
  from checkpoint `7f10cfc`

## Phase 4: one authoritative crossability (this checkpoint)

The `7f10cfc` checkpoint left the focused probe at 96 failures. Classification
against the actual geometry showed one generic root cause behind 85 of them
(collision-height switches across ~44 junctions): three subsystems each had
their own notion of "these decks are one surface":

- junction zones re-derived continuity as `|dy| < 1.5 m`;
- the rendered mouth union merges decks only inside its coplanar strip
  (`|dy| < 0.18`) / apron (`0.35`) rules; and
- physics (`getRoadInfo`) scored whole-deck corridors with no knowledge of
  the drawn union at all.

The same too-loose zone interval also drove `hostEdgeSuppress`, `dash` and the
rail openings, so paint and rails were reconfigured across stations where the
renderer draws two separate decks. The remaining 11 failures were
steering-rate outliers in the documented route-data kink families.

### What changed

All changes derive every consumer from the renderer's own mouth-clip decision:

1. `_mouthClipAt` now exposes its removed (coplanar, host-covered) strip and
   an overlap gauge (covered band + endpoint dy/lateral lines) on the frame.
   Its apron path also no longer swallows STRADDLING sections (a branch wider
   than its host, e.g. `ramp_46` over `ramp_27`): those fall through to the
   exact covered-strip clip, which removes a previously z-fighting full-width
   coplanar ribbon (lateral-junction duplicate pairs: 25 → 22).
2. Junction-zone rows store the clip's verdict (`merged`, `removed`,
   `covered`, `dyEnds`, `crossOuter`). Row crossability = a removed strip
   exists AND the crossing band (covered laterals on the zone's side of the
   host centreline) stays under the renderer's one-level band (0.35 m). The
   one-surface union extent `crossOuter` stops at the host edge when the wing
   has already peeled above / dived below it. Zone intervals (`crossable`,
   `hostEdgeSuppress`, `dash`, rail openings) now come from the
   MOUTH-CONNECTED component of crossable rows, so a disjoint qualifying
   stretch further out can no longer smear markings across a non-crossable
   span.
3. Physics surface ownership (`_surfaceDefersToHost`, consulted by
   `_corridorsAt`): inside the host-covered band, a branch corridor defers to
   the host wherever its deck is at/below the host's top surface (removed
   strip, buried sheet) or hovers within the one-level band on a
   partially-merged section (ghost slivers). A full-width ribbon above the
   host is a real second deck and keeps its corridor. Physics therefore rides
   the same deck the renderer draws — chase screenshots at the `ramp_12` gore
   now resolve the district as the HOST (`ROUTE 1 HANEDA`), not the ramp.
4. The focused probe reads `row.crossable`/`row.crossOuter` (the shared zone
   record) instead of re-deriving `|dy| < 1.5`; every gate value is unchanged.
   The diagnostic's marking summary reads the same records.

### Probe result: 96 → 6

`zones=58 transfers=67; transfer tangent 2.73°, steering 5.5°/8m (data-kink
families excluded below), rail hand-off 2.0 m, collision step 0.33 m max at
the one excluded station, transfer excess 1.45 m.`

All 6 remaining failures are in families documented as outside this pass:

- 5 steering-rate outliers (`r6_0` 4.7°, `ramp_18`/`ramp_21` 5.5°, `ramp_27`
  7.0°, `ramp_46` 28.0° per 8 m): route-data kinks needing the excluded
  extractor/vertical pass.
- 1 collision step (`ramp_0` on `r1_3`, 0.33 m): the flip is `r1_3 → r1_0`,
  i.e. the known overlapping-carriageway height-disagreement family
  (`osm-validate` "overlap"), not merge semantics.

### Representative junctions (required by the phase)

- LEFT MERGE `ramp_42 → k1_0`: crossable 790..894, dashed boundary and edge
  suppression 794..808 over the true coplanar widening, host rail hand-off
  792..816 against the branch tip; traffic transfer excess 0.02 m; collision
  walk flat.
- RIGHT MERGE `ramp_12 → r1_3`: crossable 13181..13247 (the genuinely
  coplanar approach). The long funnel beyond is honestly closed: the ramp
  deck oscillates +0.38 → −1.35 m against the host there (vertical-profile
  data defect), so the previous 341 m "crossable" interval, its dashes and
  its rail opening were painting over real 0.3–1 m steps.
- RIGHT DIVERGE `c1_0 → ramp_22`: crossable 1088..1257 with the gore wedge
  physics-flat (deferral); openings stay closed because the exit wing
  genuinely leaves 0.25–0.7 m BELOW the host edge (same data family; needs
  the deck-attitude/height blending pass).

## Validation results

| Check | Result | Evidence |
| --- | --- | --- |
| Junction-finishing probe | 6 failures (was 96) | all six in documented-excluded families above |
| Lateral-junction probe | PASS | 58 mouths / 20,636 pts; 0 holes, 0 steps, 0 rails, duplicates 22 (was 25, ratchet 60) |
| Road-surface probe | PASS | refinement + dash phase, 0 errors |
| Traffic runtime smoke | PASS | 20 s, 23 active vehicles, finite positions |
| End-to-end | PASS | 25/25, no console errors |
| Performance | no regression | base `7f10cfc` fails build/p95 limits identically on this container; draw calls within documented run noise (168 vs 170 limit) |
| Screenshots | inspected | identical-camera before/after pairs for 7 junction cases (`.devtests/shots/*-{before,after}.png`); no visual regressions; gore district resolution now host-side |

## Remaining work after this checkpoint

1. Deck-attitude/height blending through mouths (bank/vertical), so
   merge/diverge wings hold the host's surface until clear: this is what
   keeps `ramp_12`'s funnel and `ramp_22`'s exit wedge from being paintable
   as crossable, and it owns the residual steering-kink families
   (`r6_*`, `ramp_46`). Requires the separately-authorized vertical pass.
2. Overlapping-carriageway height disagreements outside junction mouths
   (`r1_0`/`r1_3` family) — same vertical pass.
3. Probe-contract reconciliation (explicit out-of-scope ratchets for the two
   families above) if the probe should gate CI before that pass lands.

Vertical crossings, global elevation, PA access-road design, terrain, global
guardrails and the road editor remain untouched, as required.
