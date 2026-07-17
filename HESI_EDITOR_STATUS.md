# HESI Editor Status

Date: 2026-07-17

Branch: `kimi/hesi-world-editor-foundation`

Checkpoint: **Editor Foundation Checkpoint 1 complete**

## Delivered

- standalone editor package under `tools/hesi-editor/`
- dependency-free repository-root static server on port 8081
- editor-local Three.js 0.166.1 and Playwright dependencies
- toolbar, hierarchy/layers, central Three.js viewport, read-only inspector,
  assets/materials tabs, status bar, loading state, and visible error state
- OrbitControls perspective camera, resize handling, reset/focus controls,
  grid/axes toggles, frame statistics, and cleanup
- stable high-level entity registry with retrieval, layer lists, visibility,
  subscriptions, and safe clear
- Roads, Markings, Guardrails, Pillars, Buildings, Props, Garage, and Lighting
  entries, each backed by one representative high-level entity
- default representative read-only adapter
- optional `?world=full` adapter that imports only `js/map.js` and falls back
  clearly if the generated map cannot load
- focused unit, server, production-isolation, and Chromium smoke checks

## Recovery disposition

The previous Kimi session left four untracked files and no tracked diff.

- `tools/hesi-editor/server.mjs`: retained and corrected with a stronger
  traversal guard, health endpoint, MIME coverage, and editor-local dependency
  paths.
- `tools/hesi-editor/index.html`: retained and completed with the isolated
  import map, metadata, stylesheet, and actual application entry point.
- root `package.json`: retained as dependency-free convenience scripts; the
  production game start remains `python -m http.server 8080`.
- `tools/hesi-editor/CONTRACTS.md`: useful entity/layer ideas retained, but the
  mega-scope was corrected to the implemented Checkpoint 1 contract. The full
  inherited proposal is preserved as `CONTRACTS_PHASE1_PROVISIONAL.md`.

There were no data-layer files, modified production modules, editor tests, or
working editor UI to recover. No recovered file was discarded.

## Verified commands

```powershell
npm install --prefix tools/hesi-editor
npm --prefix tools/hesi-editor test
npm --prefix tools/hesi-editor run test:smoke
```

Results at checkpoint completion:

- 5 unit tests passed
- 3 server/isolation tests passed
- Chromium smoke passed with 8 registered entities and all 8 layers loaded
- viewport and dismissible error state captured under
  `tools/hesi-editor/test/smoke/artifacts/`

## Isolation

The production `index.html` does not import the editor, and no file under `js/`
was modified. The editor server is read-only and exposes no save endpoint. The
default adapter does not load `HighwayMap` or any gameplay module.

## Known limitations

- representative geometry is intentionally illustrative, not a serialized copy
  of the complete current HESI world
- full-world mode is experimental, eagerly pays the existing `HighwayMap`
  construction cost, and currently exposes the world as one high-level entity
- entities are read-only
- no viewport picking, multi-selection, transform gizmos, command history,
  override persistence, material workflow, road editing, or AI commands
- responsive mode hides the right inspector below 900 px; desktop is the
  intended checkpoint target

## Exact next checkpoint

**Selection + transform gizmos + declarative overrides**

Do not begin material processing, road editing, placement, or AI commands before
that checkpoint has a tested command/override foundation.
