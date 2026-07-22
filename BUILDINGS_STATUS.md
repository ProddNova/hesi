# Buildings — fixed catalogue + city density

**Status:** done (22 Jul 2026). Landed on `main`.

Two things were asked for and both are in:

1. **Buildings are a catalogue now.** Ten types, each one fixed size. Every copy
   of a type in the map is the same box — so a texture or a model assigned to a
   type lands identically on all of them.
2. **The city is dense.** Roughly twice the buildings, no fully bare stretch
   left beside the C1, at the same rendering cost as before.

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

## Verification

| probe | result |
|-------|--------|
| `node .devtests/building-catalogue-probe.mjs` | 10 types, **1 shape each**, coverage table above |
| `node .devtests/building-shots.mjs` | 4 shots + draw calls, no page errors → `.devtests/shots/buildings-after-*.png` |
| `node .devtests/e2e.mjs` | **41/41** |
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
- **The roof blinkers** — `blinker` in the catalogue.
