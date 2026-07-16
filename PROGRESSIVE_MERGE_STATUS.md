# Progressive Merge Checkpoint Status

## Corrected P1/P2 final state (2026-07-16)

This section supersedes the historical checkpoint record below.

| Pin | Junction | Topology | Runtime |
| --- | --- | --- | --- |
| P1 | `J2:diverge:c1_0:r1_0:start` | preserved 2+2 progressive diverge | active; geometry digest unchanged from successful old P4 |
| P2 | `J48:merge:wangan_1:ramp_41:end` | two-lane `ramp_41` + three-lane `wangan_1` → 5 → 4 → 3 | active; lower same-level deck explicitly approved |

The developer map contains exactly `P1,P2` (`2 active · 0 deferred`). Every
old P1/P2/P3 prototype/deferred marker is removed, and the successful old P4
is relabelled P1 without changing its pavement, lanes, markings, rails, or
collision geometry.

P2 preserves all three `wangan_1` lanes. `ramp_41` lane 1 maps to `aux:0`
and is absorbed second into the outer host lane; ramp lane 0 maps to `aux:1`
and is absorbed first into `aux:0`. The measured phase stations are:

- full five-lane section: `30977.909–31009.710` m;
- 5→4 absorption: `31009.710–31053.932` m;
- stable four-lane section: `31053.932–31068.839` m;
- 4→3 absorption: `31068.839–31113.061` m;
- final host: three unchanged 3.55 m lanes.

The shared transition record owns the one-sided paved envelope, both temporary
lane mappings, two sequential absorption boundaries, route/transition paint
handoffs, exterior guardrail handoffs, branch-to-host deck blend, and collision
corridor. Production vehicle-physics traversal passes from both ramp lanes with
zero collisions and zero wall correction. Visual evidence is in
`docs/progressive-merges/p2-j48/`.

Focused gates: progressive model PASS; geometry/paint/rail/collision PASS;
both-lane dynamic drive PASS; guardrail PASS; P1 geometry digest
`2779a9ef94a8b556d0a3d85e2493dbc474dc2c8fd4351303b5d797524f88d0a0`.

## Historical Checkpoint 2 record

Checkpoint 2 supersedes the Checkpoint 1 eligibility conclusions below while
retaining its implementation history and visual evidence. The candidate set is
the former P1–P4 set described at that point in history; it is no longer the
runtime pin configuration.

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

**Phase B handoff (completed in Phase C):** implement the source-derived P4 lane-0
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

**Phase C handoff (completed in Phase D):** transfer outer rail ownership from the
host to the branch at s=10973.973/140, delay the gore rails until physical
clearance, and split transition-owned host/branch marking paths at the same
landmarks. No geometry outside P4 is authorized.

### Phase D complete — emitted ownership, markings, and guardrails

The remaining paint defect was an emission-order problem, not a missing path.
Branch-owned progressive paint was invoked while the host route was being
dressed; world construction is sequential, so `r1_0.surfaceFrames` did not yet
exist and those strips silently emitted no geometry. Branch paint now remains
owned by the same progressive record but is emitted from the branch dressing
loop, after its authoritative deck frames exist. Route-local host and branch
paint is clipped for the full claimed A–B interval.

The host solid exterior line, temporary dashed boundary, branch divider and
post-transfer gore edge consequently use one pair of transition paths. The host
solid no longer survives into the secondary carriageway, branch paint begins on
the same path, and no slash/backslash fragment or retained route-local crossing
is present.

The query-only P4 ownership overlay grades geometry actually emitted, rather
than nominal configuration:

- red/green/yellow are host, branch and transition paint;
- magenta is illegal retained paint;
- blue/orange/white are host, branch and shared rail spans;
- bright red is a rail/wall inside the drivable opening;
- cyan is an unexplained rail gap.

The guardrail probe was corrected at the same time. Its old chainage-only rule
reported any host rail inside the former mouth interval as interior, even when
the rail had moved laterally to the widened paved exterior. The corrected
invariant compares the actual emitted parapet outer/base vertices (including
terminal squeeze) with the authoritative progressive envelope. A rail on the
old interior host edge still fails; only a rail at the relocated exterior
passes. Commits `85d7f86` and `b3aee3e` contain the production ownership fix and
its emitted-geometry diagnostics.

