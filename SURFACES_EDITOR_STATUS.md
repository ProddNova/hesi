# Surfaces editor — repeated textures and repeated objects

**Status:** done (2026-07-22)

## Problem

The repeated textures of the world (road asphalt, tunnel walls, barriers) lived
as a cramped "World textures" strip inside the Modeler's right sidebar: eight
slots, one *Set image…* button each, no way to change how the picture tiles.
The Modeler is a per-object tool — this is per-*world* work, and it did not fit.

Two things were missing outright:

- **No tiling controls.** A road image landed at whatever density
  `applyWorldSurfaceUVs` bakes in (one tile per 12 m) with no way to adjust it,
  and no rotation, shift, tint or brightness at all.
- **No access to what the generator already places.** Buildings, lamp posts,
  containers, konbini, signs — the world is full of them, and none could be
  retextured. Editing them one instance at a time was never going to be
  practical (a single chunk holds thousands).

The Modeler's *Your objects* list was also capped at `max-height: 180px`,
showing about three of the 27 saved objects at a time.

## The insight this is built on

The generated map draws each material **once for the whole world** — merged
chunk quads (`_pushQuad`) or one instanced batch per bucket (`_instance`). So a
material *is* an archetype: `facadeOffice` is every office building,
`container` is every container, `road` is every metre of asphalt. Painting a
material paints every copy, with no per-object work and no way to drift out of
sync. That is exactly the "modify the single model, all similar objects follow"
behaviour that was wanted, and it falls straight out of the existing renderer.

## What changed

### Data model (`js/custom-assets.js`)

- `WORLD_TEXTURE_SLOTS` (8 entries) → **`WORLD_SURFACES`** (43), each with
  `label`, `description`, `group`, `kind` (`surface` = tiled infrastructure,
  `object` = repeated placed thing), plus `worldTiled` / `tintOnly` /
  `assetId` / `preview` hints. `WORLD_TEXTURE_SLOTS` remains as an alias.
  `WORLD_SURFACE_GROUPS` derives the display grouping.
- Slot values grew from a bare texture id to a style record:
  `{ texture, repeat, offset, rotation, tint, brightness, flipX, flipY }`.
  `normalizeWorldSurfaceStyle` accepts both forms (and clamps every number, so
  a hand-edited document cannot push a bad value into a material);
  `compactWorldSurfaceStyle` stores only non-default fields.
- `applyWorldTextureOverrides` is now **idempotent and reversible**: it captures
  each material's generated look (`userData.hesiGeneratedLook`) the first time
  it touches it and restores slots that no longer carry an override. That is
  what lets the editor re-apply the whole set live on every slider move, and
  what makes *Reset to generated* exact. Previously a cleared slot stayed
  textured until reload.
- `textureFromSource` gained `rotation` and `shift`, both in the cache key.

### New editor section (`src/surfaces/surfaces-panel.js`)

Toolbar **Surfaces** (was *Textures*) opens a full-screen section: tabs for
*Repeated surfaces* / *Repeated objects* / *All*, a search box, and a card grid
grouped by Roads, Barriers & rails, Tunnels, Terrain, Buildings, Street
objects, Signs, Lights. Each card previews the surface as it currently looks —
its own generated texture, or the uploaded image tiled at the chosen repeat.

The inspector carries a **live 3D preview built from the map's real material**:
catalog geometry where one exists (barrier segment, guardrail, lamp, konbini,
vending, canopy, garage), otherwise a representative volume with the same 0..1
UVs `_pushQuad` gives its quads — and, for road slots, a 48 m plane carrying
the true world-anchored UVs. A ☀/🌙 toggle swaps inspection light for the
night-game light so emissive surfaces read true.

### Shared controls (`src/world/surface-style-editor.js`)

Image (set/replace/crop/clear), tiling, placement, colour, reset — written once
and mounted in both the Surfaces section and the Modeler, so the two never
disagree. Road slots express tiling as **metres per tile** (12 / repeat, with
3/6/12/24/48 m presets) because their UVs are world-anchored; everything else
gets repeat across/down. Every change writes through the store and re-applies
to the live map, so the world updates while the slider is still moving.

