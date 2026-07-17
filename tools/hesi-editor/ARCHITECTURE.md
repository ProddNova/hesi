# HESI Editor Architecture

## World-editor boundary

The editor is a browser-only tool served by a dependency-free Node static
server. Its package and dependencies are contained under `tools/hesi-editor/`.
The root `package.json` only provides convenience commands. Production
`index.html` and `js/` contain no editor imports or hooks.

```text
index.html
  -> src/main.js
     -> src/editor-app.js
        -> ui/editor-shell.js
        -> viewport.js
           -> navigation/fly-camera-controller.js
        -> world-adapter.js
           -> world/entity-discovery.js
           -> world/stable-id.js
           -> world/world-metadata.js
        -> entity-registry.js
        -> interaction/selection-manager.js
```

## Responsibilities

### `editor-app.js`

Composition root and lifecycle owner. It creates the shell, viewport, registry,
and adapter; wires toolbar/layer events; publishes `window.hesiEditor` for smoke
checks; and disposes each owned resource on unload.

### `ui/editor-shell.js`

Creates all editor regions and visible loading/error/fallback states using DOM
APIs. UI controls call narrow callbacks and never reach into `HighwayMap` or
game code. Required controls are functional; future tools are omitted.

### `viewport.js`

Owns Three.js rendering: Scene, PerspectiveCamera, WebGLRenderer,
OrbitControls, no-clip fly controller, helpers, ResizeObserver, animation loop,
camera presets, focus framing, world-update callback, and statistics.
`setWorldGroup()` is the only scene attachment boundary for a world adapter.

### `world-adapter.js`

Returns a uniform adapter contract. Real mode is the default: it dynamically
imports only `/js/map.js`, instantiates `HighwayMap` without a game scene,
measures the fully generated chunk set, and then restores camera-driven chunk
streaming. It exposes bounds, scale, origin, exact inverse projection, counts,
services, and metadata-derived camera presets. It does not import `game.js`,
`traffic.js`, `physics.js`, `audio.js`, `garage.js`, `save.js`, or `ui.js`.

`?world=demo` is explicit. A real-mode exception creates the same demo adapter
with `demo-fallback` strategy and an unavoidable warning banner.

### `entity-registry.js`

Pure state with no Three.js import. It enforces the full entity/layer contract,
rejects duplicate IDs, searches identity fields, applies layer visibility and
locking, emits change notifications, and clears without disposing
adapter-owned objects.

### Semantic discovery and selection

`world/entity-discovery.js` combines authored route/service/tunnel metadata,
analytic wall/collision records, deterministic chunk/material batches, direct
landmarks, and selected repeated instances. Generated instance IDs use the
nearest real route when reliable plus a deterministic traversal counter, e.g.
`lamp:wangan-0:0042`; chunk/material IDs remain structural when no finer source
identity exists. Two independent `HighwayMap` builds are asserted to produce
identical complete ID sequences and layer counts.

`interaction/selection-manager.js` raycasts real world geometry and resolves
raw child or instanced hits back to those semantic entities. It rejects hidden,
locked, and editor-helper hits, cycles overlap candidates, owns the selection
Box3 helper, synchronizes hierarchy/inspector state, and frames selected bounds.

## Ownership and cleanup

- The adapter owns world geometry/material disposal.
- The viewport owns renderer, controls, helpers, ResizeObserver, and animation
  frame disposal.
- The registry owns references and layer state only.
- The shell owns DOM nodes only.
- `editor-app.js` defines disposal order and makes it idempotent.

This separation prevents reloads from leaving animation loops, WebGL resources,
or visibility changes behind.

## Extension points

Later checkpoints add services beside the registry instead of expanding the
adapter into a monolith:

- selection state and raycasting service
- transform command service and Three.js TransformControls
- declarative override schema/store/serializer
- inspector bindings that emit commands rather than mutating directly

Material catalogs, road-specific editing, persistence/export, and AI commands
remain later modules. The archived `CONTRACTS_PHASE1_PROVISIONAL.md` is useful
research for those phases, but it is not binding.
