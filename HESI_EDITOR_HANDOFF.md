# HESI World Editor Handoff

Branch: `kimi/hesi-world-editor-foundation`

Latest completed commit: `5a7dafab28cda5b8a3cc500b2f7472ca946468ef`

Checkpoint commit being created: `Add real world entity inspection`

## Completed

- Checkpoint 1 real loading/navigation remains green.
- Deterministic semantic discovery populates all required categories without
  triangle/vertex/internal-helper hierarchy pollution.
- Stable route-aware/generated IDs are identical across two independent builds.
- Search, layer visibility/locking, hierarchy and viewport selection, instance
  resolution, overlap cycling, highlight/focus, synchronized reveal, and the
  detailed inspector work on the real map.

## Files changed

- `src/world/{entity-discovery,stable-id,world-metadata}.js`
- `src/interaction/selection-manager.js`
- registry, adapter, app, shell, styles, smoke/unit tests, and documentation

## Tests and screenshots

- `npm --prefix tools/hesi-editor test` — PASS
- real-browser hierarchy/viewport selection and hidden-layer filtering — PASS
- `test/smoke/artifacts/checkpoint-2-real-lamp-selection.png`

## Known bugs

None in completed checkpoint behavior. Generated batch granularity is a
documented runtime-source limitation, not mislabeled per-object semantics.

## Exact next checkpoint

Implement transform/edit actions and compact command history, including safe
per-instance matrix overrides and persistent-asset-reference duplication.