### Phase E complete — P4 auxiliary-width visual correction

> Historical note: Phase F below supersedes Phase E's conclusion that one
> temporary exit lane was sufficient. Direct 2+2 ownership inspection proved
> that conclusion topologically wrong even though the one-lane width probe
> passed.

Direct ownership-view inspection exposed a second, narrower P4 defect: the
physical lane existed, but its two transition markings read as a pinched strip.
The measured root cause had two parts:

1. the host half-width already includes its 1.30 m shoulder, but the widening
   added `laneWidth + shoulder` again. That produced a 4.85 m envelope increase
   and left 2.60 m of dead pavement outside the solid line;
2. transition paint was copied directly from the 3.55 m physical lane
   boundaries. Normal outside lanes are read from their divider to an edge line
   0.75 m inside the paved edge, which is 4.10 m here. P4 therefore looked
   0.55 m (13.4%) narrower than the adjacent host/branch lanes.

The shared record now adds exactly one 3.55 m lane to the existing host
envelope. The outer marking sits 0.75 m inside that corrected paved edge. Once
the lane is usable, its physical boundaries stay 3.55 m apart while its
markings stay 4.10 m apart. During ownership transfer the same 0.55 m marking
shoulder moves continuously from the host-exterior side to the branch-hostward
edge; no width is lost or gained. The final targets are the real `r1_0:0`
divider and outside edge line, not cosmetic offsets from the host road.

The corrected source-derived landmarks are:

| Event | Host s | Branch s |
| --- | ---: | ---: |
| Lane becomes fully usable | 10888.887 | — |
| Exterior/paint/rail handoff begins | 10966.006 | 130.958 |
| Physical source-deck split | 10988.871 | 153.907 |
| Full lane ownership transfer / gore allowed | 10998.160 | 164.000 |

The host solid ends at the measured exterior handoff. The branch-owned divider
dash begins there with an aligned dash phase, reducing the real solid-to-dash
handoff from the failing 10.412 m gap to 0.777 m. The post-transfer outside edge
is already at its normal 4.10 m lateral, so there is no dashed-to-solid lateral
settle. The host rail terminal is retained through the first real surface frame
after analytic ownership handoff; this removes the discretisation hole while
remaining outside the auxiliary corridor. The emitted rail handoff measures
1.80 m in the visual overlay (2.00 m in the independent convergence probe),
with no interior rail/wall and no unexplained gap.

One temporary auxiliary lane is sufficient. `aux:0` remains one 3.55 m
drivable corridor and feeds the actual `r1_0:0` centre/boundaries; `r1_0:1`
forms as the second branch lane. A second P4-only temporary lane was evaluated
but was not required, because the pinch was the duplicate-shoulder/edge-marking
model rather than missing 2→2 topology.

The strengthened P4 gate does not accept the new output by relaxing the old
assertion. It now separately requires:

- minimum physical corridor width 3.40 m (measured 3.55 m);
- minimum marked width 4.05 m after usability (measured 4.10 m, maximum error
  0.012 m);
- consecutive cross-section overlap positive (minimum 0.586 m);
- zero paved-envelope retreat, premature closure, pavement hole, collision
  correction, intrusive rail, or intrusive wall;
- exact real-branch centre/boundary/edge-line endpoints (all endpoint gaps
  0.000 m);
- conserved 0.55 m marking-shoulder budget and exact 0.75 m paved-edge inset;
- bounded emitted paint handoffs using their real dash off-lengths.

Phase E commit: `66560eb` (`Widen P4 auxiliary transition corridor`), pushed to
`origin/codex/progressive-merge-prototype`.

### P4 Phase E visual evidence

The same repository camera fixtures were used before and after. Both standard
and ownership-coloured matrices are committed:

- [before width correction](docs/progressive-merges/checkpoint-2/before-width-fix/)
- [after width correction](docs/progressive-merges/checkpoint-2/after-width-fix/)
- [measured high plan overlay](docs/progressive-merges/checkpoint-2/after-width-fix/p4-corridor-debug-after-width-fix.png)

