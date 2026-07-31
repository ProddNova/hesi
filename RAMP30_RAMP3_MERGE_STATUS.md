# Ramp 30 → Ramp 3: progressive merge (P5)

`J39:merge:ramp_3:ramp_30:end` — the two Wangan exits joining at the head of
R11 Daiba. It is **P3's model on a two-lane host**
([TATSUMI_RAMP8_MERGE_STATUS.md](TATSUMI_RAMP8_MERGE_STATUS.md)): ramp 30
arrives on two lanes appended outside ramp 3's paved edge, the four lanes run
together, and they are closed one at a time — 4 → 3 → 2 — before the joined
carriageway continues as R11.

## What was wrong: there was no junction here at all

The extractor records ramp 3 and ramp 30 as two carriageways *continuing* into
the same R11 node. Neither is a merge or a diverge edge, so nothing in the
builder ever looked at the pair: no mouth, no marking opening, no rail
handling, no lane transfer. Measured on the old build, along ramp 30's last
200 m:

| ramp 30 s | gap between the paved edges |
| ---: | ---: |
| 688.8 | +1.53 m |
| 728.8 | −0.05 m |
| 768.8 | −3.35 m |
| 808.8 (the shared node) | **−6.60 m** |

Two 9.00 m decks at the same level, ending up 6.6 m into one another with
`dy` ≈ 0.00 m — coplanar duplicated asphalt, a sliver hole ahead of it where
the gap was still 1–2 m wide, both routes' edge lines and both parapets drawn
straight through the overlap.

## What changed

### 1. The continuation pair becomes a merge (`applyContinuationMerges`, js/map.js)

A new live-flow pre-pass rewrites exactly this shape, measured rather than
authored: the branch is cut at the **first data point within 12.5 m of the host
centreline** — the head of the parallel run, past which everything is the
overlap — and its continuation edge onto R11 is replaced by a merge edge onto
the host at that point. Ramp 30's data polyline goes from 776.9 m to **563.1 m**
(26 points to 17); its traffic reaches R11 through ramp 3 now, which is what
the two roads physically do.

Everything downstream is the standard treatment: `_registerDataRoute` anchors
the tail, `_prepareJunctionMouths` builds the mouth and the zone, and the
progressive model builds on top. `progressiveMerges: false`
(`?legacyProgressiveMerges=1`) keeps the raw extractor topology, so the
before/after comparison is still one flag.

### 2. The 2+3 merge model is a shape, not a lane count (`js/progressive-merge.js`)

`twoPlusThreeMerge` hard-coded `host.lanes === 3`. The model only ever needed
the **branch pair**: two lanes appended outside the host's paved edge, closed
one at a time. `APPENDED_PAIR_MERGE_HOST_LANES` maps the declared topology tag
to the host lane count it contracts for (`2+3-merge` → 3, `2+2-merge` → 2), and
the drift check in `buildProgressiveTransitions` is keyed on the same table.
P2/P3 keep their tag and their numbers byte-identical; P5 runs 4 → 3 → 2
through the same code.

### 3. Two things a cut tail cannot inherit from its data

Both are declared on the prototype, so P3/P4 keep the geometry they were
measured against:

- **`branchBlendLength: 240`.** The generic formula gives this ramp 190 m.
  Ramp 30 closes on ramp 3 at ~27°, so at 190 m it is still turning where the
  two decks meet: their cross-slopes disagree by up to 0.85 m across the
  section and the classifier reads a deck-ownership break. Measured, at
  otherwise identical settings:

  | blend | classification | ownership-break rows |
  | ---: | --- | ---: |
  | 100 m | multi-level-transition | 8 |
  | 150 m | multi-level-transition | 4 |
  | 190 m | multi-level-transition | 2 |
  | **240 m** | **same-level-simple** | **0** |

- **`branchDeckFollowsHost: true`.** `_anchorEndpoint` blends plan only,
  because "the extractor already holds the branch's heights to the host's deck
  profile through the taper". That is true of an endpoint that IS the shared
  node. A tail cut 200 m short has no such truth: ramp 3 is banked there, its
  deck 7.10 m out sits **0.4–0.8 m above its centreline**, and the branch kept
  its own centreline height — enough to put every cross-section outside the
  0.18 m coplanar band, so the mouth clip saw two surfaces and merged nothing.
  The appended slots ARE that deck, so the tail rides it: the lead points take
  the banked deck height, and through the blend the height leaves it on the
  same weight the plan does (tangent-continuous at both ends). Measured `dy`
  through the shared run went from −0.38…−0.81 m to **0.00 m**.

## Measured result

Host chainages on `ramp_3` (length 1087.6 m; the record ends 29.9 m before it
hands over to R11):

