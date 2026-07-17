# HESI Editor Status

Date: 2026-07-17

Branch: `kimi/hesi-world-editor-foundation`

Checkpoint: **2 of 5 — real entity inspection complete**

## Delivered through this checkpoint

- real map default, explicit demo/fallback, bounds/origin/conversion/inventory
- no-clip fly + orbit navigation and real metadata-driven presets
- 13,579 browser-discovered semantic records across all 14 required layers
- authored route groups/routes/services/tunnel spans and analytic collision data
- deterministic chunk/material road, marking, rail, barrier, building, sign,
  prop, terrain, garage, and lighting entities
- individually addressable generated lamps and structural supports, including
  stable `lamp:wangan-0:0042`
- deterministic structural/route-aware IDs; no random generated-core UUIDs
- hierarchy search by ID/name/type, bounded expandable groups, layer counts,
  visibility, locking, and explicit inspect-locked mode
- hierarchy and viewport selection, raw-child/instance-to-semantic resolution,
  overlap cycling, helper exclusion, selection bounds, focus, and synchronized
  inspector/reveal
- truthful detailed identity, transform, world/GPS, rendering, collision, and
  optimization metadata

## Evidence

- `npm --prefix tools/hesi-editor test`: 7 unit + 3 server tests pass
- independent real `HighwayMap` build test compares every ID and layer count
- real browser hierarchy selection: `lamp:wangan-0:0042`
- real browser viewport selection: `road-surface:n14-n41-roadalt-chunk-14-41-roadalt-13`
- real browser layer-hide test cleared selection and excluded the hidden layer
- screenshot: `tools/hesi-editor/test/smoke/artifacts/checkpoint-2-real-lamp-selection.png`
- in-app browser console warning/error audit: empty

## Truthful current limitations (next checkpoints)

- route metadata and analytic collision rows are selectable in the hierarchy
  but have no fake render object or visual bounds
- merged generated systems are grouped at deterministic chunk/material level
  because the runtime intentionally discards finer source geometry ownership
- transforms, actions, undo/redo, persistence, debug overlays, and asset
  placement remain mandatory next-checkpoint work

## Exact next checkpoint

Checkpoint 3: TransformControls, numeric transforms, hide/lock/disable/restore,
duplicate/delete/rename/isolate/reset actions, reusable asset references, and
compact command-based undo/redo.
