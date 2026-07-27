# Tatsumi PA zone — square-ended bay, gate, walkable lot, editor scene

## What was asked

> "modifica l'area di emergenza di tatsumi per farla così come voglio io [sketch:
> the current smooth bulge on the left, the wanted shape on the right] … in rosso
> ci dovrà essere una sorta di interaction point che porterà nel Tatsumi PA come
> zona differente del gioco proprio come lo è il garage, per ora una semplice
> area vuota in cui si spawna vicino alla propria auto parcheggiata … nell'editor
> mappa andrà sostituito lo switch highway/garage con un multi selector e
> aggiunta la voce Tatsumi PA … aggiungi le barriere come nella strada, quelle
> alte, attorno alla scena della Tatsumi PA"

Four things: reshape the lay-by, put a gate in it, build the zone behind the
gate, and make that zone editable.

## 1. The bay opens square and closes flared (`js/map.js`, LAYBYS)

```js
{ routeId: 'ramp_8', side: 1, start: 550, end: 700, taperIn: 0, taperOut: 45, extra: 10, paZone: 'tatsumi_pa' }
```

In the order the driver meets them (traffic runs up-chainage on ramp_8, so
`start` is reached first): the **first** transverse edge is square — the
pavement jumps its full 10 m at s=550 and the wall closes across it — and the
**second** flares back onto the shoulder over 45 m (~1:3, drivable at speed).
That leaves a **105 m** flat bay, 550–655.

> First cut had these the other way round (smooth in, square out). Corrected on
> the user's clarification: *"mentre si va il primo lato orizzontale deve essere
> squadrato e quello dopo invece apre in modo fluido"*. Either end can be the
> square one now — it is only which taper is authored 0.

Three edits carry it:

- **`_defineLaybys`** no longer rounds a 0 taper up to 1 m (`taper()`), so an
  authored square end survives registration.
- **`_laybyExtraAt`** treats a 0 taper as "full width right at the station".
- **`_prepareRenderFrames`** now walks a station list, not a uniform ladder:
  `_laybySquareEndStations` injects a frame pair `LAYBY_SQUARE_END_STEP` (5 cm)
  apart around whichever station is square. Without it the adaptive refiner
  bottoms out at its 1.5 m `minSegment` and chamfers the 90° corner into a
  diagonal. Routes with no forced station walk the same ladder as before, so
  nothing else on the network moves.

Everything else falls out of the existing accessors, as it did for the original
bay: the asphalt, the corridor, `wallSegments` and the tall screen wall all read
the drawn edge, so **the wall closes the square end by itself**. Longitudinally
the bay is a dead end at the nose and open at the flare; laterally it is open to
the running lanes for its whole 105 m, which is how the car gets in.

One targeted fix was needed for that closing panel: `_emitStyledBarrierSegment`
bakes `u` from chainage, and the panel spans ~7 m of wall across 5 cm of
chainage, which squashed a whole texture tile onto it. Where the drawn edge
sweeps much further than the route advances, `u` is now measured along the panel
instead. Ordinary segments — including the outside of a curve, which does sweep
slightly longer than the centreline — stay on chainage and keep their shipped
UVs.

## 2. The gate (`_buildZoneEntrances`)

In the square wall: an amber forecourt 14 m long, two concrete posts with a
capping lintel, a lit portal slab in the opening, and a 辰巳PA / TATSUMI PA
board over it. Standing on the forecourt below 12 km/h the game offers
`E ENTER TATSUMI PA`.

The gate spans only the **outer ~4.5 m** of the bay's width, not all 10. The
square end is the one the driver reaches first, so the strip beside the running
lanes has to stay clear: you pass the wall's nose, swing in behind it, and pull
up alongside the gate — you never drive through the frame. `_buildZoneEntrances`
reads which taper is 0 and mirrors the whole forecourt/gate/trigger layout onto
that end, so moving the square end in the table moves the gate with it.

Two constraints shaped how it is built. The bay's deep end lies **inside the
Tatsumi clearing rectangle**, which zero-scales every `_instance` placed in it,
and instanced buckets are what saved editor edits address. So the gate is merged
chunk geometry only (`_pushQuad`/`_pushBox`) plus one sign mesh flagged
`tatsumiClearingSurface` — it can neither be swallowed by the clearing nor shift
an editor address.

The map publishes `zoneEntrances` and `getZoneTransition(position)`, mirroring
`getGarageTransition`: horizontal reach plus a deck-height gate, so a road
passing under the bay can never trigger it.

## 3. The lot (`js/tatsumi-pa.js`, new)

`TatsumiPaSystem` is the garage's contract applied to an outdoor lot: its own
scene, built once at boot, hidden until the player takes the gate, first-person
WASD + pointer-lock, root children addressed by build-order index.

