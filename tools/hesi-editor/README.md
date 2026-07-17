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

## Run the game

The normal game start remains unchanged:

```powershell
npm start
```

Then open <http://localhost:8080>. This is only a convenience alias for the
existing `python -m http.server 8080` flow. `start-game.bat` also remains
available on Windows.

## Navigation and current checkpoint

- real HESI world generation with live chunk streaming
- orbit and dedicated no-clip fly cameras
- fly controls: click viewport for mouse look, `W/A/S/D`, `Q/E`, `Shift`,
  mouse wheel, and `Escape`
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
- synchronized hierarchy and viewport selection, overlapping-hit cycling,
  selection bounds, `F`/Focus selected framing, and a detailed truthful
  identity/transform/world/rendering/collision/optimization inspector
- explicit demo adapter and safe real-world fallback state

## Tests

```powershell
npm --prefix tools/hesi-editor test
npm --prefix tools/hesi-editor run test:smoke
```

The first command runs registry/adapter tests plus server and production
isolation checks. The smoke command launches Chromium, verifies the default real
world, fly/orbit switching, explicit demo mode, and disposal, then captures
checkpoint evidence under `test/smoke/artifacts/`.

If Chromium is not installed for the editor-local Playwright version, run:

```powershell
npm --prefix tools/hesi-editor exec playwright install chromium
```

The semantic registry, selection, inspector, editing, persistence, debug, and
asset-placement systems are delivered in subsequent MVP checkpoints. The
separate Asset & Tile Editor (modeling, UVs, textures, reusable road/tunnel
modules) is intentionally out of scope here.
