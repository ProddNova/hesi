# HESI World Editor

This folder contains a standalone, read-only editor foundation for HESI. It is
not imported by the game and does not run traffic, player physics, scoring,
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

The default URL loads a fast representative, read-only HESI scene. To try the
current generated `HighwayMap` directly, open
<http://localhost:8081/editor?world=full>. Full mode remains experimental; a
failure is surfaced as a warning and the adapter falls back to the
representative scene.

## Run the game

The normal game start remains unchanged:

```powershell
npm start
```

Then open <http://localhost:8080>. This is only a convenience alias for the
existing `python -m http.server 8080` flow. `start-game.bat` also remains
available on Windows.

## What works

- Three.js perspective viewport with orbit camera
- resize handling and deterministic cleanup
- camera reset and focus controls
- grid and axes toggles
- frame, draw-call, and triangle statistics
- professional foundation layout: toolbar, hierarchy/layers, viewport,
  inspector, assets/materials tabs, and status bar
- loading overlay and dismissible visible error overlay
- eight required layers with visibility toggles
- high-level entity registry with stable IDs
- safe representative world adapter and optional full-world adapter

Editing surfaces are visibly disabled. They are extension points, not simulated
functionality.

## Tests

```powershell
npm --prefix tools/hesi-editor test
npm --prefix tools/hesi-editor run test:smoke
```

The first command runs pure registry/adapter tests plus server and production
isolation checks. The smoke command launches Chromium, verifies WebGL startup,
world loading and layer visibility, then captures normal and error-state images
under `test/smoke/artifacts/` (ignored by Git).

If Chromium is not installed for the editor-local Playwright version, run:

```powershell
npm --prefix tools/hesi-editor exec playwright install chromium
```

## Current boundary

There is no viewport selection, transform gizmo, persistence, material editor,
road editor, or AI command runner yet. The next checkpoint is exactly:

**Selection + transform gizmos + declarative overrides**
