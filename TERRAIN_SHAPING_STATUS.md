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

Geometry is emitted per area in coordinates local to the old box centre — so
the meshes keep their names, their transforms, and the same world Y span
(−1.12 m to −0.12 m).

### The coastline is contoured, not stepped

Drawing the cells directly gave a hard 90°-stepped coast. But the mask is a
union of stamped discs, which is already round — the staircase was purely the
grid approximating it. So the cells are demoted again, to an acceleration
structure: `stampDisc` records each disc, and the geometry pass contours the
union's own signed distance field with marching squares.

- `field(x, z)` = `min(max over discs of (r − dist), max over rectangles of the
  box SDF)` — union of discs is a max of distances, the rectangle mask clips it
  with a min. Positive inside, smooth, so linear interpolation along a cell edge
  lands on the real coast.
- Cells with all four corners inside are merged into runs and emitted as plain
  quads — the flat middle of the landmass, which is most of it.
- Cells the coast crosses are cut by marching squares; the skirt follows the
  same cut, so wall and cap always share an edge.
- Saddle cells (opposite corners inside) are disambiguated with a centre
  sample: dry middle → two separate spits, wet middle → one neck triangulated
  around that centre. Every other ring is a square with one corner cut off,
  hence convex, and fans from its first vertex. Using a hub on those too put
  the hub outside small rings and flipped 114 faces — hence the narrow rule.

Corner rounding radius is therefore the local stamp radius: 130 m along the
carriageways, ~60–100 m around buildings. `TERRAIN_CELL` only sets how finely
those arcs are polygonised — at 64 m a 130 m-radius arc deviates ~4 m from
true, which is invisible at world scale, so 64 costs 16 k triangles where 40
cost 33 k for no visible gain.

| | before | after |
|---|---|---|
| land triangles | 96 | 16330 |
| land area | ~250 km² | corridor only |
| coast | rectangle edges | rounded, contoured |

New/changed members: `TERRAIN_CELL` / `TERRAIN_ROAD_HALO` /
`TERRAIN_BUILDING_MARGIN` / `TERRAIN_TOP_Y` / `TERRAIN_BOTTOM_Y` /
`TERRAIN_DISC_HASH` / `UP_NORMAL`, `_buildTerrain()`, `_terrainGeometry()`,
`_recordGroundAnchor()`, `this._terrainAnchors`.

`_buildTerrain()` runs from `_buildWorld()` **after** `_buildCity()` and
`_buildBackdrop()`, because it consumes the anchors they record.

### Generation is unchanged

`_recordGroundAnchor` feeds the terrain mask only — it never enters
`_footprints`, so it cannot influence `_canPlaceBuilding` and cannot move a
building. Instance order and indices are untouched, so saved editor build ops
(which address instances by mesh name + index) still resolve.

## Tuning

`TERRAIN_ROAD_HALO` is the one knob worth touching: raise it for a wider,
safer shoreline, lower it to expose more panorama — and since it is also the
stamp radius along the roads, it doubles as the coast's corner radius.
`TERRAIN_CELL` only trades triangles for arc fidelity (measured: 40 → 32.5 k
tris, 56 → 23.0 k, 64 → 16.3 k, 80 → 15.5 k).

## Verification

- `node .devtests/terrain-footprint-map.mjs [tag] [--zoom <x> <z> <halfSpan>]` —
  top-down schematic: carved land filled, original rectangles outlined red,
  routes yellow, ground anchors dotted (green = supported, **magenta = lost its
  ground**, grey = always over open bay). Point-in-triangle, so it stays honest
  now that faces are not axis-aligned. It also audits every face's winding
  against its stored normal. Result: 1551 anchors, **0 magenta**, **0 flipped,
  0 degenerate**; 248 grey — every grey one is a backdrop-cluster silhouette
  that sat outside all eight rectangles before this change too, so nothing
  regressed. Use `--zoom` to inspect the coastline up close.
- `node .devtests/skybox-horizon-probe.mjs [tag]` — driver-view screenshots at
  Rainbow Bridge / Wangan / Daikoku / C1 / K1, and a dump of slab triangle
  counts and water visibility. The reflection now reads down to the waterline
  at every bay viewpoint; the C1 canyon and K1 industrial rows are unaffected.
- `node .devtests/e2e.mjs` — 41/41.