The measured overlay exposes the auxiliary centre, both physical boundaries,
real `r1_0:0` centre/boundaries, full-path width samples and ownership marker;
its legend distinguishes the 3.55 m physical width from the 4.10 m marked
width. Plan, chase, close-marking and guardrail-side views were inspected
directly. No abrupt ribbon intersection, pavement kink, marking step, long
unexplained gap, unrelated-lane crossing, slash fragment, blocking rail,
collision-height switch, invisible wall or undrivable hole was observed.

### Phase E validation and honest limits

| Check | Result |
| --- | --- |
| P4 hard continuity / shared model / shared integration | PASS |
| Dynamic P4 drive | PASS; 160.1 m, 0 collisions/corrections, 0.12 m max lane error, one `c1_0 → r1_0` ownership change |
| A–B clipping / merge marking / marking orientation | PASS; every ownership violation counter 0, no diagonal strips |
| Road surface | PASS; worst lateral 0.060 m, vertical 0.030 m, dash phase errors 0 |
| Merge guardrail / guardrail | PASS; 1 exterior ownership transfer, 0 opening crossings, unexplained gaps, doubled rails or inside-asphalt rails |
| Traffic smoke | PASS; 23 active after 20 s, finite positions |
| Developer map | PASS 34/34; exactly P1–P4, full metadata and teleport |
| Mobile e2e | PASS 41/41; shared DEV MAP works in landscape/portrait with pinch/pan/close |
| Junction finishing | Known unchanged FAIL (6); P4 absent |
| Lateral junction | PASS ratchet; P4 has 0 holes/doubles/steps/rails |
| OSM validation | Known global FAIL 327 = 22 overlap + 245 ramp-drive + 60 smoothness; P4 absent. Restoring legacy behavior on invalid vertical P1–P3 restores 12 of their baseline wall-hit samples; no probe was weakened |
| Network test | Global test remains red on its unrelated 70–95 km expectation (network is 206.8 km) and stale `dj` alias lookup; file was not changed in this P4 pass |
| Performance | Only absolute Node build ratchet fails: 4111.9 ms vs 4000 ms. Browser build 3928.1 ms, 168 draw calls, 1,005,384 triangles, p95 83.3 ms, 0 errors |

No P4 geometry or collision blocker remains. The only P4-specific manual
follow-up is subjective player-speed confirmation of the now-measured visual
rhythm; the fixed chase/marking views and production traversal are clean. The
1.80 m rail handoff is an intentional pair of ramped terminals rather than a
continuous full-height rail or an unexplained hole. P1–P3 remain untouched in
legacy mode as vertical/split-level manual-review cases, P5 remains disabled,
and no network-wide rollout or merge to `main` is authorized.

### Phase F complete — P4 corrected from 2+1 to 2+2

Phase F is the current P4 result and supersedes the one-lane topology described
in Phases C–E. The user's diagnosis was correct: the old model created only
`host:0`, `host:1`, and `aux:0`, then mapped `aux:0` to `r1_0:0` while allowing
`r1_0:1` to form independently. Consequently the old `aux-outer-marking`
terminated at branch lateral 0 and changed semantic role from the outer solid
edge into the branch centre divider. This was a real 2+1 topology error, not a
cosmetic paint-offset error.

#### Exact P4-only topology and envelope fix

`J2:diverge:c1_0:r1_0:start` is now explicitly tagged `2+2-diverge` and has:

- two continuing centres, `host:0` and `host:1`;
- two exiting centres, `aux:0 -> r1_0:0` and `aux:1 -> r1_0:1`;
- four temporary lanes total and a 7.10 m host-side widening;
- three exit boundaries: host/exit inner boundary, exit-lane divider, and exit
  outer boundary;
- a rigid two-lane exit cross-section whose two lane widths remain exactly
  3.55 m while its centre and outward direction rotate into the real branch;
- exact endpoint ownership on branch laterals +3.55 / 0 / -3.55, with the
  two centres on +1.775 / -1.775.

