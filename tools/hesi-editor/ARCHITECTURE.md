# HESI Editor Architecture

## Checkpoint 1 boundary

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
        -> world-adapter.js
        -> entity-registry.js
```

## Responsibilities

### `editor-app.js`

Composition root and lifecycle owner. It creates the shell, viewport, registry,
and adapter; wires toolbar/layer events; publishes `window.hesiEditor` for smoke
checks; and disposes each owned resource on unload.

### `ui/editor-shell.js`

Creates all editor regions and visible loading/error states using DOM APIs. UI
controls call narrow callbacks and never reach into `HighwayMap` or game code.
Disabled selection, transform, road, asset, material, and inspector surfaces
make unsupported functions explicit.

### `viewport.js`

Owns Three.js rendering: Scene, PerspectiveCamera, WebGLRenderer,
OrbitControls, helpers, ResizeObserver, animation loop, focus framing, and
statistics. `setWorldGroup()` is the only scene attachment boundary for a
world adapter.

### `world-adapter.js`

Returns a uniform adapter contract. The default representative strategy builds
a small editor-only highway scene with one high-level Object3D group for each
required layer. This keeps Checkpoint 1 fast and completely independent of
gameplay.

`?world=full` dynamically imports only `/js/map.js`, instantiates `HighwayMap`
without a game scene, and exposes the generated world as one read-only entity.
It does not import `game.js`, `traffic.js`, `physics.js`, `audio.js`, `garage.js`,
`save.js`, or `ui.js`. Any full-mode failure produces a representative fallback
with a user-visible warning.

### `entity-registry.js`

Pure foundational state with no Three.js import. It enforces the entity and
layer contracts, rejects duplicate IDs, indexes high-level entities, applies
layer visibility, emits change notifications, and clears without disposing
adapter-owned objects.

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

Checkpoint 2 should add services beside the registry instead of expanding the
adapter into a monolith:

- selection state and raycasting service
- transform command service and Three.js TransformControls
- declarative override schema/store/serializer
- inspector bindings that emit commands rather than mutating directly

Material catalogs, road-specific editing, persistence/export, and AI commands
remain later modules. The archived `CONTRACTS_PHASE1_PROVISIONAL.md` is useful
research for those phases, but it is not binding.
