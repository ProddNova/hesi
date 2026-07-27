# Emergency lay-bys (非常駐車帯) — status

> **Superseded in part (26 Jul 2026):** the ramp_8 bay now opens SQUARE at the
> end the driver reaches first (`taperIn: 0`) and flares back open at the other
> (`taperOut: 45`), giving a 105 m flat bay that carries the Tatsumi PA gate.
> The design below still describes the mechanism; see
> [TATSUMI_PA_ZONE_STATUS.md](TATSUMI_PA_ZONE_STATUS.md) for the current shape,
> the gate and the walkable zone behind it.

## What was asked

> "Fai sì che a queste coordinate X: 3604.4961, Y: 59.4720, Z: -4047.9376 la strada
> faccia una piazzola come quelle di emergenza in autostrada"
>
> follow-up 1: "deve essere più lungo leggermente e largo almeno il doppio"
> follow-up 2: "allungala ancora e allargala anche"

…with a screenshot annotation: a green line tracing the carriageway's outer edge
bulging outward and rejoining it — i.e. a motorway emergency lay-by.

## Where that point is

Located with a headless projection sweep over all 66 routes:

| | |
|---|---|
| route | `ramp_8` — 2 lanes, one-way, elevated (bridge), 1206 m long |
| chainage | s ≈ 631 m |
| lateral | +1.96 m (centre of the outboard lane; `halfWidth` 4.5 m) |
| side | +normal, the shoulder the annotation was drawn on |
| context | alongside the Tatsumi PA; `ramp_8` is also the boot/garage-exit spawn route, so this is road the player sees every session |

## Design: one table entry, no bolt-on slab

The bay is **not** a separate pad laid beside the road — it is the road's own
paved edge moving outward. `map.js` already funnels the entire drawn silhouette
through two accessors:

- `_surfaceEdgeLateral(frame, side, inset)` → deck quads, fascia, parapet
  profile, steel handrail, elevated underside, `wallSegments`;
- the corridor envelope in `_corridorsAt` → `getRoadInfo`,
  `getWallCollisionBounds`, `isPointDrivable`, `resolveWallCollision`.

So the feature is a single one-sided widening term, `_laybyExtraAt`, added to
both. Everything else falls out for free: the asphalt bulges, the guardrail
bulges with it, and the bay is drivable and collidable with no extra geometry
pass and no physics special case.

The through lanes deliberately do **not** move: lane dividers, the solid edge
line and the traffic lanes all derive from `route.halfWidth` / `_halfWidthAt`,
which the lay-by never touches. That is exactly the real-world look — the edge
line runs straight past the bay while the pavement opens up behind it.

### Definition

```js
const LAYBYS = Object.freeze([
  { routeId: 'ramp_8', side: 1, start: 550, end: 700, taperIn: 60, taperOut: 45, extra: 10 },
]);
```

150 m total: a 60 m entry flare, a 45 m flat bay (610–655, so the requested
s=631 sits in its middle), a 45 m exit flare, 10 m of extra pavement — a full
pull-off apron rather than a shoulder widening.

Both ends are smoothstepped, so the deck edge — and the parapet standing on it
— leaves and rejoins the shoulder tangentially instead of creasing. **A
smoothstep's peak slope is 1.5× its average**, which is what sets the taper
lengths: 60/45 m buy a ~1:4 entry and ~1:3 exit at this depth. Anything
shorter and a 10 m bulge reads as driving into a corner.

Sizing history: 60 m × 3.2 m → 100 m × 6.6 m → 150 m × 10 m. The first cut
fitted between two lampposts (ramp lamp step is 70 m from s=28, so 588 and 658
bracket it) so no pole had to move; past that the flares a deeper bulge needs
make that span impossible, and the poles inside the span ride outward with the
parapet instead. Verified that none of them is addressed by a saved editor
edit.

### Furniture

`_buildLaybyDressing()` runs at the very end of `_buildWorld` — after every
other instancing pass — so each `_instance` call only APPENDS to its bucket and
no instance index the editor saved against the passes above can move:

