# HESI Editor Status

Date: 2026-07-17

Branch: `kimi/hesi-world-editor-foundation`

Checkpoint: **4 of 5 — persistent projects and overrides complete**

## Delivered through this checkpoint

- checkpoints 1–3 remain green: real map, navigation, semantic inspection,
  generated-instance editing, placed objects, actions, and history
- explicit version 1 project schema and clean committed default at
  `data/editor/hesi-world-project.json`
- deterministic stable-key serialization with five-decimal rounding
- validation for finite transforms, duplicate placed IDs, unknown generated
  IDs, unknown reusable assets, malformed names/booleans, unsafe JSON keys, and
  schema version
- declarative transforms use position/XYZ-Euler-radians/scale; runtime
  quaternions round-trip without embedding Three.js objects
- project-only local server GET/PUT endpoint, 2 MiB limit, data/editor path
  confinement, temporary-file replacement, and backup before overwrite
- Save, Save As, Load, Export Overrides, Reset Unsaved Changes, Reset Selected
  Override, undoable Reset All Overrides, Ctrl+S, recent projects, project name,
  current path, and visible disk success/failure state
- 30-second recovery autosaves written to disk, full-page reload recovery notice,
  undoable recovered state, and explicit discard back to the primary project
- complete browser reload reconstructs generated overrides and placed shared
  asset references before declaring the project ready

## Evidence

- `npm --prefix tools/hesi-editor test`: 16 unit + 4 server tests pass
- server test saves twice, verifies the prior `.bak`, reloads deterministic JSON,
  and rejects an out-of-scope path
- schema tests cover determinism, ordering, rounding, finite numbers,
  duplicates, unknown IDs/assets, geometry-free output, and transform round-trip
- real Chromium: edited `lamp:wangan-0:0042`, created/renamed `placed:0001`, saved
  to disk, fully reloaded the page, and verified both exact transforms returned
- real Chromium: Save As and Load updated current/recent paths; Reset Unsaved
  restored disk transforms; Reset All removed everything and Undo restored it
- real Chromium: an unsaved placed transform autosaved after 30 seconds, was
  recovered with a visible notice after full reload, then discarded cleanly
- screenshot: `world-editor-mvp/checkpoint-4-project-persistence.png`

## Truthful current limitations (final checkpoint)

- route/collision metadata entities remain semantic-only when no honest render
  object exists
- merged generated systems remain deterministic chunk/material batches where
  the production generator discards finer source ownership
- debug overlays, asset catalog/placement UX, import/export reports, commands,
  diagnostics, performance acceptance, and final documentation remain
  checkpoint 5 work

## Exact next checkpoint

Checkpoint 5: editor-only collision/bounds/world/chunk/path/pivot/wireframe/ID
visualizers, reusable asset library and primitive placement, reports/import
validation, command palette/diagnostics, performance/leak passes, complete
Chromium acceptance screenshots, final README/architecture/status/handoff, and
production-isolation audit.
