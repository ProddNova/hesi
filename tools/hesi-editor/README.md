# HESI World Editor

This folder contains the standalone HESI World Editor. It is not imported by
the game and does not run traffic, player physics, scoring,
economy, audio, or garage gameplay loops.

## Run the editor

From the repository root:

```powershell
npm install --prefix tools/hesi-editor
npm run editor
```

Open <http://localhost:8081/editor>. Stop the server with `Ctrl+C`.

The equivalent fully isolated command is:

```powershell
npm --prefix tools/hesi-editor run dev
```

Set a different port with `HESI_EDITOR_PORT`:

```powershell
$env:HESI_EDITOR_PORT=8082
npm run editor
```

The default URL loads the real current `HighwayMap`. The representative scene
is available only through <http://localhost:8081/editor?world=demo> or as a
prominently labelled fallback after a real load failure. The editor never
silently presents demo geometry as the production map.

Demo mode uses `data/editor/demo-highway-project.json` by default, keeping its
small fixture entity IDs separate from the real highway project. An explicit
`?project=data/editor/*.json` query still overrides that default. Demo and
real recent-project memory are isolated, and **Apply to Game** is disabled for
demo/fallback worlds so a test fixture cannot overwrite a production build.

## Scenes

The editor edits one scene at a time; switch with the Highway / Garage
toolbar control (or `?scene=garage`). Each scene owns its own project and
built-map file:

| Scene   | What it edits                          | Project file                          | Build file                          |
| ------- | -------------------------------------- | ------------------------------------- | ----------------------------------- |
| Highway | Real Shutoko map (`js/map.js`)         | `data/editor/hesi-world-project.json` | `data/editor/hesi-world-build.json` |
| Garage  | Garage interior (`js/garage.js`)       | `data/editor/garage-project.json`     | `data/editor/garage-build.json`     |

## Draft and playable game

The editor now has two deliberately separate operations:

- **Save Draft** (`Ctrl+S`) saves the editor project and road source only. It
  never changes the playable game, so experimental layouts can be saved and
  reopened safely.
- **Apply to Game** performs the one final production update: it saves the
  draft, validates and publishes road curves, writes the scene build file, and
  reloads the editor. The game reads those generated files at startup.

The toolbar badges distinguish `Draft: Unsaved/Saved` from
`Game: Current/Update pending`. The game fetches scene build files through
`js/editor-map-patch.js`; missing build files are a no-op, and the game never
imports editor code.

For road curves:

1. Click a rendered asphalt surface or the Tatsumi PA deck (the editor gives
   the nearest road route priority over markings and props), or select a road
   route in the hierarchy. The editor draws an opaque, road-width asphalt
   preview with edge lines, dashed lane dividers, and orange draft edges at the
   runtime collision elevation, and opens the **Road panel** above the
   Inspector: route facts (points, length, width, lanes), Prev/Next point
   navigation with camera framing, exact X/Z coordinate editing, and per-point
   Frame/Delete buttons, plus the unsaved-roads count. In the viewport, drag a
   point, right-click the draft road to add a point, or right-click an interior
   point to remove it. Double-click to add and `Delete`/`Backspace` to remove
   remain available as shortcuts.
2. Press **Save Draft** as often as needed. Changed routes are stored
   deterministically in
   `data/editor/road-route-overrides.json`; production route files are not
   changed yet. Saved curve edits reload into the editor automatically.
3. Press **Apply to Game** once when the draft is final. The saved point arrays
   are validated and merged into
   `data/routes-smoothed.json` and `data/routes-smoothed.js`, without replacing
   unrelated routes or metadata. Reload the game to use the rebuilt roads.

While editing, the realistic local asphalt preview and analytic collision curve
update immediately, including during a point drag. The original merged chunk
asphalt may remain visible beside a large experimental deviation; markings,
barriers, and chunk meshes become definitive only after **Apply to Game**.
Runtime-generated access lanes such as `tatsumi_pa_entry` and
`tatsumi_pa_exit` are saved separately and published as validated synthetic
route metadata.

The road editor changes the existing smoothed centreline in XZ only: elevation
(Y), route IDs, endpoints, and junction connectivity are protected. It does
not edit lanes, widths, junction topology, markings, barriers, or tunnels, and
does not recalculate distance-based metadata. Keep edits local and away from
junction boundaries. If the normal raw-route smoothing pipeline later
regenerates `data/routes-smoothed.*`, press **Apply to Game** again to reapply
the saved editor source.