- SOS cabinet + green beacon against the parapet at the bay's midpoint;
- white delineator posts every 7 m down the outer edge;
- a blue `非常駐車帯 / EMERGENCY PARKING` board 26 m before the entry taper,
  facing the oncoming driver (`-oneWayDirection · tangent`, like every other
  board on the network), sized/set back like the existing chevron boards.

### Edge furniture follows the drawn edge

New `_edgeHalfAt(route, distance, side)` = `_halfWidthAt` + lay-by extra. The
lamppost, barrier-reflector, chevron-board and SOS-phone loops in
`_queueRouteDetails` now use it, so parapet-mounted props ride the bulge
instead of being left standing in the middle of the bay. Off a lay-by the term
is 0, so every other prop on the network is byte-identical.

Lamp pools/streaks keep their SIZE keyed to the through-lane half-width (the
continuous ribbon over the running lanes is what they exist for), but their
offset now measures from the drawn edge like the pole they belong to: a lamp
carried 10 m out onto the bay parapet would otherwise leave its own pool behind
on the lanes — a bright patch with no lamp over it and a lamp with no light
under it. The pool's overhang past the deck edge is +0.1× its width either way,
so the deck fit is unchanged; `pool-deck-fit-probe.mjs` confirms it (below).

### The `ignoreLot` exemption

`_barrierSuppressed` refuses to draw a rail inside a service-area lot
footprint, so PA gates stay open. Past ~6 m deep the bay reaches over the
Tatsumi PA lot rectangle, and that rule would have (a) opened a hole in the
bay's parapet and (b) — worse — **skipped `_instance` calls mid-bucket in the
furniture loops, renumbering every prop after them and breaking saved editor
edits.**

So `_barrierSuppressed(point, route, ignoreLot)` gained a third argument, set
by callers when `_laybyAt(route, distance, side)` is truthy. The
route-vs-route half of the test still applies in full — only the lot test is
waived, and only on a lay-by's own edge. Verified that the suppression there
was *purely* the lot: `_barrierSuppressed(p, route, true)` returns false at
every flagged station, i.e. no real carriageway is involved. (The Tatsumi deck
itself has been removed from the world by the user; the lot rectangle survives
in the model as a phantom.)

`guardrail-probe.mjs` re-derives that verdict independently and had to learn
the same rule, exactly as it already exempts `zone-on` rails.

### Lot vs lay-by ownership

The same collision, one level up. At 10 m the bay's outer half sits inside that
lot rectangle, and `_lotAt` is consulted FIRST by `getRoadInfo`,
`isPointDrivable` and `getWallCollisionBounds` — so a car parked in the bay was
reported as being in the Tatsumi PA, and its collision bounds became the lot's
(huge) instead of the bay's, i.e. it could drive out of the bay into thin air.

Authored road surface outranks a lot rectangle, so those three entry points now
ask `_laybyOwnsPoint(position)` before deferring to the lot. It is only ever
consulted once a lot has already matched, and a per-lay-by bounding sphere
rejects the call before any projection runs, so the physics path pays nothing
anywhere else. `_lotAt` itself is untouched, which is why the build-time
`ignoreLot` above is still doing its own job.

## Verification

`node .devtests/layby-probe.mjs` — **26/26 PASS**

| check | result |
|---|---|
| requested point inside the flat bay | s=631 ∈ [610, 655] |
| bay edge = shoulder + 10 m | 14.50 m |
| plain shoulder restored outside the span, opposite shoulder untouched | ✓ |
| flares drivable, entry gentler than exit | entry 1:4.0, exit 1:3.0 |
| surface stations across the bay | 36 |
| taper's own contribution to chord error | +0.048 m |
| outer wall segments over the bay | 25, rail run not dropped |
| rail over the bay stands at the OUTER edge | 14.08 m, not 4.50 m |
| parapet suppression over the approach | 0 stations |
| car parked in the bay is on-road | `onRoad=true`, edgeDistance 1.30 m |
| bay drivable at full vehicle radius | ✓ |
| deep end of the bay is inside a lot rectangle (case under test) | ✓ |
| …and the ROUTE still owns it | `route=ramp_8`, `inServiceArea=false` |
| …and its collision bounds come from the route | `type=route` |
| an untouched PA lot still reports as a service area | `shibaura_pa` ✓ |
| corridor stops at the bay edge | ✓ |
| widening did not open the opposite shoulder | ✓ |
| wall collision pushes back to the bay edge, not the lane edge | 15.50 m |
| through-lane half-width / traffic lane centres unchanged | ✓ |
| no instance bucket lost entries | ✓ |
| no saved editor op had its target moved | 47 111 compared, 11 moved, 8 appended |