### Modeler (`src/modeler/modeler-panel.js`)

- Left panel switches between **Your objects** and **World objects**; the world
  list is grouped by category and marks which archetypes carry custom paint.
  Selecting one previews it in the modeler viewport from the live material and
  opens its paint controls on the right. Modelling chrome (parts, add-part,
  assembly, scale, mode bar, part inspector, picking, shortcuts) is hidden in
  that mode rather than left dead on screen.
- The object list grew from `max-height: 180px` (≈3 rows) to
  `flex: 1 1 auto; min-height: 220px; max-height: min(58vh, 680px)` — ≈13 rows
  at 1600×950, and the world list is uncapped since it owns the column.

### Stylesheet fix (`tools/hesi-editor/styles.css`)

Added `[hidden] { display: none !important; }`. Author `display: flex` rules
beat the user-agent `[hidden] { display: none }` regardless of specificity, so
every panel that declared its own display ignored the flag — the first
world-object screenshot showed the parts list, catalog and part inspector still
on screen after being hidden. `.segmented` also moved from a hardcoded
`grid-template-columns: 1fr 1fr` to `grid-auto-flow: column`, which was
wrapping the third filter tab onto a second row.

## Follow-up: objects are composites, and they open in the modeler

The first pass exposed one *material* per world object, which is wrong for
anything built from more than one: a lamp is its concrete mast **and** its
sodium head, a parked car its body **and** its glass, an office block its
facade **and** its roof cap. Only the first was reachable.

`WORLD_OBJECTS` (`js/custom-assets.js`) now describes the repeated objects
themselves — 26 of them, each listing the surfaces it is made of. `parts`
doubles as the preview body (axis-aligned boxes in metres carrying the plain
0..1 per-face UVs `_pushQuad` gives its quads), and `worldObjectsUsingSurface`
reports the sharing the generator does on purpose (`concrete` is pillars *and*
lamp masts; one `building` material caps every block), so the UI tags those
`shared ×N` instead of surprising anyone.

- The Modeler's world library lists objects, and the right panel lists that
  object's surfaces the way the face panel lists a part's faces. Clicking a
  part in the 3D preview selects its surface.
- The Surfaces section's *Repeated objects* tab groups its cards by object
  rather than by material, one block per object.
- **Editing the object as a model**, the second half of the request: *Edit
  exact shape…* hands the catalog geometry to the normal modeler as an
  assembled part, *Edit as editable parts…* hands over the composite volumes as
  real primitives (faces, vertices, textures, per-part colour). Both land in
  *Your objects* as an ordinary custom asset. This is honest about what it can
  do: the generated instances out in the map cannot be re-meshed in place —
  surface paint is what changes those — while the model you make is yours to
  place.

Two bugs the previews surfaced along the way, both fixed: the catalog lamp
ships additive glow quads ~40 m wide, which dominated the bounding box and
shrank the lamp to a speck (framing now ignores decoration meshes, matched by
material rather than by list position); and the thumbnail multiplied a tint
over the generated colour when a textureless surface actually has its colour
*replaced* by the tint, so a cyan lamp head previewed green.

## Follow-up: fit modes, and tiles that are not square

Two gaps in the tiling controls:

- The road control was a single *metres per tile* number driving both axes, so
  an asphalt tile could only ever be square.
- There was no equivalent of the custom-object face editor's **Stretch** and
  **Fit & crop**: a repeated surface could only tile.

A style now carries `fit` (`tile` | `stretch` | `cover`, default `tile`) and
`aspect`:

- **Tile** — the picture repeats. Roads expose **Tile size X** and **Tile size
  Z** as independent metre fields with a 🔗/⛓ link toggle (linked by default,
  so nothing changes for existing documents) and the metre presets; quad
  surfaces keep repeat across/down with the same toggle. A 4 m × 24 m tile is
  now expressible. X and Z are world axes — *Rotation* turns the whole lattice.