## Photographic skybox

Open **Skybox** from the toolbar or the bottom-panel tab. Upload a JPG, PNG,
WebP, GIF, or AVIF (up to 24 MB); a 2:1 equirectangular panorama gives the
cleanest seamless 360° result. The panel can enable/disable or replace the
image and adjust heading, horizon tilt, roll, horizontal/vertical panorama
movement, zoom, brightness, and horizontal mirroring.

The editor preview and playable game use the same camera-centred inverted
sphere. It follows the camera at the far plane, is excluded from world entity,
raycast, and collision data, and is therefore always unreachable. Skybox
settings belong to the current scene project: **Save Draft** persists them,
and **Apply to Game** copies them into that scene's build file. Uploaded images
are externalized into the content-hashed `data/editor/textures/` library.

## Object Modeler

The toolbar's **Modeler** button (also reachable from the Assets tab) opens a
full-screen modeling section that is always available inside the editor:

- build objects from simple PSX-style parts: box, cylinder, pyramid, cone,
  wedge, plane, and low-segment sphere; move/rotate/scale each part with a
  gizmo (`W`/`E`/`R`) or numeric fields
- **Faces mode**: click any face of a part and attach an image to it —
  making a bin means uploading the photos of its top, bottom, and sides;
  textures use nearest filtering for the PSX look, and one uploaded image can
  be reused across faces and objects. Each face can use **Stretch** or
  **Fit & crop** (aspect-preserving: it freezes the image projection when
  selected, then later vertex edits clip that same stationary image through
  the new face silhouette), plus independent horizontal and vertical flips.
  The **⇄ Opposite** button clones a face onto its geometric opposite
  (front↔back, left↔right, top↔bottom) as an exact mirror image — texture,
  colour, fit, flips, and every pulled or added vertex included
- **Outlines** (`O` or the ▦ Outlines toggle): wireframe overlay of the
  object being edited — every part shows its edge silhouette and the selected
  part its full triangle wireframe, visible even through the surface
- **Vertices mode**: drag welded vertex handles to deform primitives into
  hand-made low-poly shapes (offsets are saved with the object); **+ Vertices**
  (or the *Vertex detail* field) subdivides a part for more editable vertices
- **Snap to grid** (`G` or the Snap toggle): part and vertex dragging lands on
  a configurable step (0.05–1 m) with 15° rotations, for clean alignment
- **Undo/redo** with `Ctrl+Z` / `Ctrl+Y` (or the ⟲/⟳ buttons) across part,
  face, and vertex edits of the object being modeled
- **Car scale reference**: the 🚗 Car toggle parks the player car
  (4.25 × 1.7 × 1.3 m) beside the object to judge real-world proportions
