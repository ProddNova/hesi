# Ramp 8 → Wangan Bayshore: progressive merge (P3)

`J13:merge:wangan_0:ramp_8:end` — the Tatsumi No.1 PA ramp rejoining the
Wangan. It used to be a hard diagonal join; it is now a real 2+3 progressive
merge: the ramp's two lanes continue **alongside** the mainline, then close one
at a time and push traffic onto the Wangan.

## What was wrong

`_anchorEndpoint` (js/map.js) glues a merging branch onto the host's outermost
lanes: `lateral = side * (host.lanes - branch.lanes) * laneWidth / 2`, which for
3+2 is 1.775 m — the ramp's centreline is pulled onto the Wangan's own lane
grid. Measured on the live build, ramp 8's hostward paved edge crossed from
+9.95 m to −2.73 m of the host centreline over 155 m: the ramp drove diagonally
across the whole three-lane mainline and stopped in the middle of it.

Enabling the shared progressive model on top of that did not help. Its handoff
is derived from the source geometry, and the source reached the appended-lane
slots and shot past them, leaving **4.7 m** in which to rotate a rigid 7.10 m
carriageway onto the host — a visible kink, not a merge.

## What changed

### 1. The branch is anchored alongside, not across (`js/map.js`)

A prototype may now declare `branchAnchor: 'appended'`. For such a merge
`_anchorEndpoint` targets `side * (host.lanes + branch.lanes) * laneWidth / 2`
= 8.875 m — the centre of two lanes **appended outside** the Wangan's paved
edge — instead of the host-lane glue line. The existing blended taper then does
the rest: over its measured 190 m the ramp converges onto those slots and runs
parallel into the mouth. Nothing is hand-drawn; the alignment is derived from
the host carriageway.

`progressiveMerges: false` (`?legacyProgressiveMerges=1`) keeps the old glue
line, so the before/after comparison is still one flag.

### 2. P3 is a live-flow prototype (`js/progressive-merge-prototypes.js`)

`reverseNetworkData` flips every junction sense for left-hand traffic, so a
record is only valid in the flow whose junction ID it names. Prototypes now
carry `flow`, and `progressiveMergePrototypesForFlow()` selects the subset the
map can actually build:

| Pin | Junction | Flow | Anchor | Note |
| --- | --- | --- | --- | --- |
| P1 | `J2:diverge:c1_0:r1_0:start` | legacy | — | unchanged |
| P2 | `J48:merge:wangan_1:ramp_41:end` | legacy | host-lanes | unchanged |
| P3 | `J13:merge:wangan_0:ramp_8:end` | **live** | **appended** | this work |
| P4 | `J38:diverge:wangan_0:ramp_30:start` | **live** | **appended** | this model, reversed — see [WANGAN_RAMP30_DIVERGE_STATUS.md](WANGAN_RAMP30_DIVERGE_STATUS.md) |
| P5 | `J39:merge:ramp_3:ramp_30:end` | **live** | **appended** | this model on a two-lane host (4 → 3 → 2) — see [RAMP30_RAMP3_MERGE_STATUS.md](RAMP30_RAMP3_MERGE_STATUS.md) |

Before this, the live game built **no** progressive records at all. P1/P2 stay
legacy-bound and byte-identical (`progressive-merge-probe` still reports P2 at
372.4 m); P3 is the first record the playable game actually renders.

P3 carries **no** `approvedSameLevel` override. With the branch alongside
instead of across, the generic classifier measures a continuous same-level deck
all the way to lateral separation and admits it on its own evidence
(`same-level-simple`, `continuous-to-lateral-separation`, 80 m planar overlap).

### 3. The 2+3 model is topology-driven, not ID-driven (`js/progressive-merge.js`)

`twoPlusThreeMerge` was `zone.id === 'J48:…'`. It is now
`prototype.topology === '2+3-merge'` plus the 3-lane/2-lane/merge shape, and
`buildProgressiveTransitions` throws on topology drift rather than silently
falling back to the single-auxiliary model.

Two behaviours are new, both gated on `branchAnchor === 'appended'` so P2 is
untouched:

- **Stage length.** The taper stage was `postHandoffSpan × laneWidth /
  postHandoffLateralShift`. A branch that reaches its slots and then runs
  parallel has no post-handoff drift, so that ratio is undefined. When the
  measured post-handoff shift is below 0.5 m the stage is read from the same
  quantity on the **approach** instead — the run in which the branch's own
  geometry moves one lane width. For P3 that gives **72.3 m per lane**, a 1:20
  taper.
- **Rail opening.** The separating rails released at `openingStart`. A branch
  running alongside meets the host parapet long before the paint opens, and the
  two routes emitted doubled walls 0.08 m apart. `railOpeningStart` is the
  measured station where the two paved edges close to 0.90 m — the width two
  0.42 m-inset parapets need — and both owners release there. The gap between
  the carriageways becomes the painted gore it is in reality.

## Measured result

