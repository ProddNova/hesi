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