The widening becomes fully usable at host s=10888.887. The two-lane carriageway
begins steering during the existing absorption phase at s=10946.737, while the
widened host still owns its pavement. Exterior ownership transfers only when
the measured source union supports the full 7.10 m, at host/branch
s=10980.270/146.042. Full branch ownership and gore permission remain at
host/branch s=10998.160/164.000. No arbitrary extension distance is used.

#### Transition-owned marking correction

The old route-split painter exposed another real consequence of the incorrect
topology. With the 7.10 m cross-section, part of the authoritative outer line
lies on the host/branch paved union while being outside either individual
route ribbon. Two independent painters therefore left a measured 7.321 m
solid-line gap. P4 now paints its three deck-conformed world paths directly as
one transition owner:

- the outer solid remains 0.55 m outside the physical outer exit boundary and
  ends on the real `r1_0` outer edge line at -4.10 m;
- the exit divider remains between `aux:0` and `aux:1` and ends on branch
  lateral 0;
- the host/exit dashed separator ends on the branch hostward edge before the
  post-transfer gore solid assumes ownership.

The emitted-path deviation is 0.000 m. The outer-solid-to-route gap is 0.476 m,
the inner-dash-to-gore gap is 0.002 m, the intentional divider dash off-span is
8.665 m, and the gore-to-route solid gap is 1.491 m. No route-local paint
survives the transition claim, no cross-section changes line order, and no
marking sample leaves the paved union.

#### Guardrail invariant and handoff

The earlier chainage-only guardrail probe was a false-positive design because
it assumed any host rail inside a former mouth interval remained on the old
host edge. The corrected invariant still rejects an interior rail: it compares
the outer/base vertices actually emitted with the authoritative progressive
paved envelope (including terminal squeeze), then independently intersects
those vertices and collision-wall spans with every drivable 2+2 cross-section.

The new two-lane path also exposed a genuine rail intrusion: retaining the
first host surface frame *after* analytic handoff put the terminal 0.36 m into
the outer exit lane. The host rail now releases on the last emitted frame at or
before ownership handoff. The first branch-exterior rail then begins 1.429 m
away on the same paved exterior. Results are 0 envelope error, 0 intrusive rail
vertices, 0 intrusive wall spans, 0 blocked-opening markers, and 0 unexplained
gap markers. A rail across drivable pavement still fails; only an exterior rail
matching the progressive envelope passes.

#### Phase F visual evidence

All four fixed cameras were captured before and after with identical fixtures,
both normally and with emitted ownership colours:

- [2+1 failing before matrix](docs/progressive-merges/checkpoint-2/before-2plus2/)
- [2+2 corrected after matrix](docs/progressive-merges/checkpoint-2/after-2plus2/)
- [measured 2+2 plan overlay](docs/progressive-merges/checkpoint-2/after-2plus2/p4-corridor-debug-topology-after-2plus2.png)
- [hard-gate metrics](docs/progressive-merges/checkpoint-2/P4-AFTER-2PLUS2.json)

Elevated plan, normal chase, close marking, guardrail-side, and measured overlay
views were inspected directly. The after views show four lanes in the shared
section, two readable exit lanes, an outer solid which stays outside the exit,
two non-crossing dashed separators, and a clean rail opening. The ownership
overlay reports 0 magenta retained markings, 0 bright-red blocked openings,
0 cyan unexplained gaps, and a 1.43 m rail handoff.

#### Phase F regression result