Host chainages on `wangan_0` (live build):

| Event | Host s |
| --- | ---: |
| approach | 1494.3 |
| rail release (measured 0.90 m clearance) | ~1507 |
| opening (ramp edge reaches the outer lane line) | 1551.2 |
| FULL 5 — ramp pair on the appended slots | 1580.1 |
| 5 → 4 | 1652.4 |
| stable 4 | 1724.7 |
| 4 → 3 | 1797.0 |
| stable 3 | 1869.3 |

289 m from "two lanes established alongside" to "back to three lanes", in four
geometry-derived 72.3 m stages. Transition length 375.0 m.

## Horizontal signage

`_buildMergeRoadMarkings` (js/map.js) paints the merge in reading order:
合流注意 down the ramp (host s ≈ 1393–1426), lane-change arrows in **both** ramp
lanes in two ranks (1443, 1483), then **two arrows in every lane the merge is
about to take away**, ahead of the taper that takes it.

### The lane a marking sits in is the one that is PAINTED

The bug that made all of this read as sloppy, and the one worth remembering:
**`_laneOffset` is not where the lanes are.** It divides `lanes * laneWidth`.
The edge lines are painted at `half - 0.75`, and the two disagree whenever a
route's `halfWidth` is wider than its lane block:

- **ramp 8** is 2 × 3.55 m of lane inside a **4.50 m** half-width. Its edge
  lines sit at ±3.75, so the lanes the driver sees are **3.75 m** wide centred
  on **±1.875** — every marking that trusted `laneWidth` was 0.10 m off.
- the **outermost auxiliary lane** is worse. `outerMarkingLateralAt` is
  `outerLateral - side * 0.75`, i.e. the edge line is inset 0.75 m from the
  paved edge but still sits 0.55 m **outboard** of the geometric lane edge. The
  painted lane is **4.10 m** around a 3.55 m lane, so an arrow on the
  lane-centre path sat **0.28 m off centre** in a ribbon half a metre too
  narrow. Measured, not guessed: `aux:1` paints −8.87..−12.97.
- and the outer line changes identity partway. The aux divider is only painted
  while a lane still exists outboard of this one; after the first absorption,
  `aux:0`'s outer boundary IS the edge line, and it too becomes 4.10 m wide.

Two helpers now derive lanes from the same numbers that draw the lines, and
every marking is placed through them: `_paintedLanes(route, distance)` for a
plain route, `_progressivePaintedLane(transition, laneId, distance)` for the
auxiliary lanes. Nothing in the signage path computes a lane centre itself.

### The arrow, and two ways of getting it wrong

`_roadMergeArrowMaterial` stroked a quadratic in TILE space, which broke three
ways at once on a 30 × 5 m ribbon:

- `lineWidth` was constant in texture space, so the upright shaft measured
  1.0 m across and the near-horizontal elbow 1.5 m;
- the curve reached the head 19° off horizontal and then turned square into
  it, so the default mitre join threw a spike;
- the head's outer corner sat 3.83 m off the ramp centreline against a 3.55 m
  half-width — it hung over the paved edge.

The first replacement fixed all three and was still wrong: a full lane-width
translation — straight, smoothstep one whole lane across, straight. It is
geometrically clean and it is not a road marking. It drove sideways over the
lane line it was painted beside; no road paints its trajectory on the deck.

`_roadLaneChangeArrowMaterial(bend, length, width, shift)` is the shape a
Japanese expressway actually uses, laid out in **metres** and mapped to the tile
last: **16 m of straight shaft on the lane centre, a 3 m hook, and a head angled
off it.** The ribbon is exactly as wide as the painted lane, so the shaft sits
on that lane's centre and the head reaches `shift` = 0.65 m — head corner at
1.45 m against a 1.775 m half-lane at worst. Nothing touches a line.

Three details carry the shape:

- The shaft is offset off its own centreline **along the normal**, in metres,
  and filled — constant 0.55 m real width (measured 0.54–0.58 over the hook),
  and no join for a mitre to spike.
- The hook eases **in only** (`1 − cos`), so it is flat where it leaves the
  straight and steepest where it ends. The head inherits that tangent, so it
  points across at ~26° instead of turning square back down the road. A
  smoothstep would have returned the tangent to zero and left the head pointing
  straight ahead again.
- Weight is road paint, not linework. At 0.45 m of shaft under a 1.25 m head it
  read as a scratch from the driver's seat at night; 0.55 under 1.6 reads.

### An arrow before each lane closes

There was no marking anywhere inside the transition: the only arrow was 200 m
upstream of the first taper and 350 m upstream of the second. `absorptionSteps`
now each get closure arrows from `_paintLaneClosureArrows` — **repeated**, the
way a real closing lane is signed, at 10 m and 46 m of clear run ahead of the
taper, while the lane is still full width and the driver can still act on them.

