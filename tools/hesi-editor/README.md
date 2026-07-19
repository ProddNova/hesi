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
`?project=data/editor/*.json` query still overrides that default.

## Scenes

The editor edits one scene at a time; switch with the Highway / Garage
toolbar control (or `?scene=garage`). Each scene owns its own project and
built-map file:

| Scene   | What it edits                          | Project file                          | Build file                          |
| ------- | -------------------------------------- | ------------------------------------- | ----------------------------------- |
| Highway | Real Shutoko map (`js/map.js`)         | `data/editor/hesi-world-project.json` | `data/editor/hesi-world-build.json` |
| Garage  | Garage interior (`js/garage.js`)       | `data/editor/garage-project.json`     | `data/editor/garage-build.json`     |

## Save and rebuild the map

Save (`Ctrl+S`) writes the project JSON and *builds* its map operations file —
resolving every entity override and placed object into the build file above.
The game fetches these build files at startup through
`js/editor-map-patch.js` and replays them onto the freshly generated highway
and garage. Missing build files are a no-op, and the game never imports editor
code.

Road curves have an additional explicit publish step:

1. Click a rendered asphalt surface or the Tatsumi PA deck (the editor gives
   the nearest road route priority over markings and props), or select a road
   route in the hierarchy. Orange controls are placed on the runtime road and
   collision elevation. Drag a point, right-click the orange road preview to
   add a point, or right-click an interior point to remove it. Double-click to
   add and `Delete`/`Backspace` to remove remain available as shortcuts.
2. Press **Save**. Changed routes are stored deterministically in
   `data/editor/road-route-overrides.json`; production route files are not
   changed yet. Saved curve edits reload into the editor automatically.
3. Press **Rebuild Map**. The saved point arrays are validated and merged into
   `data/routes-smoothed.json` and `data/routes-smoothed.js`, without replacing
   unrelated routes or metadata. Reload the game to use the rebuilt roads.

While editing, the wide translucent orange strip and analytic collision curve
update immediately so the changed trajectory is visible. The merged asphalt,
markings, barriers, and chunk meshes are regenerated only by **Rebuild Map**;
that command publishes the source and reloads the editor with the final road.
Runtime-generated access lanes such as `tatsumi_pa_entry` and
`tatsumi_pa_exit` are saved separately and published as validated synthetic
route metadata.

The road editor changes the existing smoothed centreline in XZ only: elevation
(Y), route IDs, endpoints, and junction connectivity are protected. It does
not edit lanes, widths, junction topology, markings, barriers, or tunnels, and
does not recalculate distance-based metadata. Keep edits local and away from
junction boundaries. If the normal raw-route smoothing pipeline later
regenerates `data/routes-smoothed.*`, press **Rebuild Map** again to reapply
the saved editor source.

## Commits (map versions)

The Project tab has a **Map versions** panel (also reachable with the
toolbar Commit button). *Commit version* saves + builds, then snapshots the
full project document and its build under
`data/editor/commits/<scene>/<id>.json`, so every version of the map is
kept. *Restore* loads any snapshot back (undoable), saves it, and rebuilds
the map; *Delete* removes a snapshot from disk.

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
- orbit and dedicated no-clip fly cameras
- fly controls: click viewport for mouse look, `W/A/S/D`, `Space`/`Ctrl` (or
  `Q/E`) down/up, `Shift`, mouse wheel, and `Escape`
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
- Save, Save As, Load, Export Overrides, Reset Unsaved Changes, Reset Selected
  Override, and undoable Reset All Overrides controls
- safe server-side writes through a project-only endpoint: a temporary sibling
  is fully written before replacement and the previous file is copied to `.bak`
- automatic project load after a full browser reload, recent project paths,
  30-second disk autosaves, and explicit newer-autosave recovery/discard UX
- explicit demo adapter and safe real-world fallback state
- road-centreline editing with bounded nearby control handles, protected route
  endpoints, undo/redo, reloadable source saves, and an explicit production
  rebuild step

Editing shortcuts in Orbit mode are `W` move, `E` rotate, `R` scale, and `X`
world/local. `Delete` disables a generated entity or deletes a placed object;
`Ctrl+D` duplicates a supported reusable asset; `Ctrl+Z` undoes; and
`Ctrl+Shift+Z` or `Ctrl+Y` redoes. Fly mode retains its navigation bindings
(`Space` climbs, `Ctrl` descends), including simultaneous `Ctrl+W/A/S/D`
movement without triggering editor shortcuts. `Shift`-click adds or toggles
selection; an unmodified click replaces it. `Ctrl+S` saves the current project
and pending road source, while **Rebuild Map** publishes saved road curves. `L`
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