| Check | Result |
| --- | --- |
| Classification / model / shared integration | PASS; exactly P4 active, P1–P3 deferred; temporary 4, final 2 host + 2 branch |
| P4 hard 2+2 gate | PASS; two 3.55 m lanes, 7.10 m combined width, 0 endpoint error, 0 crossing/order violation |
| Dynamic drive | PASS; both branch lanes driven 202 m through `c1_0 -> r1_0`, 0 collisions/corrections, 0.13–0.15 m max error |
| A–B / merge marking / orientation | PASS; 56/56 exact, 112,734 strips, 0 ownership penetration, 0 diagonal/chevron artifacts |
| Guardrail suites | PASS; 1 exterior transfer, 0 inside-asphalt/doubled/unexplained rails, 1.43 m owner handoff |
| Road surface | PASS; 40,037 surface / 17,642 render frames, 0 dash-phase errors, worst 0.060 m lateral / 0.030 m vertical |
| Traffic / Dev Map / mobile e2e | PASS; 23 traffic vehicles, Dev Map 34/34, mobile e2e 41/41 |
| Legacy toggle | PASS; `--legacy` emits zero progressive records |
| Lateral junction | PASS ratchet; 56 mouths, 20,185 points, 0 holes/steps/rails; P4 passes with 0 duplicate samples |
| Junction finishing | Known unchanged FAIL (6); P4 absent |
| OSM validation | Known unchanged FAIL 327 = 22 overlap + 245 ramp-drive + 60 smoothness; P4 absent |
| Network test | Known unchanged FAIL: stale 70–95 km expectation versus 206.8 km and stale `dj` alias |
| Performance | Only inherited absolute Node-build limit fails on this host: 7,628.5 ms versus 4,000 ms; browser 7,174.7 ms, 169 calls, 960,000 stored triangles, p95 100.1 ms, 0 errors |

Implementation/evidence commit: `893c8e9` (`Correct P4 to a temporary 2+2
diverge`), pushed to `origin/codex/progressive-merge-prototype`.

A second P4-only temporary exit lane **was required**. There is no remaining
measured P4 geometry, marking, collision, or guardrail blocker. The only honest
manual follow-up is subjective player-speed confirmation of visual rhythm;
fixed-camera inspection and production-physics traversals are clean. P1–P3 are
unchanged, P5 remains disabled, the legacy toggle remains available, and no
network-wide rollout or merge to `main` occurred.

### P4 solved-state handoff snapshot

This is the authoritative resume point for the completed P4-only pass. The
snapshot was taken from a clean worktree immediately before the documentation-
only handoff commit which adds this section.

| Field | Exact value |
| --- | --- |
| Current branch | `codex/progressive-merge-prototype` |
| Verified solved-state HEAD | `b3e3a0b3e27514e85065d6cadd9ab80647b6f89c` |
| Verified remote tracking tip | `origin/codex/progressive-merge-prototype` at `b3e3a0b3e27514e85065d6cadd9ab80647b6f89c` |
| P4 implementation/evidence commit | `893c8e9ffed72d40d3181d6fe8bb16ccee210f7f` |
| Prototype | P4 = `J2:diverge:c1_0:r1_0:start` |
| Scope at handoff | P4 active; P1–P3 deferred in legacy mode; P5 disabled; no network rollout |
| Compatibility switch | `?legacyProgressiveMerges=1` restores legacy rendering |

The handoff-document commit necessarily advances the branch beyond the
solved-state SHA recorded above: a Git commit cannot contain its own final SHA
because that SHA is derived from the committed content. On resume,
`git rev-parse HEAD` and `git rev-parse @{u}` are the authoritative final
documentation-tip check; both must match and `git status --short` must be empty.

#### Exact architecture and lane-topology rule

`js/progressive-merge.js` owns the P4 transition model and its phase landmarks,
temporary lane paths, cross-sections, mappings, paved envelope, ownership
handoff, marking paths, and guardrail envelope. `js/map.js` consumes that single
model for rendered pavement, road collision, transition-owned paint, route-paint
suppression, and exterior rail terminals. `js/game.js` only visualizes the same
records in the query-controlled ownership/topology overlay; it does not own an
independent geometry rule. The focused probes consume those production records
rather than reconstructing a more permissive test-only transition.

For P4 only, `topologyKind = 2+2-diverge` and the shared transition must contain
exactly four temporary lanes: continuing `host:0` and `host:1`, plus exiting
`aux:0 -> r1_0:0` and `aux:1 -> r1_0:1`. The exiting carriageway is a rigid
7.10 m cross-section made of two 3.55 m lanes. Its inner boundary, centre
divider, outer boundary, and both lane centres rotate and translate together
into the corresponding real branch geometry. The outer boundary and its solid
yellow marking remain the branch outer edge; they must never target branch
lateral 0 or change role into the branch divider. Ownership transfers only
after the host/branch paved union supports the complete 2+2 section. The gore
and separating rail may begin only after that transfer. P4 must fail if either
exit lane closes, consecutive cross-sections stop overlapping, a centre misses
its real branch lane, paint order crosses, or rail/collision geometry enters the
drivable exit corridor.

