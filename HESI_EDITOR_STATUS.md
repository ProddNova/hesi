# HESI Editor Status

Date: 2026-07-17

Branch: `kimi/hesi-world-editor-foundation`

Checkpoint: **3 of 5 — interactive world editing complete**

## Delivered through this checkpoint

- checkpoint 1 real-map loading/navigation and checkpoint 2 semantic discovery,
  hierarchy, selection, and truthful inspection remain green
- TransformControls move/rotate/scale with local/world space, axis constraints,
  translation/rotation/scale snap, live feedback, and numeric transforms
- stable per-instance generated overrides; a lamp's pole, lens, pool, and streak
  move coherently without changing neighboring instances
- hide/show, lock/unlock, generated disable/restore, placed delete/rename,
  duplicate, isolate/exit, reveal all, reset overrides, copy ID, and transform
  copy/paste actions
- generated duplicates become editor-owned placed objects referencing reusable
  asset IDs and sharing runtime geometry/materials
- declarative in-memory project document contains transforms, visibility,
  locking, names, and placed asset references—never triangle data
- compact command history, one entry per gizmo drag, undo/redo toolbar labels,
  keyboard shortcuts, redo-branch truncation, and saved/unsaved tracking
- Orbit editing shortcuts do not steal W/E from Fly navigation

## Evidence

- `npm --prefix tools/hesi-editor test`: 13 unit + 3 server tests pass
- generated-instance test moves one occurrence plus an alias component, proves a
  neighboring occurrence is unchanged, and exercises disable/restore
- asset test proves placed geometry is shared by reference and project JSON has
  no geometry/material/vertex payload
- real Chromium acceptance on stable `lamp:wangan-0:0042`: numeric move,
  move/rotate/scale toolbar, local/world, snap, axes, disable/restore,
  duplicate, delete/undo, lock/unlock, rename, copy/paste transform,
  isolate/exit, and reveal all
- real duplicate `placed:0001` appeared at the edited source occurrence plus a
  2 m offset with `hesi:lamppost:concrete`
- screenshot: `world-editor-mvp/checkpoint-3-real-lamp-editing.png`

## Truthful current limitations (next checkpoints)

- project state is intentionally in memory until checkpoint 4 adds validated
  save/load, atomic disk writes, autosave, recovery, and recent-project UX
- route metadata and analytic collision rows remain semantic-only because the
  runtime exposes no honest render object for them
- merged generated systems remain deterministic chunk/material batches when the
  runtime discards finer source ownership
- debug overlays and full asset-browser workflows remain checkpoint 5 work

## Exact next checkpoint

Checkpoint 4: versioned project schema/validation, save/open/save-as, atomic
disk I/O, autosave and crash recovery, recent projects, reference repair, and
round-trip tests against real stable IDs.
