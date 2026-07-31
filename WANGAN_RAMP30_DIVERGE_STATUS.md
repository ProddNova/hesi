# Wangan Bayshore → Ramp 30: progressive diverge (P4)

`J38:diverge:wangan_0:ramp_30:start` — the Wangan exit onto ramp 30. It is the
**exact inverse of P3** ([TATSUMI_RAMP8_MERGE_STATUS.md](TATSUMI_RAMP8_MERGE_STATUS.md))
on the same three-lane carriageway: instead of a ramp arriving on two lanes
appended outside the mainline and being closed one at a time, the mainline
**opens** two appended lanes one at a time and the ramp leaves on them.

Nothing here is hand-placed. Every landmark is the merge's own measurement,
taken on the branch rows in reverse order.

## The model

Same allow-list, same record shape, new topology tag `3+2-diverge`
(`js/progressive-merge-prototypes.js`, `js/progressive-merge.js`).

| | 2+3 merge (P3) | 3+2 diverge (P4) |
| --- | --- | --- |
| branch anchor | `appended` — arrives outside the paved edge | `appended` — leaves from outside the paved edge |
| handoff measurement | branch centre **descends onto** the slot centre | branch centre **rises off** the slot centre |
| opening measurement | branch pavement edge crosses the outer lane line inward | …outward |
| stage length | the run in which the branch moves one lane width | identical, measured on the departure |
| stages | FULL 5 → 5→4 → four-lane → 4→3 | 3→4 → four-lane → 4→5 → FULL 5 |

`branchAnchor: 'appended'` now applies to a diverge too
(`_progressiveAppendedBranch`, js/map.js): the head of ramp 30 is glued to
`side * (host.lanes + branch.lanes) * laneWidth / 2` = 8.875 m — the centre of
the two appended slots — instead of the host-lane glue line at 1.775 m. Without
it the ramp would start on the Wangan's own outer lanes and the exit would again
be a diagonal cut across the mainline.

## Measured result

Stage length **69.1 m** (a 1:19 taper), derived from ramp 30's own departure:
4.13 m of lateral drift over 80.3 m.