The authoritative phase landmarks are: full usable widening at host
`s=10888.887`; steering begins at host `s=10946.737`; exterior handoff at
host/branch `s=10980.270/146.042`; full branch ownership and gore permission at
host/branch `s=10998.160/164.000`. These are source-envelope/branch-target
landmarks, not an arbitrary animation extension.

#### Tests and visual evidence at this resume point

The final Phase F run passed the classification, shared model, shared
integration, P4 hard 2+2, two-lane dynamic drive, A–B clipping, merge marking,
marking orientation, merge guardrail, guardrail envelope, road surface, traffic,
developer-map, generic mobile e2e, legacy-toggle, and lateral-junction ratchet
checks. Exact measured results and the intentionally unchanged global failures
are in the Phase F table above. The commands for the green gates are:

```powershell
node .devtests/progressive-junction-classification-probe.mjs
node .devtests/progressive-merge-model-probe.mjs
node .devtests/progressive-merge-probe.mjs
node .devtests/p4-diverge-continuity-probe.mjs
node .devtests/progressive-merge-drive.mjs
node .devtests/ab-marking-clipping-probe.mjs
node .devtests/merge-marking-probe.mjs
node .devtests/marking-orientation-probe.mjs
node .devtests/merge-guardrail-probe.mjs
node .devtests/guardrail-probe.mjs
node .devtests/road-surface-probe.mjs
node .devtests/traffic-test.mjs
node .devtests/dev-map-test.mjs
node .devtests/e2e.mjs
node .devtests/progressive-merge-probe.mjs --legacy
node .devtests/lateral-junction-probe.mjs
```

The identical-camera comparison is preserved as eight failing 2+1 images in
[`before-2plus2`](docs/progressive-merges/checkpoint-2/before-2plus2/) and eight
corrected 2+2 images in
[`after-2plus2`](docs/progressive-merges/checkpoint-2/after-2plus2/): elevated
plan, normal chase, close marking, and guardrail-side, each in normal and
ownership-colour form. The corrected directory also contains the
[`measured topology overlay`](docs/progressive-merges/checkpoint-2/after-2plus2/p4-corridor-debug-topology-after-2plus2.png),
and the machine-readable hard-gate record is
[`P4-AFTER-2PLUS2.json`](docs/progressive-merges/checkpoint-2/P4-AFTER-2PLUS2.json).
All nine corrected views were directly inspected.

#### Remaining work and precise resume instructions

There is no remaining measured P4 pavement, topology, marking, collision,
drivability, or guardrail defect. The only P4 follow-up is subjective visual
rhythm at player speed. P1–P3 remain real vertical/split-level source-data cases
for a separate manual-review/design pass; P5 and a network-wide rollout remain
out of scope. The inherited red suites remain unchanged: junction finishing
fails six cases with P4 absent; OSM validation reports 327 non-P4 findings;
network validation has its stale 70–95 km and `dj` expectations; and this host
exceeds only the absolute 4 s Node map-build performance limit.

Resume exactly as follows:

```powershell
Set-Location C:\Users\giaco\Documents\GitHub\hesi
git switch codex/progressive-merge-prototype
git fetch origin
git pull --ff-only origin codex/progressive-merge-prototype
git rev-parse HEAD
git rev-parse '@{u}'
git status --short
```

The two SHAs must match and the status command must print nothing. Read this
handoff and `P4-AFTER-2PLUS2.json`, inspect the corrected plan/ownership overlay,
then run the focused commands above before changing geometry. Preserve P4's
2+2 rule and all existing A–B, developer-map/mobile, surface, marking, collision,
and rail behavior. Do not reactivate P1–P3, enable P5, touch unrelated
junctions, begin a rollout, open a PR, or merge to `main` without new scope.

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
