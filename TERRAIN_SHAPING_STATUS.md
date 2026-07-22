# Terrain shaping — land carved to the road corridor

**Status:** done (2026-07-22)

## Problem

With the bay panorama installed as the skybox (`environment.skybox`, texture
`tex:0105`), the lower half of the image — the city reflected on the water,
which is the whole point of that panorama — was never visible. The horizon was
a hard straight line with flat dark ground below it from every viewpoint.

Cause: `data.terrain` ships eight axis-aligned rectangles (`central Tokyo`
11000×8000 m, `Koto / Tatsumi land` 8000×5200 m, …) that between them blanket
~250 km² of Tokyo Bay. `_buildEnvironment` drew each one whole, as a
`BoxGeometry` 1 m thick. Fog saturates at ~1200 m and the camera far plane is
1250 m, so every rectangle reached past the fog limit in every direction: the
ground filled the entire lower hemisphere and clipped the panorama at eye
level.

A toggle probe confirmed both surfaces were involved — the `Tokyo Bay` water
plane covered the same band at 0.9 opacity — but the editor build already
carries `{"name":"Tokyo Bay", …, "visible":false}`, so in the shipped world the
land rectangles were the only remaining occluder.

## What changed (`js/map.js`)

The rectangles are demoted from geometry to a **mask**. They still decide
*where* land may exist — so the bay stays open under the Rainbow Bridge and
along the Wangan — but a 64 m cell only becomes land if something stands on it:

- a carriageway within `TERRAIN_ROAD_HALO` (130 m from the centreline), or
- a recorded ground anchor: every building footprint, plus the Wangan port
  container stacks and gantry cranes.

A cell counts as inside a rectangle when it *overlaps* it, not when its centre
falls inside, so shoreline props in the last few metres of a rectangle keep
their ground. Anchors set back past the corridor (waterfront warehouses, up to
~370 m out) get a spit of land stamped back to the nearest carriageway instead
of floating on their own island.

Geometry is emitted per area as greedy row-merged top faces plus a skirt down
every coast edge, in coordinates local to the old box centre — so the meshes
keep their names, their transforms, and the same world Y span (−1.12 m to
−0.12 m).

| | before | after |
|---|---|---|
| land triangles | 96 | 6366 |
| land area | ~250 km² | corridor only |

New/changed members: `TERRAIN_CELL` / `TERRAIN_ROAD_HALO` /
`TERRAIN_BUILDING_MARGIN` / `TERRAIN_TOP_Y` / `TERRAIN_BOTTOM_Y`,
`_buildTerrain()`, `_terrainGeometry()`, `_recordGroundAnchor()`,
`this._terrainAnchors`.

`_buildTerrain()` runs from `_buildWorld()` **after** `_buildCity()` and
`_buildBackdrop()`, because it consumes the anchors they record.

### Generation is unchanged

`_recordGroundAnchor` feeds the terrain mask only — it never enters
`_footprints`, so it cannot influence `_canPlaceBuilding` and cannot move a
building. Instance order and indices are untouched, so saved editor build ops
(which address instances by mesh name + index) still resolve.

## Tuning

`TERRAIN_ROAD_HALO` is the one knob worth touching: raise it for a wider,
safer shoreline, lower it to expose more panorama. `TERRAIN_CELL` sets how
finely the coast is stepped (cost scales roughly with 1/cell²).

## Verification

- `node .devtests/terrain-footprint-map.mjs` — top-down schematic: carved land
  filled, original rectangles outlined red, routes yellow, ground anchors dotted
  (green = supported, **magenta = lost its ground**, grey = always over open
  bay). Result: 1551 anchors, **0 magenta**, 254 grey — every grey one is a
  backdrop-cluster silhouette that sat outside all eight rectangles before this
  change too, so nothing regressed.
- `node .devtests/skybox-horizon-probe.mjs [tag]` — driver-view screenshots at
  Rainbow Bridge / Wangan / Daikoku / C1 / K1, and a dump of slab triangle
  counts and water visibility. The reflection now reads down to the waterline
  at every bay viewpoint; the C1 canyon and K1 industrial rows are unaffected.
- `node .devtests/e2e.mjs` — 41/41.