| Event | Host s on `wangan_0` |
| --- | ---: |
| approach (record start, plain three lanes) | 2928.1 |
| 3 → 4 taper starts | 2997.2 |
| stable 4 | 3066.3 |
| 4 → 5 taper starts | 3135.3 |
| FULL 5 — both appended slots established | 3204.4 |
| *(ramp 30's own centreline begins)* | *3235.2* |
| exit pair leaves the slots / gore begins | 3273.5 |
| plan, paint and deck ownership fully with the branch | 3294.1 |
| separating parapets resume (0.90 m measured clearance) | 3335.9 |
| record end | 3353.8 |

276 m of widening in four geometry-derived 69.1 m stages, then an 80 m
departure. Transition length 425.7 m.

The widening deliberately starts 307 m before ramp 30's own geometry exists.
That stretch is pure host pavement: the deceleration lanes open before the gore,
which is what the mirror of "the merge closes its lanes after the ramp ends"
actually means.

## What each boundary does

Lateral is signed on the host, side = left (−).

| Station | inner (dashed) | divider (dashed) | outer (solid) | paved edge |
| --- | ---: | ---: | ---: | ---: |
| before 2997.2 | — | — | −5.88 | −6.62 |
| stable 4 (3066–3135) | −5.32 | — | −9.43 | −10.17 |
| FULL 5 (3204–3273) | −5.32 | −8.88 | −12.97 | −13.72 |
| 3294.1 (handover) | ramp edge line | ramp divider | ramp edge line | ramp's own |

- The **divider** between the two exiting lanes is painted only from 3135.3,
  where `aux:1` actually starts opening. Before that it is coincident with the
  outer edge and would have been a doubled line — the same rule that retires
  P3's first-absorption divider at `firstAbsorptionEnd`, read backwards.
- The **outer solid** sits 0.75 m inside whichever paved edge owns it: the
  widened host deck's (shoulder 0.55 m), blending to ramp 30's own (0.20 m)
  across the departure.
- At 3294.1 the transition hands the hostward edge and the divider to ramp 30's
  own painters; the mainline's normal edge line resumes past the gore nose
  (`hostEdgeSuppressInterval`). The gore-side solid over the junction's own
  marking opening stays transition-owned (`progressiveBranchGoreEdge`), because
  the generic A–B rule refuses to paint anything there.

## Rails

Mirror of P3's rail release. The host parapet rides the widening out to the
handoff and releases on its last emitted frame at or before it; ramp 30's outer
parapet picks the same edge up on its first frame beyond that (measured handoff
gap **2.52 m**, zero doubled rails). Both stay released through the gore and come
back at 3335.9, the station where the two paved edges are 0.90 m apart — the
width two 0.42 m-inset parapets need.

Releasing exactly on the analytic station instead cost a whole frame and opened
a 7.8 m hole; holding one frame past it produced a 0.4 m doubled wall. The
frame-paired release is the only version that does neither.

## Verification

Green: `progressive-junction-classification-probe` (P4 admitted on its own
evidence — `same-level-simple`, continuous deck to lateral separation, 80 m
planar overlap), `progressive-merge-probe --live` (P4 clean: 425.7 m,
lane step 2.59 m, tangent 1.13°, width step 0.12 m, height switch 0.054 m,
122 drive samples, 0 collisions), `guardrail-probe` (0 unexplained, 0 doubled,
0 inside-asphalt), `merge-guardrail-probe`, `road-surface-probe`,
`lateral-junction-probe` (0 holes/steps/rails), `marking-orientation-probe`,
`merge-marking-probe`, `merge-arrow-probe`, `traffic-test` (23 active,
0 events), `editor-build-ops-probe`, `dev-map-test` **33/33**,
`protected-road-segment.test.mjs` 5/5.

`junction-finishing-probe` improves **27 → 26**: the two ramp 30 collision-height
steps (0.41 m and 0.53 m) are gone, replaced by one traffic-transfer
displacement finding — see the limitation below.

`ab-marking-clipping-probe` is unchanged at its inherited 7 findings while
emitting 371 more strips; `progressive-merge-probe` (legacy flow) and
`progressive-merge-model-probe` keep exactly their pre-existing failures
(J48 branch paint ×4, P1 geometry digest), verified by running both against a
stashed tree.

Three probe assertions were restated, none relaxed:

- `progressive-merge-probe` graded a diverge's route-local branch paint against
  "anywhere inside the record" and its marking endpoints against the last
  sampled station. Both now use the transition's own declared handover — which
  for P1 *is* the last station, so its verdict is unchanged. It also gained a
  new check that the paved union never opens a hole while the exit is handing
  over.
- `merge-guardrail-probe` paired the host's *last* exterior rail sample with the
  branch's first. A diverge whose parapet legitimately returns downstream of the
  gore made that pair 74 m apart. It now pairs the last host sample **before**
  the branch takes over, and grades the "still one lane wider" rule at the
  handoff station rather than at the record's end.
- `dev-map-test` expects the live-flow pin set `P3, P4`.

Visual: `node .devtests/ramp30-diverge-shots.mjs [--legacy]` writes eleven fixed
cameras (`RD-*`) at the measured stations, in both modes. The 4-lane, 5-lane and
gore chases and the two driver's-eye frames were inspected directly: continuous
deck, one line per boundary, barrier on the moving exterior, readable gore.

## Known limitation

Traffic still hands off with the graph's lane mapping, exactly as at ramp 8. An
AI car taking the exit transfers from the Wangan's outer lane to ramp 30 with a
3.21 m lateral step (`junction-finishing-probe`), inside `MAX_BLEND_OFFSET`, so
`traffic.js` glides it out — but the AI does not drive the appended five-lane
section. Player physics is unaffected: it follows the rendered surface and
collision, both progressive-owned.

Horizontal signage is **not** mirrored. P3 paints 合流注意 and lane-change arrows
into the lanes it is about to take away; the equivalent exit signage (route
number, destination, exit arrows in the two opening lanes) is not implemented
here — the geometry, markings, rails and collision are.
