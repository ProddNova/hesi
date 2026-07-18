# HESI Editor Foundation Contracts

Checkpoint 1 deliberately implements a small read-only editor foundation. The
archived original design is retained in `CONTRACTS_PHASE1_PROVISIONAL.md` for
future reference; it is not the current implementation contract.

## Isolation

- Production `index.html` and `js/` modules do not import editor code.
- Editor dependencies live in `tools/hesi-editor/package.json`.
- The editor server serves the repository root only for read access to existing
  modules and data. It exposes no save or mutation endpoint.
- The default adapter does not import or instantiate game modules.

## Entity contract

Every registered editor entity has exactly these foundation fields:

```js
{
  id,        // stable non-empty string
  type,      // high-level entity kind
  layer,     // one of the declared Checkpoint 1 layers
  name,      // human-readable label
  object3D,  // THREE.Object3D or null
  editable,  // false for this checkpoint
  source,    // adapter/source identifier
}
```

`createEntityRegistry()` can register entities, retrieve by stable ID, list all
entities, list by layer, report layer counts/state, set or toggle layer
visibility, subscribe to changes, and clear without disposing scene resources.
Duplicate IDs and unknown layers are errors.

## Layers

The fixed Checkpoint 1 layer list is:

- Roads
- Markings
- Guardrails
- Pillars
- Buildings
- Props
- Garage
- Lighting

An unavailable layer remains visible in the UI with a zero count and a disabled
toggle. A loaded layer controls its registered high-level Object3D groups.

## World adapter

`loadWorld({mode, onProgress})` always resolves to an adapter or throws a clear
error. The default `representative` mode returns a safe read-only scene with one
high-level entity per required layer. `full` mode, selected with `?world=full`,
attempts to instantiate `HighwayMap` without a game scene and automatically
returns a representative fallback with a warning if that fails.

An adapter exposes:

```js
{
  group,
  entities,
  strategy,
  label,
  warning,
  focusTarget,
  dispose(),
}
```

## Viewport and lifecycle

The viewport owns its Three.js scene, perspective camera, renderer,
OrbitControls, grid, axes, resize observer, animation frame, and frame
statistics. It supports camera reset, focus, grid/axes visibility, world-group
replacement, and idempotent disposal.

## Explicitly unavailable

Selection, transform gizmos, declarative overrides, material editing, road
editing, persistence, AI command execution, and game-runtime override hooks are
not part of Checkpoint 1. Disabled UI surfaces identify these boundaries.

The exact next checkpoint is: **Selection + transform gizmos + declarative
overrides**.