| Event | Host s |
| --- | ---: |
| approach (record start, plain two lanes) | 788.5 |
| rail release (measured 0.90 m clearance) | 799.5 |
| opening (ramp edge reaches the outer lane line) | 814.3 |
| FULL 4 — ramp pair on the appended slots | 865.0 |
| 4 → 3 | 913.2 |
| stable 3 | 961.4 |
| 3 → 2 | 1009.6 |
| stable 2 | 1057.7 |
| *(ramp 3 continues into `r11_1`)* | *1087.6* |

193 m from "two lanes established alongside" to "back to two lanes", in four
geometry-derived **48.2 m** stages (a 1:13.6 taper — this is a 60 km/h ramp
junction, not the Wangan's 1:20). Transition length 269.2 m. The stage is
derived exactly as P3's, from the run in which the branch's own geometry moves
one lane width, and needed no clamping: the four stages fit inside ramp 3 with
30 m to spare.

Ramp 30 runs 693.2 m at runtime and is anchored at both ends now, so it
publishes two protected spans to the world editor — `diverge-head` 220 m
(P4) and `merge-tail` 270 m — leaving its middle fully editable.

## Verification

Green: `progressive-junction-classification-probe` (P5 admitted on its own
evidence — `same-level-simple`, continuous deck to lateral separation, 104 m
planar overlap, max deck separation 0.466 m), `progressive-merge-probe --live`
(**all three live records PASS**: P5 269.2 m, lane step 2.60 m, tangent 1.18°,
width step 0.45 m, height switch 0.001 m, 130 drive samples, 0 collisions),
`progressive-merge-probe` (legacy flow, P1/P2 unchanged), `--legacy`,
`guardrail-probe` (0 unexplained, 0 doubled, 0 inside-asphalt, worst lateral
restart 0.02 m), `merge-guardrail-probe`, `lateral-junction-probe` (57 mouths,
0 holes/steps/rails), `road-surface-probe`, `merge-marking-probe`,
`marking-orientation-probe`, `merge-arrow-probe`, `p4-diverge-continuity-probe`,
`traffic-test` (23 active, 0 events), `editor-build-ops-probe` (no drift),
`dev-map-test` **34/34**.

Two probe assertions were restated, neither relaxed:

- `progressive-merge-probe` keyed three checks on the literal tag
  `'2+3-merge'` — the ownership allow-list, the ownership sequence and the
  "5 → 4 → 3" lane-count contract. All three are properties of the *model*, so
  they now ask `isAppendedPairMerge()` and grade the counts against the host's
  own lane count. It also graded the retired first-absorption divider against a
  full 0.5 m gap: past `firstAbsorptionEnd` that boundary IS the outer edge of
  the one lane left, and the 0.5 m it was measured against is the Wangan's own
  marking shoulder — P3 passed it by 0.05 m, a ramp-width carriageway has
  0.20 m there. Past the absorption the check is now the model's own shoulder.
- The same probe's "no route-local branch paint inside the record" rule did not
  know about `PROGRESSIVE_DIVIDER_HANDOFF`: a merge deliberately leaves the
  line between the branch's two lanes to the branch until the transition's own
  divider has converged onto it (map.js `mouthPaintLat`, added for ramp 8 so
  its two lanes are not left with nothing in between). The rule now carries
  that exemption, which also clears **P3's four pre-existing findings** of the
  same kind.

Unchanged pre-existing failures: `junction-finishing-probe` 26 → **28** and
`ab-marking-clipping-probe` 7 → **15**, both entirely the two known classes
this junction now reproduces — the graph's lane-mapping transfer displacement
(3.28 / 3.29 m for ramp 30's two lanes, exactly ramp 8's and ramp 30's own
3.21 m at the Wangan) and the eight `laneDivider` pieces the divider hand-off
deliberately holds inside the A–B opening (ramp 8 contributes the other seven).

Visual: `node .devtests/ramp3-merge-shots.mjs [suffix] [--legacy]` writes
fifteen fixed cameras (`RM-*`) at the measured stations in both modes — plan,
chase and driver's-eye on each appended lane, plus three straight-down frames
over the opening, the merge and the tapers.

## Known limitations

Both inherited from P3/P4, unchanged:

- **Traffic** hands off with the graph's lane mapping. An AI car leaving
  ramp 30 transfers to `ramp_3` lane 0 with a 3.28 m lateral step, inside
  `MAX_BLEND_OFFSET`, so `traffic.js` glides it out — but the AI does not drive
  the appended four-lane section. Player physics is unaffected: it follows the
  rendered surface and collision, both progressive-owned.
- **Horizontal signage is not painted here.** P3 paints 合流注意 and lane-change
  arrows into the lanes it is about to take away; P5 has the geometry,
  markings, rails and collision only.