Two of these needed care to be meaningful rather than decorative:

- **chord error is measured as the taper's CONTRIBUTION**, not an absolute.
  Ramp 8 has a pre-existing bank kink near s=554 that costs 0.22 m of chord
  error on the plain shoulder edge too — an absolute threshold there is just
  re-measuring the road (confirmed: identical with the lay-by stubbed out).
- **the last two rows are a differential build** baked into the probe: it
  rebuilds the map with `_laybyExtraAt` stubbed to 0 and the dressing pass
  disabled, diffs every pre-existing instance matrix, and cross-checks each
  moved index against the op list in `data/editor/hesi-world-build.json`. A
  MOVE is allowed only where no saved op addresses that index; nothing may be
  inserted or dropped mid-bucket. The 11 that move are the
  reflectors/lampposts/pools carried out onto the bay parapet — none of them
  referenced by a saved edit.

`node .devtests/guardrail-probe.mjs` — **PASS**, network-wide: runs=218,
unexplained gaps=0, doubled=0, insideAsphalt=0.

`node .devtests/pool-deck-fit-probe.mjs` — no regression: 2763/94454 buried
samples (2.93%) with the bay vs 2765/94447 (2.93%) with it stubbed out
(`HESI_NO_LAYBY=1`, added for exactly this comparison). Two FEWER pools show a
hard edge. That probe carried its own copy of the pool-offset formula and of
the "is there asphalt here" test, both keyed to the through-lane half-width, so
it was silently auditing pools where they used to be and discarding every
sample over the bay as "no asphalt" — both now mirror `_queueRouteDetails`.

Screenshots: `node .devtests/layby-shots.mjs` →
`.devtests/shots/layby-{plan,oblique,approach,parked}-after.png`. Note that
probe fixes the **split CDN routing** trap: Playwright consults route handlers in
reverse registration order, so the `examples/jsm/**` handler must be registered
LAST or the addon path gets served the core bundle and the page dies on
`mergeGeometries`.

`node .devtests/network-test.mjs` fails on `Unknown highway route: dj` — verified
pre-existing (same failure with `js/map.js` at HEAD).

## Notes / open choices

- **Side.** The bay is on `side: +1`, which on this route is the driver's RIGHT
  shoulder — where the annotation was drawn. For left-hand traffic the
  textbook 非常駐車帯 is on the driver's left; the ramp is elevated with a
  parapet on both sides, so either reads fine. Flipping it is `side: -1`.
- **The phantom Tatsumi lot.** The deck was removed from the world but the
  service area survives in the model, so `_lotAt` still claims that airspace.
  Inside the bay this is now handled (see "Lot vs lay-by ownership"), but
  BEYOND the bay it still means invisible drivable slab and a "Tatsumi PA"
  reading. Pre-existing, not caused by the lay-by; the real fix is to drop the
  service area from the model rather than only hiding its geometry — say the
  word and I will.
- **Unrelated pre-existing outlier**, spotted while running the pool audit:
  `pool-deck-fit-probe.mjs` reports a worst burial of 12.6 m at
  `x=3417 y=-1361 z=-4128`. A pool sampled 1.4 km below the deck is a
  `deckYAt` mis-projection, not a real decal, and it is identical with the
  lay-by stubbed out. Worth a look on its own some time.
- **Adding more.** Append to `LAYBYS`. Anything on an existing route is free;
  only the props inside the new span shift laterally, and `layby-probe.mjs`
  will tell you whether any of them is one the editor has saved an edit
  against.
- Note the in-file comment near `_prepareJunctionMouths` claiming
  "base normal +1 = driver's left" — `horizontalNormal(t) = (-t.z, 0, t.x)` is
  `cross(tangent, up)`, i.e. the driver's RIGHT. Left as-is (out of scope), but
  don't trust that comment when choosing a `side`.
