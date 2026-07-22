# Buildings — fixed catalogue + city density

**Status:** done (22 Jul 2026). Landed on `main`.

Three things were asked for and all three are in:

1. **Buildings are a catalogue now.** Sixteen types, each one fixed size. Every
   copy of a type in the map is the same box — so a texture or a model assigned
   to a type lands identically on all of them.
2. **The city is dense.** Roughly twice the buildings, no fully bare stretch
   left beside the C1, at the same rendering cost as before.
3. **A street is not copies of one box.** The six small types and the infill
   pass in §3 — the bayside around the Tatsumi PA spawn used to be two shapes
   repeating, and is now eight.

---

## 1 · The catalogue

`js/building-types.js` is the single table both the generator (`js/map.js`) and
the editor (`js/custom-assets.js`) read. A type declares its window grid and its
size falls out of it, so windows never land half-cut at a corner or a roof:

    width = cols * cellW * repeatX      depth = depthCols * cellW * repeatX
    height = rows * cellH * repeatY

| # | Type | Material slot | w × h × d (m) |
|---|------|---------------|---------------|
| 1 | Shop row | `facadeShop` | 30.8 × 14.4 × 22 |
| 2 | Apartment block | `facadeApartment` | 38.4 × 33 × 25.6 |
| 3 | Dark block | `facadeDark` | 30.6 × 42.9 × 27.2 |
| 4 | Office block | `facadeOffice` | 34 × 59.4 × 30.6 |
| 5 | Hotel slab | `facadeHotel` | 25.2 × 84 × 22.4 |
| 6 | Slim tower | `facadeSlim` | 19.8 × 104 × 19.8 |
| 7 | Office tower | `facadeTower` | 39.6 × 126 × 36 |
| 8 | Skyscraper | `facadeSky` | 48 × 201.6 × 44.8 |
| 9 | Warehouse | `facadeIndustrial` | 60 × 20 × 36 |
| 10 | Depot shed | `facadeDepot` | 88 × 13.5 × 44 |
| 11 | Town house | `facadeTownHouse` | 12.8 × 9.9 × 12.8 |
| 12 | Roadside retail | `facadeRetail` | 32.4 × 9.2 × 25.2 |
| 13 | Tenement block | `facadeTenement` | 17 × 18.6 × 17 |
| 14 | Works office | `facadeWorksOffice` | 21.6 × 13.6 × 14.4 |
| 15 | Machine works | `facadeWorks` | 40 × 16.2 × 25 |
| 16 | Cold store | `facadeColdStore` | 28 × 28.8 × 28 |