- **Object scale**: ×½ / ×2 / custom-factor buttons resize the whole object
  (every part's position and size) in one step, no per-vertex work needed
- **Assembly**: add any existing catalog asset (lamp, sign, barrier segment,
  or another custom object) as a part, so split map elements become one
  object. In the map editor, `Shift`-select several objects (e.g. a sign and
  its pole) and use *Edit → Assemble into object* to convert the live
  selection into a single custom asset
- **Edit existing objects**: custom assets reopen in the Modeler with *Edit*;
  built-in world assets open as a customizable copy with *Customize*
- **World objects library**: the left panel switches between *Your objects*
  (what you modelled) and *World objects* — the archetypes the map generator
  repeats everywhere: buildings, lamp posts and pillars, containers, garage and
  PA props, signs, barriers and rails. Picking one previews it in the viewport
  built from the live map materials, and the right panel lists **every surface
  the object is made of** (a lamp is its concrete mast *and* its sodium head, a
  parked car its body *and* its glass): select one there or click it in the
  preview, then paint it. Surfaces the generator shares between archetypes are
  tagged `shared ×N` with the full list in the tooltip, because painting one
  changes all of them. Two ways out into normal modelling:
  *Edit exact shape…* hands over the world's real geometry as an assembled
  part, and *Edit as editable parts…* hands over the object's volumes as
  primitives you can reshape, texture per face and drag vertices on. The parts
  arrive wearing what the surfaces wear in the world — the generator'''s own
  facade texture is baked into the texture library on demand as
  `Generated · <surface>`, so a building opens with its windows rather than as
  a white box, and that picture is then editable like any uploaded image.
- **Cars library**: a third Modeler library beside *Your objects* and *World
  objects* exposes all 50 PSXStyleCars player models plus the three runtime
  traffic classes (car, van and TIR). Player cars preview their exact source
  mesh and convert it into editable mesh parts; traffic entries open the exact
  runtime boxes: body, headlights, taillights and dynamic indicators, with no
  editor-only cabin, glass or wheels. Once opened, cars use the
  complete normal toolset: parts, face/viewport texture projection, vertex
  sculpting, primitives, assembly, scale, outlines and undo/redo. A saved model
  is mapped back to the exact player model or traffic class it came from.
  Traffic entries also expose collision dimensions, minimum/maximum cruise
  speed, acceleration, braking, spawn weight, lane bias and lane spread.
  **Save & apply cars** persists the shared document and broadcasts a hot
  reload; a game opened through *Open live game* rebuilds every pooled vehicle,
  including traffic already driving, without changing its route or position.
- **Replacing an archetype'''s shape**: the generator draws its instanced
  archetypes — lamps, pillars, containers, cranes, garage, konbini, vending,
  canopies, parked cars, barriers, guardrails, fences, exit signs, chevrons,
  neon, the landmark tower (17 of the 26) — from **one shared geometry per
  bucket**. Model one of those and press *Save Object*, and every copy in the
  map takes the new shape, in the editor and in the playable game; *Use a saved
  object…* points an archetype at a model you already have, and *Back to
  generated shape* undoes it. The model is fitted into the box the original
  occupied, so every copy keeps its position and size. Building facades, roofs,
  sheds and route signs are merged into chunk quads with no record of each
  copy, so their shape cannot be replaced — the panel says so, and painting
  their surfaces is what changes all of them.

- **Map Inspector face textures**: select a rendered wall, floor, placed box,
  or other non-instanced object and assign/upload an image per exposed face
  directly from the right sidebar; these assignments are persisted in the
  scene project and replayed by the playable-game build

Saved objects land in `data/editor/custom-assets.json` through the dev
server's `/__hesi_editor_assets` endpoint, join the Assets catalog
immediately, and are placeable like any world asset. On save the server
externalizes uploaded images into content-hashed, deduplicated files under
`data/editor/textures/` (records carry `url: "textures/<name>-<hash>.<ext>"`;
fresh uploads/edits travel as embedded data URLs only until the next save), so
the JSON document stays tiny and the playable game starts instantly while the
texture images stream in. Builds
reference them with `place-custom` operations; the playable game rebuilds
them — and applies world surface overrides — from the same saved document via
`js/custom-assets.js` (shared builder) and `js/editor-map-patch.js`.

## Surfaces (repeated textures and repeated objects)

The toolbar **Surfaces** button opens the section dedicated to everything the
world repeats. The generated map draws each material *once* for the whole
world — merged chunk quads or one instanced batch per bucket — so a material
IS an archetype: repainting `road` repaints every metre of asphalt,
`facadeOffice` every office building, `container` every container. There is no
per-object work to do, and no way to get out of sync.

Two tabs split the catalog the way the world does:

- **Repeated surfaces** — road/alternate/service asphalt, lane and amber
  markings, reflectors, concrete barriers, guardrails, safety fence, concrete
  (pillars, walls, and the lamp-post masts that share the material), dark
  concrete, tunnel walls/ceiling/portals, ground and bay water.
- **Repeated objects** — grouped by object rather than by material, each block
  showing every surface that object is made of: office/dark/hotel/industrial
  buildings (facade + roof), industrial sheds, the landmark tower, the highway
  lamp (mast + head), pillars, containers, dock cranes, the garage (walls +
  shutter), konbini, vending machines, PA canopies, parked cars (body + glass),
  route signs (panel + gantry), exit/chevron/matrix boards and neon.

Each surface card shows what it currently looks like (its own generated
texture, or an uploaded image tiled at the chosen repeat). Selecting one gives:

- a **live 3D preview** built from the map's real materials, showing the whole
  object a surface belongs to — the catalog geometry where one exists (lamp,
  barrier segment, guardrail, konbini, vending, canopy, garage), otherwise the
  object's composite volumes, which carry the same 0..1 UVs the generator gives
  its quads. Additive glow decals are drawn but excluded from the framing, so a
  lamp is not shrunk to a speck by its own 40 m light streak. `☀/🌙` switches
  between inspection light and the night-game light so emissive surfaces read
  true.
- **Image**: set, replace, crop/erase, or clear the repeated picture.
- **Image fit**, the same three the custom-object face editor offers:
  *Tile* (the picture repeats — the default), *Stretch* (one copy pulled over
  the whole surface, squeezed to its shape), and *Fit & crop* (one copy keeping
  the image's own proportions, overflow cut away, with a **Surface shape**
  width ÷ height control so the crop matches the real surface). Stretch and
  Fit & crop need a bounded 0..1 surface, so they are offered on the quad
  surfaces and not on world-anchored asphalt — one image cannot "fit" 12 km of
  road.
- **Tile shape**: tiles are not forced square. Road surfaces get two
  independent metre fields, **Tile size X** and **Tile size Z** (with a
  🔗/⛓ toggle and 3/6/12/24/48 m presets), so a tile can be 4 m one way and
  24 m the other; those are world axes, and *Rotation* turns the whole tile
  grid. Everything else gets **repeat across/down** with the same link toggle.
  Because road UVs are anchored to world coordinates, a tile stays the same
  number of metres everywhere — across lanes, chunks, curves and junctions.
- **Placement**: shift across/down, rotation, and horizontal/vertical flips.
- **Colour & light**: a tint that multiplies the image (white leaves the photo
  untouched) and a brightness multiplier. White and amber lane markings accept
  uploaded images like the other painted surfaces; lamp heads, road reflectors
  and matrix boards remain colour-only because they read as light, not as
  material.
- **Reset to generated**: drops every override on that surface and restores the
  material exactly as the generator made it.

Every control writes straight through to the live map, so the world updates
while the slider is still moving. *Save* persists to
`data/editor/custom-assets.json`; the playable game applies the same overrides
on load. Overrides are stored compacted (`{ texture, fit, repeat, aspect,
offset, rotation, tint, brightness, flipX, flipY }`, only the non-default
fields), and the older plain-texture-id form still loads unchanged. Archetype
model replacements live beside them as `worldModels: { "<geometry>:<material>":
"custom:NNNN" }` and are applied by `applyWorldModelOverrides`.

## Commits (map versions)

The Project tab has a **Map versions** panel (also reachable with the
toolbar Commit button). *Commit draft version* saves and snapshots the full
project document plus its candidate build under
`data/editor/commits/<scene>/<id>.json`, so every version of the map is
kept without changing the playable game. *Restore Draft* loads and saves any
snapshot back; **Apply to Game** remains the only production action. *Delete*
removes a snapshot from disk.

## Run the game

The normal game start remains unchanged:

```powershell
npm start
```

Then open <http://localhost:8080>. This is only a convenience alias for the
existing `python -m http.server 8080` flow. `start-game.bat` also remains
available on Windows.

## Navigation and editing

- real HESI world generation with live chunk streaming
- editor-only inspection lighting by default (bright neutral rig, softened fog)
  with a one-key toggle to the original game night lighting (`L`), exposure
  slider, and full-fog toggle under the View menu
- placeable soft spot lights with per-light colour, warmth, intensity, reach,
  pool radius, penumbra, physical falloff, and a procedural irregular cloud
  cookie; the normal transform gizmo moves and aims them, and project builds
  recreate them in the playable game
- orbit and dedicated no-clip fly cameras
- fly controls: click viewport for mouse look, `W/A/S/D`, `E`/`Space` up,
  `Q`/`CapsLock` down, `Shift` boost, mouse wheel, and `Escape` (`Ctrl` combos
  are browser-reserved, so `CapsLock` is the reliable descend key)
- first-person crosshair in fly mode (solid while the pointer is locked)
- slow, normal, and fast speed presets
- metadata-driven Tatsumi PA, initial-spawn, map-center, and entire-world views
- measured world bounds, origin, scale, route/service/junction/chunk counts,
  and the exact inverse of the runtime local equirectangular projection
- resize handling and deterministic cleanup
- grid and axes toggles
- frame, draw-call, and triangle statistics
- editor layout with toolbar, hierarchy/layers, viewport, world inspector,
  metadata/control tabs, and status bar
- loading overlay and dismissible visible error overlay
- fourteen semantic target layers with visibility toggles
- deterministic semantic registry (routes, services, road/marking/rail/barrier
  batches, individual lamps/supports, buildings, signs, tunnels, terrain,
  lighting, and analytic collision records)
- hierarchy search across ID, name, and type; layer visibility and selection
  locking; expandable groups with bounded rendering for large layers
- synchronized hierarchy and viewport selection, `Shift`-click additive and
  toggle selection in both surfaces, overlapping-hit cycling, a
  precise highlight drawn on the entity's real geometry (translucent overlay
  plus edge lines, no bounding box by default), `F`/Focus framing, and a
  detailed truthful identity/transform/world/rendering/collision/optimization
  inspector