46 × 30 m of deck, the player's own car parked in a painted stall, four sodium
masts, the exit portal — and **the road's own tall screen wall all the way
round**. That wall is not a lookalike: `buildPerimeterWall` sweeps the
`shutokoTall` profile out of `js/road-barrier-styles.js` (the same one authored
on ramp_8 in `data/road-barriers.json`) around the lot, mitring the corners so it
turns without a notch. One mesh per side, so the collider boxes are thin slabs
rather than one box covering the whole lot.

Deliberately empty otherwise — that was the brief. Dressing belongs in the
editor now that the scene is editable.

`enter()` spawns the player beside whatever the car anchor has been moved to, so
moving the anchor in the editor moves the spawn with it.

### Entering and leaving (`js/game.js`)

New `pa` mode alongside `driving`/`garage`/`walk`. Unlike the garage — a service
stop that re-spawns you at the boot spawn — the PA remembers where the car was
standing (`paReturn`) and puts it back there, because you parked it in the bay
yourself. `activeScene()` replaces the two-way scene ternaries; the PSX car
visual reparents between the road anchor, the garage display and the PA anchor.

## 4. Editor: three scenes, not two

The highway/garage segmented switch was already built from `sceneList()`, so
registering `tatsumi_pa` in `scenes/scene-registry.js` turns it into the
three-way selector by itself (Highway | Garage | Tatsumi PA), including the
Lights app's scope switch. Around it:

- `BUILD_PATHS` + `js/editor-map-patch.js` `BUILD_URLS` gain the scene;
- `world-adapter.js` `makeTatsumiPaWorld` builds the production generator and
  classifies its children (walls, lamps, deck, car anchor, exit prism);
- `map-builder.js`'s garage branch became `childIndexedOperations`, selected by
  `isChildIndexedScene`, reading `metadata.childIndex` (falling back to the
  garage's `garageChildIndex`).

The build op is still called `garage-object`: it is the child-index op, and
renaming it would invalidate every saved garage build. `data/editor/
tatsumi-pa-build.json` ships with an empty operations list so the game does not
404 looking for it.

## Verification

| probe | result |
|---|---|
| `.devtests/layby-probe.mjs` | **29/29 PASS** — reworked for the shape: first transverse edge square (plain shoulder at s=550, full width immediately after), second one flared (1:3), the step is a real 5 cm frame pair (not a chamfer), chord error measured excluding the intentional step |
| `.devtests/tatsumi-pa-zone-probe.mjs` (new, Playwright) | **10/10 PASS** — the whole chain in the real game: entrance published, prompt offered to a parked car, scene swap, own car parked in the lot, player spawns 4.2 m from it, 4 s of sprinting into the wall stays inside, exit returns the car to 0.01 m of where it was parked, no page errors |
| `tools/hesi-editor/.devtests/tatsumi-pa-scene-probe.mjs` (new, Playwright) | **PASS** — selector offers all three scenes, `?scene=tatsumi_pa` loads the PA adapter, 14 entities with dense child indices, a moved lamp resolves into a `garage-object` op stamped `tatsumi_pa` |
| `.devtests/guardrail-probe.mjs` | PASS network-wide — runs=218, unexplained gaps=0, doubled=0, insideAsphalt=0 |
| editor `npm run test:unit` / `test:server` | 151/151 and 8/8 PASS |
| `.devtests/e2e.mjs` | 39/42. The three failures (two control-overlap layout checks, one auction check) are in CSS/economy code untouched here. The console-error check now **passes** — the missing PA build file was the 404 it used to trip on |

Screenshots (`.devtests/shots/`, gitignored): `PAZONE-gate-approach`,
`PAZONE-bay-from-inside` (looking back at the square nose and the gate in it),
`PAZONE-bay-oblique` (forward down the bay to the flare), `PAZONE-lot`,
`PAZONE-lot-wide`, `PAZONE-back-on-road`, `PAZONE-editor`.

**Note when running the editor probe**: a dev server started before these
changes has the old `BUILD_PATHS` and answers 400 for `scene=tatsumi_pa`.
Restart it, or the probe fails its console-error check for that reason alone.

## Notes / open choices

- **The nose is a hard edge in the driver's path.** The square end steps the
  pavement (and its wall) out 10 m in 5 cm, right where the bay begins. It is
  collidable like any other stretch of that wall, so clipping the inside line
  into the bay hits it. That is the shape as drawn; softening it means giving
  `taperIn` a few metres, which stops being square.
- **The lot is not the real 190 m strip.** It is the walkable pocket behind the
  gate, sized for a first-person scene; the real footprint still lives on the
  deck outside (see [TATSUMI_PA_STATUS.md](TATSUMI_PA_STATUS.md)).
- **The deck slab is a shade lighter than road asphalt** (0x353b43). The road
  carries a texture and baked lamp pools; this slab has neither and went to
  black under the night mix at the road's own value.
- The lay-by's own furniture (SOS cabinet, delineators) now runs the full 90 m
  bay, so the delineator count grew. `layby-probe` confirms those are appended
  instance slots, not moved ones: 11 moved (the parapet props carried out onto
  the bay, none of them addressed by a saved edit), 15 appended.