| Lane | Arrows (host s, head) | Painted lane | Taper it warns about |
| --- | ---: | ---: | --- |
| `aux:1` | 1606.4, 1642.4 | −8.87..−12.97 (4.10 m) | 1652.4 → 1724.7 (5 → 4) |
| `aux:0` | 1751.0, 1787.0 | −5.32..−9.43 (4.10 m) | 1797.0 → 1869.3 (4 → 3) |

The appended lanes drift across the deck as they close, so the ribbon rides the
lane's **painted** centre at every station and is cut to the paint's width.
`_paintDecalRibbon` takes a lateral **function** for this. Measured ribbon
centres land within **0.02 m** of the painted centre at every sampled station,
against 0.28 m before.

`node .devtests/merge-arrow-probe.mjs [--shots]` gates it: an arrow in every
absorption step's lane, each head upstream of its taper, each on the centre of
the lane as painted rather than as computed, each inside the real paved
envelope (`envelopeAt`, not a guess at carriageway width) — plus the arrow
textures measured row by row for constant shaft width, unbroken runs and a
monotone centre. Ramp-side markings are checked the same way against
`_paintedLanes`. Writes `MA-*.png`, including straight-down frames over every
marking and driver's-eye frames on each closing lane's painted centre.

## Locked merge tail (world editor)

The last 220 m of ramp 8 — the 30 m of lead points on the glue line plus the
whole 190 m blend — is **derived from the Wangan**, not authored. Dragging a
control point in there does not move the road; it changes what the derived
alignment blends away from, which is how a merge treatment gets deformed by an
edit that looks like it did nothing.

`HighwayMap` publishes that stretch as `route.protectedSegments`. The editor
(`road-edit-controller.js` + `protectedPointIndices` in `road-edit-ops.js`)
locks it: grey handles, no translate gizmo, and move / numeric-move / delete /
insert-inside all refuse with the reason. **Everything upstream of it stays
fully editable** — for ramp 8 that is source control points 0–3 locked, 4–36
free.

The segment is located by the **world position** of its terminal, not by an
index or an end name: the left-hand build reverses every route, so the runtime
tail is the source document's head. A protected span can never lock a whole
road — two points always stay free.

## Verification

Green: `progressive-junction-classification-probe`, `progressive-merge-probe`
(legacy flow, `--live`, `--legacy`), `progressive-merge-handoff-probe`,
`progressive-merge-drive`, `guardrail-probe` (0 doubled, 0 unexplained, worst
lateral restart 0.02 m), `merge-guardrail-probe`, `merge-marking-probe`,
`marking-orientation-probe`, `ab-marking-clipping-probe`,
`lateral-junction-probe`, `road-surface-probe`, `traffic-test` (23 active,
0 events), `editor-build-ops-probe` (no drift), `dev-map-test` **31/31**,
`tools/hesi-editor` unit suite for roads including the new
`protected-road-segment.test.mjs`.

Probe changes were reason-neutral, not threshold relaxations:

- `progressive-merge-probe` takes `--live` and derives its expected record
  count from the flow's allow-list; its 2+3 assertions are keyed on topology
  rather than on J48's id.
- `ab-marking-clipping-probe` counts `progressive-transition-owner-handoff`
  alongside the two generic cut reasons. The invariant is that the branch's
  host-facing edge is cut over exactly A..B — not which owner claimed each
  metre. Without it a transition that starts inside the marking opening splits
  the cut across two reasons and reads as a 59.55 m error.
- `dev-map-test` expects the live-flow pin set (P3) instead of asserting the
  live map has none. Its jsdelivr route was also split so `three/addons` is
  served from the addons build — the blanket route answered addon URLs with the
  core build and the page never booted.

Unchanged pre-existing failures (identical with the change reverted):
`progressive-merge-model-probe` P1 geometry digest (1),
`tatsumi-pa-flow-probe` (13), `tatsumi-pa-placement-probe` (4),
`car-models.test.mjs` indicator-visibility (1, unrelated to roads).

Visual evidence (gitignored, `.devtests/shots/`):
`node .devtests/tatsumi-merge-plan.mjs [--legacy]` writes a measured plan
overlay of the pavement edges, progressive envelope, lane centres and phase
lines; `node .devtests/tatsumi-merge-shots.mjs [--legacy]` writes fixed
in-game cameras (`TM-*`) at the same host chainages in both modes.

## Known limitation

Traffic hands off with the graph's lane mapping, unchanged: an AI car leaving
ramp 8 transfers to `wangan_0` lane 1/2 at the ramp's end with a **7.12 m**
lateral step. That is inside `MAX_BLEND_OFFSET` (12 m), so `traffic.js` glides
it out over ~1 s and it reads as a merge rather than a pop — but the AI does
not drive the appended five-lane section. Progressive traffic-AI remains out of
scope for the checkpoint, as it was for P1/P2. Player physics is unaffected: it
follows the rendered surface and collision, both of which are progressive-owned
(`progressive-merge-probe --live` drives it with 0 collisions).