- optional debug helpers under the View menu: selection bounds box, selection
  pivot axes, and a collision-walls wireframe overlay built from the world's
  analytic wall segments
- Add Object workflow: an asset catalog (world assets such as lamps, pillars,
  guardrails, signs, canopy, konbini, vending machine, garage, plus editor-owned
  box/cylinder/sphere primitives) with click-to-place raycast placement, Escape
  to cancel, automatic selection of the new object, and undoable placement
  commands that persist through save/reload
- Three.js TransformControls for move/rotate/scale with world/local space,
  per-axis constraints, translation/rotation/scale snapping, and live inspector
  feedback
- one-sided anchored axis scaling: dragging one scale handle keeps the selected
  object's opposite local bounding-box face fixed; numeric fields, undo, and
  redo stay synchronized
- numeric position/rotation/scale editing, reset, and copy/paste transforms
- generated-instance-safe matrix overrides: editing one repeated lamp/support
  leaves neighboring occurrences untouched; composite lamp parts move together
- entity hide/show, lock/unlock, generated disable/restore, placed-object
  delete/rename, isolate/exit, reveal all, copy ID, and reset overrides
- reusable-asset-reference duplication into editor-owned placed objects; shared
  geometry/material resources are never serialized into project state
- compact command history with one entry per gizmo drag, clear Undo/Redo labels,
  keyboard shortcuts, and an explicit saved/unsaved indicator
