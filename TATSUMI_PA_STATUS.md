# Tatsumi No.1 PA — real-world dressing, stale-override guard, live garage

Checkpoint status: **the deck is dressed after the real Tatsumi No.1 PA and
is still the live player location.** The elevated deck between ramp_8 and
ramp_9 keeps the active garage, the spawn and the ramp_8 entry/exit built by
the previous checkpoints, and now carries the real lot furniture
(perpendicular stalls, toilet block, vending row, smoking corner, poles,
signage, painted one-way flow). This checkpoint also repairs the PA access,
which the recent editor map edits had broken (see §1).

## 1. Stale synthetic-override guard (js/map.js `_applyEditorSyntheticRouteOverrides`)

The hesi-editor "publish" step had baked overrides for the synthetic
`tatsumi_pa_entry` / `tatsumi_pa_exit` connectors into
`data/routes-smoothed.js` meta while `ramp_8` was being re-drawn. The deck
rectangle is re-fitted from the live ramp geometry on every load, so those
hand-captured polylines drifted clear off the re-fitted deck: the entry
ended ~5 m short of the end gate at the wrong lateral, the exit started past
the end line, and the flow probe failed 4 checks (never crossing an end
line, a 0.161 m collision step and 0.137 m render/collision divergence on
the entry).

`_syntheticOverrideIsStale` now validates any published override that
replaces a lot connector: its on-deck terminus (entry last point / exit
first point) must still land inside the lot rectangle at deck height,
otherwise the override is skipped with a console warning and the
runtime-built connector survives. With the stale pair skipped, the live
entry (260 m) and exit (202 m) are the checkpoint-documented lanes again and
the whole flow probe passes. The override data itself is untouched —
republishing from the editor against the current deck will apply again.

## 2. Real-world dressing (`_buildTatsumiPaDressing`, js/map.js)

Modeled on the real Tatsumi No.1 PA (Shuto Route 9 at Tatsumi JCT): a
compact lot with parking, toilets and vending machines only — no shop, no
fuel. Everything is laid out in the deck frame (u along the one-way flow, v
across; `area.aisleV` marks the aisle side), so a re-fitted rectangle moves
the whole layout with it. Props are visual instances only — lot collision
stays the flat slab.

- **Perpendicular stalls, backed in.** White 5.0 m dividers at 2.8 m pitch:
  an unbroken aisle-side row along the full lot, and a far-side row
  interrupted by the garage-ring forecourt (no stalls within 13.5 m of the
  ring centre) and the toilet block. Parked box cars (~50 % occupancy,
  deterministic from the map seed) face nose-out with the cabin set aft —
  the Tatsumi meet look.
- **Toilet block.** The PA's only building (14 m × 5.4 m, far side at
  u≈25): dark walls, glowing front band, roof parapet, トイレ/TOILET sign
  facing the aisle, a light pool and a painted zebra walkway from the aisle
  edge to the door.
- **Vending row + smoking corner.** Five lit machines (red/blue/cream)
  against the far fence past the toilets with their own glow pool, then a
  partition panel, bench and bin at the exit end.
- **Sodium poles.** Four lampposts with sodium heads and light pools: two
  on each side, arms toward the lot, pools washing over the stall rows.
  Poles stand in the stall line, so their slots never spawn a parked car.
- **Signage.** 辰巳第一PA / TATSUMI No.1 PA blue panel and a P sign facing
  the entry descent, 出口/EXIT green panel at the exit end.
- **Painted flow.** Edge lines just outside the rendered connector strips
  (the far-side line splits around the ring forecourt) and chevron arrows on
  the aisle at u = −42/+20/+42, floated above the strip surface so they stay
  visible along the entry/exit runs.

Kept clear by construction: the aisle band the connectors ride, the spawn at
u=0, the ENTER ring forecourt and both deck ends. The garage stays ring +
beacon only (`_buildGarageExterior` skips the building for
`dressing === 'tatsumi'` exactly as it did for the old bare deck).

The deck registration (`_defineTatsumiDeck` §9) now sets
`area.dressing = 'tatsumi'` + `area.aisleV` instead of
`area.dressingMinimal`; `_buildServiceAreaDressing` dispatches to the
dedicated builder and the other three PAs keep the generic recipe.

## 3. Access, traffic and history

The ramp_8 entry/exit construction, one-height-authority rules, left-hand
traffic reversal and dash constants are unchanged from the previous
checkpoints — see the git history of this file (`1c43a2d` and earlier) for
those write-ups. `_defineTatsumiDeck` sections 1–8 remain accurate.

## Verification

- `.devtests/tatsumi-pa-flow-probe.mjs` — updated: asserts
  `dressing === 'tatsumi'` + a sane `aisleV` instead of the bare-platform
  flag; all continuity/gate/grade/traffic checks PASS again (they failed 4
  at the pre-checkpoint baseline through the stale overrides).
- `.devtests/tatsumi-pa-placement-probe.mjs`, `.devtests/pa-access-probe.mjs`
  — PASS, unchanged.
- Progressive suite (`progressive-merge-probe/-handoff/-model/-drive`,
  `progressive-junction-classification`, `p4-diverge-continuity`) — PASS.
- Generic gates: road-surface, guardrail probe + audit, merge-marking,
  marking-orientation, ab-marking-clipping, lateral-junction, grip. PASS.
- `junction-finishing-probe` — FAIL(27) vs FAIL(28) at the pre-checkpoint
  baseline (pre-existing mouth-local noise from the editor map edits, one
  fewer failure with the stale overrides skipped).
- `network-test.mjs` — crashes at the baseline and here alike (stale legacy
  expectations, pre-existing).
- `e2e.mjs` — 39/41, `dev-map-test.mjs` — 30/31: identical scores and
  identical failures at the baseline (a 404'd resource logged as a console
  error, pre-existing).
- `performance.mjs` — map build ~6.1–6.3 s both sides of the change (the
  4000 ms gate was already failing); frame p95 within its 150 ms limit on
  repeat runs.
- Screenshots (`.devtests/shots/`, gitignored):
  `FLOW-*-dressed.png` via `.devtests/tatsumi-pa-flow-shots.mjs dressed`
  (spawn chase between the stall rows, entry/exit drive-throughs, top-down)
  and the new `.devtests/tatsumi-pa-dressing-shots.mjs` close-ups
  (`DRESS-lot-overview/stall-row/toilets-vending/ring-forecourt/
  entry-signage/exit-signage`).

## Remaining / debt

- The stall/furniture layout constants live in `_buildTatsumiPaDressing`;
  if the deck is ever re-fitted much shorter than ~100 m the far-side
  u-plan (ring forecourt / toilets / vending) would need rescaling.
- The editor's published `tatsumi_pa_entry`/`tatsumi_pa_exit` overrides in
  `data/routes-smoothed.js` are currently skipped as stale (console warning
  at load). Republish from the editor against the live deck — or clear
  them — to silence the warnings.
- The direct `wangan_0` exit anchor (`futureAnchors.wanganExit`) is still
  unbuilt (deliberate).
- Map build time and the junction-finishing/network-test failures inherited
  from the editor map edits are unchanged (pre-existing, see Verification).