- **Stretch** — `repeat` forced to `[1, 1]`: one copy over the whole surface,
  squeezed to its shape.
- **Fit & crop** — the existing `faceTextureTransform` cover path with
  `surfaceAspect` from the new **Surface shape** (width ÷ height) slider, and
  `ClampToEdgeWrapping` so the overflow is cropped rather than wrapped.

Stretch and Fit & crop need a bounded 0..1 surface, so `applyWorldTextureOverrides`
forces `tile` on `worldTiled` slots and the UI hides the selector there: road
UVs run unbounded across the map, and one image cannot "fit" 12 km of asphalt.
The 2D thumbnail runs the same three branches, so the card shows the mode.

Also fixed while wiring the link toggle: keeping the partner field in step by
calling `render()` tore out the input being typed into (and the slider being
dragged). Linked partners are now updated in place through a handle `_slider`
returns.

## Follow-up: the model round trip

Two bugs reported against the world-object modeller.

**Parts arrived untextured.** `worldObjectModelParts` copied the material's
*colour* and nothing else, so a building opened as a white box while the World
objects view showed it with its lit windows. The generator's facade textures
are 256×256 canvases built at runtime (`_facadeTexture`) that belong to no
texture library, so there was no id to reference. They are now baked into the
library on demand — once, keyed by name (`Generated · Office building`) — and
attached to every face of the part, which also makes the generated texture
editable like any uploaded image. A user override on the surface is used
directly instead, since that is already a library entry.

**Saving a model changed nothing in the world.** This was the design, not a
slip: the modeller produced a separate custom asset. It is now a real round
trip *for the archetypes where the renderer allows it*.

`applyWorldModelOverrides` (`js/custom-assets.js`) replaces the geometry of an
instanced bucket. The generator draws each instanced archetype as one
InstancedMesh per chunk whose geometry every copy shares, so one swap changes
every container/lamp/barrier at once. The saved object is built, merged with
`mergeGeometries(…, true)` so per-part materials survive as geometry groups,
and fitted into the bounding box the original geometry occupied — instance
matrices scale a unit box, so fitting to that box is what keeps every copy in
place and the right size. Reversible like the texture pass: the generated
geometry and material stay on the mesh in `userData.hesiGeneratedModel` and
buckets without an override are restored.

`WORLD_OBJECTS[*].instanceType` names the bucket, and only the 17 archetypes
that have one are replaceable. Storage is `worldModels: { "box:container":
"custom:0031" }` in the same document as the surface paint, so the editor and
`js/editor-map-patch.js` both apply it with no build/publish step. `Save
Object` on an object opened from a replaceable archetype writes the mapping
itself — that is the "reshape it and every copy follows" the report asked for —
and `deleteAsset` drops any archetype pointing at a model that no longer
exists.

**Not fixed, by decision:** building facades, roofs, sheds and route signs are
merged into chunk quads and the generator keeps no per-copy record
(`_terrainAnchors` holds only `{x, z, r}` — no type, height or yaw), so nothing
can place a replacement at each one. Doing it needs a `js/map.js` change to
record building placements. The panel now states this plainly instead of
offering a round trip that cannot land.

## Evidence

- `npm run editor:test` — 127/127 (was 121/121; new assertions in
  `custom-assets.test.mjs` cover style normalize/compact/clamp, tiling + tint
  application, exact restore-to-generated, and composite-object integrity:
  every object part references a real surface, every object sits in exactly one
  group, and a lamp resolves to `['concrete', 'lampSodium']`. A further test
  pins the fit modes: a `[3, 0.5]` rectangular tile survives to the material,
  stretch and cover both collapse the repeat to `[1, 1]`, cover clamps instead
  of wrapping, and a `worldTiled` slot keeps tiling even when asked to cover.
  Two more cover archetype models: a saved object swaps the geometry of every
  chunk of its bucket, leaves other buckets alone, is fitted into the unit box
  the instance matrices scale, and restores exactly when the override is
  dropped; plus validation of unknown targets and missing assets).