- versioned project files under `data/editor/` with deterministic JSON,
  finite-number/reference/duplicate validation, five-decimal rounding, and no
  executable code or embedded geometry
- Save Draft, Save Draft As, Load, Export Overrides, Reset Unsaved Changes, Reset Selected
  Override, and undoable Reset All Overrides controls
- safe server-side writes through a project-only endpoint: a temporary sibling
  is fully written before replacement and the previous file is copied to `.bak`
- automatic project load after a full browser reload, recent project paths,
  30-second disk autosaves, and explicit newer-autosave recovery/discard UX
- explicit demo adapter and safe real-world fallback state
- road-centreline editing with bounded nearby control handles, protected route
  endpoints, undo/redo, a realistic asphalt/lane preview, reloadable draft
  saves, and one explicit Apply to Game production step

Editing shortcuts in Orbit mode are `W` move, `E` rotate, `R` scale, and `X`
world/local. `Delete` disables a generated entity or deletes a placed object;
`Ctrl+D` duplicates a supported reusable asset; `Ctrl+Z` undoes; and
`Ctrl+Shift+Z` or `Ctrl+Y` redoes. Fly mode retains its navigation bindings
(`Space` climbs, `Ctrl` descends), including simultaneous `Ctrl+W/A/S/D`
movement without triggering editor shortcuts. `Shift`-click adds or toggles
selection; an unmodified click replaces it. `Ctrl+S` saves the editor draft
without touching game files, while **Apply to Game** publishes the final draft.
`L`
switches lighting mode. The committed clean default is
`data/editor/hesi-world-project.json`; Save As paths are intentionally confined
to `data/editor/*.json`.

## Tests

```powershell
npm --prefix tools/hesi-editor test
npm --prefix tools/hesi-editor run test:smoke
```

The first command runs registry/adapter/edit-command/per-instance override tests
plus server and production isolation checks. The smoke command launches
Chromium, verifies the default real world, fly/orbit switching, anchored X/Y
scaling of a real generated lamp (including inspector and undo/redo state),
transform overrides, declarative asset duplication, explicit demo mode, and
disposal, then captures checkpoint evidence under `test/smoke/artifacts/`.

If Chromium is not installed for the editor-local Playwright version, run:

```powershell
npm --prefix tools/hesi-editor exec playwright install chromium
```

The separate Asset & Tile Editor (modeling, UVs, textures, reusable road/tunnel
modules) is intentionally out of scope here.