11–16 are the small ones. Their footprints (radius 7–22 m against the big
types' 17–49 m) are what lets them stand where `_canPlaceBuilding` refuses
everything else, which is where the gaps were.

**Blank canvas.** Each wall is one quad with plain 0..1 UVs — one wall, one
image. The window grid rides on the texture's own repeat instead of on the
geometry, which is only possible because every copy of a type is the same box.
So in the Surfaces editor, *Fit: stretch* puts one copy of an image on each
wall and *tile* repeats it exactly as many times as asked.

Nothing is glued to a building any more: no rooftop billboards, no neon strips,
no water tanks, no antennas. The one exception is the red aircraft blinker on
the three tall types (`blinker: true` in the catalogue — flip it to `false` to
lose it). One type is one box, so a replaced model is the whole building.

**Old work survives.** The four legacy slots (`facadeOffice`, `facadeDark`,
`facadeHotel`, `facadeIndustrial`) stayed on the types that inherited their
role, so models already saved under `facade:facadeOffice` and
`facade:facadeIndustrial` still find their buildings — and now get fitted into
one consistent box instead of a different random one at every corner.

### What changed structurally

- `_buildStructure` (8 hand-written archetypes, random w/h/d, glued-on props) →
  `_placeBuilding(type, x, z, yaw)`: one box, catalogue size.
- `_pushBuildingBox` no longer takes an rng: no random UV offset, no
  whole-window UV maths. Same `buildingBoxes` record as before, so
  `applyWorldBuildingOverrides` is untouched.
- The `stepped` archetype (3 boxes per building) is gone — one building is one
  record, which is what makes a model swap 1:1.
- `shed` material and the `industrialShed` world object are gone: the generator
  never drew sheds from them (warehouses covered both), so they were a dead
  control in the editor.
- World object ids follow the catalogue (`officeBuilding` → `officeBlock`, and
  so on). Only editor internals referenced the old ids.

## 2 · Density

`CITY_DISTRICTS` in `js/map.js` is the one place density lives: per spine, the
rows walked outward from the road, how often each is offered ground, and the
`[type, weight]` mix it draws from. Rows compete for the same ground through
`_canPlaceBuilding`, so the near row wins it and the far rows take what the
junctions and ramps left over.

Coverage = share of 50 m stations along a spine with a building on that side,
tunnel sections excluded (the road is underground there and the generator
deliberately builds nothing):

| spine | before | after | worst fully bare stretch |
|-------|--------|-------|--------------------------|
| c1 | 94 % | **98 %** | 0 m → 0 m |
| r9 | 41 % | **91 %** | 350 m → 50 m |
| r1 | 44 % | **88 %** | 250 m → 50 m |
| k1 | 52 % | **70 %** | 150 m → 100 m |
| wangan | 2 % | **16 %** | 3150 m → 800 m |

Buildings 1672 boxes → 3062, and the older count included 3-box stepped towers,
so the building count more than doubled. K1 and Wangan stay lower on purpose:
one side of both is Tokyo Bay.

### It did not get heavier

Draw calls / triangles from `renderer.info`, same four camera spots:

| spot | calls before → after | triangles before → after |
|------|----------------------|--------------------------|
| C1 canyon | 259 → **250** | 122 432 → 121 237 |
| C1 from above | 214 → **213** | 147 738 → 144 886 |
| R9 mixed | 131 → 138 | 74 824 → 75 876 |
| K1 works | 83 → 87 | 43 194 → 42 596 |

Twice the buildings for the same cost, because what was removed paid for them:
every rooftop/wall billboard was its own mesh **and** its own canvas texture
(textures 186 → 184), and the water tanks, antennas and neon strips were
instances. The 10 facade buckets per chunk (was 4) cost about what those gave
back. `_recordGroundAnchor` now drops an anchor already swallowed whole by a
neighbouring one, so denser blocks cost terrain-build time only where they
actually reach new ground.

## 3 · Variety — the small types and the infill pass

The bayside around the Tatsumi PA spawn read as copies of one box, because it
was: within 300 m of the spawn stood 4 buildings of **2 types**, and one type
is one fixed size, so both of them were literally the same box repeated.

A district row cannot fix that. It places one building per station, so a wider
mix only swaps which big box stands there — it can never put a small one
*beside* it, and the empty ground between two 88 m depot sheds is exactly what
reads as sameness. So the small types get their own table and their own pass:

- `CITY_INFILL` in `js/map.js` — same row shape as `CITY_DISTRICTS`, but the
  setbacks sit in front of the near row or in the band *between* two rows, and
  one wangan row aims straight into the port row's own band. A depot shed keeps
  49 m clear and stands every 90 m, so the infill can never displace one; it
  can only take the holes between them.
- `_buildInfill()` runs last, after `_buildCity` and `_buildBackdrop`, on its
  own rng. It jitters **along** the spine as well as across it — a second row
  on the primary row's station grid would only deepen the comb it exists to
  break up.
- `_onExistingGround` keeps it honest about land. `_buildTerrain` contours the
  union of the road halo and the recorded anchors, so the pass refuses any spot
  further than its own footprint from ground that already exists. It fills the
  bayside without growing the bayside.

Around the spawn (radius 300 m / 600 m):

| | before | after |
|---|--------|-------|
| buildings within 300 m | 4 | **13** |
| distinct types within 300 m | 2 | **8** |
| distinct types within 600 m | 6 | **12** |

Map-wide, 3062 boxes → **4660**, and coverage went up with it:

| spine | §2 | now | worst fully bare stretch |
|-------|----|-----|--------------------------|
| c1 | 98 % | 99 % | 0 m |
| r9 | 91 % | **95 %** | 0 m |
| r1 | 88 % | **97 %** | 0 m |
| k1 | 70 % | **86 %** | 100 m → **50 m** |
| wangan | 16 % | **44 %** | 800 m → **150 m** |

### Cost

| spot | calls | triangles |
|------|-------|-----------|
| C1 canyon | 249 → 266 | 121 489 → 122 365 |
| C1 from above | 207 → 211 | 144 274 → 143 798 |
| R9 mixed | 136 → 153 | 75 516 → 75 920 |
| K1 works | 84 → 98 | 42 248 → 42 608 |
| Wangan at Tatsumi | 114 → 128 | 76 359 → 76 613 |

+52 % buildings for ~+14 draw calls and flat triangles: the new types are small
and mostly land in ground that was drawing nothing. The cost is the six extra
facade buckets a chunk can now hold, not the geometry.

### It does not move the editor's saved edits

`data/editor/hesi-world-build.json` addresses instances by **(mesh name,
index)** — reorder or insert an `_instance()` call and the user's edits silently
re-point at a different prop. That is why the infill runs *after* everything
else, on its own rng, and places nothing but merged building boxes: all 4794
pre-existing InstancedMeshes and named objects come out byte-identical, with 619
new merged chunk meshes added beside them.

`node .devtests/editor-build-ops-probe.mjs` is that check, standing on its own
now: it replays every hide op in the build file against a fresh map and reports
any whose index no longer holds what it was saved against. It reads **115/119
on target** — the same 4 as before this work. Those four are `chunk 6,-7
box:marking` hides on the Tatsumi deck that drifted in earlier road-marking
work; the markings they named are gone (nearest survivor 1.5–5.6 m away, two of
them landing on the same instance), so they need re-hiding by hand rather than
an automatic repair.

The six new slots were seeded in `data/editor/custom-assets.json` with the
texture of their nearest sibling (town house and retail from the shop row,
tenement from the apartment block, works office from the office block, machine
works from the warehouse, cold store from the depot shed) so they arrive dressed
instead of showing the procedural facade against fifteen custom ones. They are
ordinary slots — repaint any of them in Surfaces.

## Verification

| probe | result |
|-------|--------|
| `node .devtests/building-catalogue-probe.mjs` | 16 types, **1 shape each**, coverage table above |
| `node .devtests/building-shots.mjs` | 5 shots + draw calls, no page errors → `.devtests/shots/buildings-final-*.png` |
| `node .devtests/editor-build-ops-probe.mjs` | **115/119** hides on target (4 pre-existing, unchanged) |
| `node .devtests/e2e.mjs` | **40/41** — same 40/41 with the infill disabled, so the one failure pre-dates it |
| `npm run editor:test` | **127/127** |
| `node tools/hesi-editor/.devtests/building-model-probe.mjs` | **11/11** (editor server on :8081) |

The model probe used to measure the swap against whatever the live
`custom-assets.json` had saved, so the user's own office/industrial models made
it read "the swap did nothing". It now parks saved `facade:` models for the run
and writes the document back untouched afterwards.

## Where to tune

- **A type's size or window grid** — `js/building-types.js`. Change the grid,
  the size follows; every copy in the map follows with it.
- **How dense, and which types stand where** — `CITY_DISTRICTS` in
  `js/map.js`. `step` (how often), `skip` (how often it passes), `setback`
  (metres behind the carriageway), `mix` (`[type, weight]`).
- **How much small stuff stands between them** — `CITY_INFILL`, same fields.
  Raising a row's `skip` thins it; widening `setback` moves which band it
  fills. Adding a type here is free of the stream that everything else is
  placed on.
- **The roof blinkers** — `blinker` in the catalogue.