- `node .devtests/surfaces-probe.mjs` (new) — 26/26, no console errors:
  overlay opens, cards render, metres-per-tile retiles the live road material
  (`[1,1] → [3,3]`), a tint repaints every office building at once
  (`ffffff → ff3366`), reset restores the generated colour, the object list is
  551 px tall, a lamp exposes both of its surfaces, painting the **second** one
  reaches the live material (`ff8a2e → 22ddff`) while the first stays untouched
  (`concrete 848a94`), reset restores it, and *Edit as editable parts* lands in
  the custom library with one part per surface and 8 texturable face rows.
  Unlinking the road tile and setting Z to 24 m gives the live material a
  rectangular `[3, 0.5]` repeat, the fit selector offers exactly
  `Tile,Stretch,Fit & crop`, and choosing Fit & crop reveals the surface-shape
  control. Opening a building as editable parts yields parts already wearing
  the generated window texture (6 textured faces) rather than a white box.
- `node .devtests/archetype-model-probe.mjs` (new) — 8/8, no console errors,
  and it restores `custom-assets.json` from a snapshot afterwards: the
  container bucket starts at 24 verts across 7 copies, modelling it and
  pressing Save Object takes all 7 to 76 verts, the status line says so, the
  World objects view reports the replacement, it survives a full page reload
  from the saved document alone, and *Back to generated shape* returns all 7 to
  24 verts.
- `node .devtests/ui-audit.mjs` — ALL CLEAN (6 viewports × 8 UI states).
- `node .devtests/e2e.mjs` — 41/41, confirming the shared runtime path
  (`js/editor-map-patch.js` → `applyWorldTextureOverrides`) still boots the
  game with the existing saved road/barrier overrides.
- Screenshots: `tools/hesi-editor/.devtests/shots/surfaces-repeated.png`,
  `surfaces-objects.png`, `modeler-world-objects.png`,
  `modeler-your-objects.png`, `modeler-edit-as-model.png`,
  `surfaces-tile-shape.png`, `surfaces-fit-crop.png`.

## Truthful limitations

- Repainting is **per material**, which is the point — but it also means
  materials shared across shapes move together. `concrete` covers support
  pillars, walls *and* the lamp-post masts; the four facade materials cover all
  ~7 generated building silhouettes between them (`facadeOffice` alone is used
  by the tower, crown, plain and slab shapes). The slot descriptions say so and
  the surface rows carry a `shared ×N` tag naming every archetype involved.
- **Only instanced archetypes can have their shape replaced** (17 of the 26).
  Merged-quad archetypes — every building facade, roofs, sheds, route signs —
  can be repainted but not re-modelled, because the generator keeps no record
  of where each copy stands. Modelling one still produces your own placeable
  object.
- A replacement is **fitted into the original's bounding box**, non-uniformly.
  That is what keeps every copy where it was, but it also means a model with a
  different aspect than the archetype gets stretched to match.
- Replacement is per **bucket**, and buckets are shared the way materials are:
  `box:concrete` is support pillars *and* lamp masts *and* assorted concrete
  boxes, so replacing its shape reaches all of them.
- **Vertex cost multiplies by the copy count.** The container bucket alone is
  565 instances, so swapping its 24-vertex box for a 5000-vertex model is a
  5000-vertex draw repeated 565 times. Nothing caps this yet — keep replacement
  models PSX-cheap, which is the house style anyway.
- Building facades tile through an atlas window (`_pushBuildingBox` picks
  `windows/cols × floors/rows` per wall), so a photo lands per window-grid
  block rather than per building; the repeat control is the way to bring it to
  a sensible density.
- The 3D preview for merged-geometry surfaces is a representative volume, not
  the real silhouette — faithful for tiling density (same UV convention), not
  for shape.
- Lamp glow (`lightPool`, `lightStreak`) is deliberately absent: it is driven by
  per-instance colour with a white base, so a slot tint there would fight the
  per-lamp tint rather than replace it.
