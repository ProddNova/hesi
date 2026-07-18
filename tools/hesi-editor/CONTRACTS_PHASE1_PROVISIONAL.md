# HESI Editor — Build Contracts (Phase 1)

This archived file records Kimi's provisional contract for the original broad Phase 1. Every
module must implement exactly these interfaces so independently built parts
integrate without rework. When the real implementation needs to deviate,
update this file in the same commit.

## Ground rules

- Vanilla ES modules. No framework, no bundler, no new runtime dependencies.
- The editor page uses an importmap: `three` → `/node_modules/three/build/three.module.js`,
  `three/addons/` → `/node_modules/three/examples/jsm/`.
  The dev server serves the REPO ROOT, so absolute paths like `/js/map.js`,
  `/data/...`, `/node_modules/...` all resolve. The editor is dev-only:
  `node_modules/` is gitignored and that is fine (the game never loads the editor).
- Style: match the repo — 2-space indent, single quotes, semicolons, JSDoc
  header comment per file (see `tools/extract-osm.js` / `.devtests/e2e.mjs`).
- The editor must never import gameplay modules (`game.js`, `traffic.js`,
  `physics.js`, `audio.js`, `garage.js`, `ui.js`, `save.js`). It imports
  `js/map.js` only (`HighwayMap`).
- Nothing under `tools/hesi-editor/` may be imported by `js/` runtime code
  except through the single guarded dev hook described in §10.

## Directory layout and file ownership

```
tools/hesi-editor/
  CONTRACTS.md               (this file — coordinator-owned)
  README.md                  (shell agent, then docs agent)
  ARCHITECTURE.md            (shell agent, then docs agent)
  MAP_API_REPORT.md          (map-research agent)
  server.mjs                 (shell agent)
  index.html                 (shell agent)
  styles.css                 (shell agent)
  src/
    main.js                  (shell agent)
    shell/
      layout.js              (shell agent)
      viewport.js            (shell agent)
      events.js              (shell agent)
    core/
      ids.js                 (core-data agent)
      schema.js              (core-data agent)
      serializer.js          (core-data agent)
      overrides.js           (core-data agent)
      commands.js            (core-data agent)
      ai-commands.js         (core-data agent)
      validators.js          (core-data agent)
    world/
      map-adapter.js         (world agent)
      entity-registry.js     (world agent)
      materials.js           (material-lab agent)
      lighting-adapter.js    (lighting agent)
    features/
      manifest.js            (shell agent — static list, tolerant loader)
      outliner.js            (world agent)
      layers.js              (world agent)
      gizmos.js              (interaction agent)
      inspector.js           (interaction agent)
      project.js             (persistence agent)
      material-lab.js        (material-lab agent)
      texture-lab.js         (material-lab agent)
      road-sample.js         (material-lab agent)
      placement.js           (placement agent)
      lighting.js            (lighting agent)
      ai-panel.js            (ai-panel agent)
    runtime/
      game-override-loader.js (persistence agent)
  test/
    unit/                    (core-data agent first; others may add files)
      *.test.mjs             (node:test, pure JS — no three, no DOM)
    smoke/
      editor.smoke.mjs       (smoke/docs agent — playwright)
  assets/                    (editor-only preview textures etc., if needed)
data/editor/
  README.md                  (persistence agent — format doc)
  (world-overrides.json etc. are created by Export; never committed
   with real edits except neutral test data, removed before final commit)
HESI_EDITOR_STATUS.md        (repo root — docs agent)
package.json                 (repo root — shell agent, see §11)
js/game.js                   (persistence agent — dev hook only, see §10)
```

## §1 Editor shell API (`src/shell/`)

`main.js` boots everything:

```js
import { createShell } from './shell/layout.js';
const shell = await createShell(document.getElementById('app'));
// shell = { bus, viewport, panels, statusBar }
```

- `bus` — tiny event emitter: `on(name, fn) → off()`, `emit(name, payload)`.
  Standard events (emit on `bus`):
  - `world:loaded` `{map}` — after HighwayMap finished building.
  - `entities:changed` `{reason}` — registry contents or flags changed.
  - `selection:changed` `{ids: string[]}` — current selection (single or empty in Phase 1).
  - `transform:changed` `{id}` — gizmo/inspector moved an entity (committed → command).
  - `layers:changed` `{}` — layer visibility/lock toggled.
  - `overrides:changed` `{group}` — override store mutated.
  - `dirty:changed` `{dirty:boolean}`.
  - `command:applied` `{label}` — undo/redo/execute happened.
  - `ai:batch` `{count, dryRun}` — AI batch previewed/applied.
- `viewport` — owns renderer/scene/camera/orbit controls + rAF loop:
  - `scene`, `camera`, `renderer`, `canvas` (THREE objects, exposed read-only).
  - `setWorldGroup(group)` — adds the HighwayMap group to the editor scene.
  - `focusOn(box3OrObject3D)` — frames camera on target.
  - `onFrame(cb)` — extra per-frame hook.
  - `screenshot()` — returns dataURL (for acceptance captures if needed).
  - Editor camera starts near `map.initialSpawn.position` once world loads.
- `panels.register({id, title, region, mount, unmount?})` — regions:
  `'left' | 'right' | 'bottom' | 'toolbar'`. `mount(el, ctx)` builds UI in `el`.
  Left/bottom panels get tabs when several register in the same region.
- `statusBar`: `setStatus(text)`, `setDirty(bool)`, `showError(err)` (also a
  dismissible overlay for hard errors, plus a loading overlay with progress text).

## §2 Feature modules (`src/features/`)

`manifest.js` is a static array:

```js
export default [
  './layers.js', './outliner.js', './gizmos.js', './inspector.js',
  './project.js', './material-lab.js', './placement.js', './lighting.js',
  './ai-panel.js',
];
```

`main.js` dynamic-imports each entry **tolerantly**: a missing/failing module
logs to console + status bar and does not stop the others. Each feature module
default-exports `async function init(ctx)`. `ctx` (built by `main.js`):

```js
{
  bus, viewport, panels, statusBar,
  registry,   // §4  (null until world:loaded — features must wait for the event)
  overrides,  // §6  OverrideStore singleton
  commands,   // §7  CommandStack singleton
  materials,  // §9  material catalog API (null until world:loaded)
  lighting,   // lighting adapter (null until world:loaded)
  map,        // HighwayMap instance (null until world:loaded)
}
```

Features must subscribe to `world:loaded` and tolerate being mounted before
the world exists (show an empty/disabled state).

## §3 Stable entity IDs (`src/core/ids.js`)

Pure module, no three/DOM. Stable ID = `category:descriptor`, e.g.
`building:industrial_14`, `pillar:r11_0#42`, `road:c1_inner`.
- `sanitizeIdPart(str)` — lowercase, `[a-z0-9_#.-]`, deterministic.
- `makeEntityId(category, descriptor)` → string.
- `parseEntityId(id)` → `{category, descriptor}`.
- `isValidEntityId(id)` → boolean.
Uniqueness: registry appends `_2`, `_3` … deterministically (generation order).

## §4 Entity registry (`src/world/entity-registry.js`)

```js
createEntityRegistry({ map, group, bus }) → registry
registry.getAll() → EditorEntity[]
registry.getById(id) → EditorEntity | null
registry.getByCategory(category) → EditorEntity[]
registry.categories() → string[]           // sorted
registry.setVisible(id, bool)
registry.setLocked(id, bool)
registry.applyTransform(id, {position?, rotation?, scale?})  // arrays of 3
registry.focusBox(id) → THREE.Box3 | null
```

`EditorEntity` (plain serializable view + one live ref):

```js
{
  id, type, category,            // category in §5 list
  name,                          // human label
  position: [x,y,z], rotation: [x,y,z], scale: [x,y,z],
  visible: true, locked: false,
  source: 'generated' | 'placed',
  properties: {},                // type-specific editable metadata
  object3d: null | THREE.Object3D // runtime ref — never serialized
}
```

Registry scans the built map group ONCE after load, classifying children by
map structure (routes, serviceAreas, wallSegments, named groups, material
keys) — see MAP_API_REPORT.md. Not every THREE child becomes an entity;
group meaningless sub-meshes into one entity (e.g. all guardrail meshes of a
route = one entity). `visible`/`locked` are registry flags layered on top of
`object3d.visible` and gizmo behaviour — overrides capture the flag, not the
mesh.

## §5 Layers

Categories (exact strings): `roads`, `markings`, `guardrails`, `pillars`,
`buildings`, `props`, `vehicles`, `garage`, `lighting`, `terrain`, `materials`.
Layer state: `{visible: true, locked: false}` per category, kept in the
registry. Changing a layer applies to all entities of that category and emits
`layers:changed`. Selection ignores entities in hidden or locked layers.

## §6 Override store (`src/core/schema.js`, `serializer.js`, `overrides.js`)

File format v1 (all four top-level keys always present):

```json
{
  "version": 1,
  "entityOverrides": {
    "building:industrial_14": {
      "position": [12, 0, -8], "rotation": [0, 1.2, 0],
      "scale": [1.1, 1.1, 1.1], "visible": true, "locked": false
    }
  },
  "materialOverrides": {
    "road.main": {
      "color": "#1a1d26", "opacity": 1, "repeat": [4, 4], "rotation": 0,
      "texture": "textures/asphalt-01.png",
      "processing": {"pixelate": 4, "blur": 1, "brightness": 0, "contrast": 0.1,
                     "saturation": 0, "filter": "nearest", "maxSize": 256},
      "emissiveIntensity": 0.2
    }
  },
  "placedObjects": [
    {"id": "placed:box_1", "assetId": "primitive.box", "name": "Box 1",
     "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1],
     "materialId": "concrete", "visible": true}
  ],
  "lightingOverrides": {
    "ambientIntensity": 1.0, "ambientColor": "#3c4a66",
    "fogColor": "#050713", "fogDensity": 0.00125,
    "skyColor": "#03050e", "exposure": 1.0
  }
}
```

- `validateOverrideData(json)` → `{ok, errors: [{path, message}]}` — checks
  types, ranges (finite numbers, scale > 0, 0 ≤ opacity ≤ 1, arrays of 3),
  known keys, version === 1, no duplicate placed IDs, `texture` is a string
  path (no `javascript:`/data-with-script URLs), string length caps.
- `serializeOverrides(store)` → deterministic string: sorted keys at every
  level, numbers rounded to 4 decimals (trim trailing zeros), 2-space JSON.
- `createOverrideStore()` →
  `{data, dirty, setEntityOverride(id, patch), clearEntityOverride(id),
    setMaterialOverride(id, patch), addPlacedObject(obj), removePlacedObject(id),
    setLighting(patch), reset(), load(json) → {ok, errors}, export() → string}`.
  Every mutator flips `dirty` and emits nothing itself — the store takes the
  `bus` and emits `overrides:changed` + `dirty:changed`.

## §7 Undo/redo (`src/core/commands.js`)

Command = `{type, label, do(ctx), undo(ctx)}` — compact reversible ops, never
world snapshots. `createCommandStack()` →
`{execute(cmd), undo(), redo(), canUndo(), canRedo(), clear(), history() → [{label, type}]}`.
History capped at 100. `execute` runs `do`, pushes, clears redo, emits
`command:applied`. Built-in factories (used by UI AND ai-commands):
`transformCommand(registry, id, before, after)`,
`visibilityCommand(registry, id, visible)`,
`lockCommand(registry, id, locked)`,
`materialCommand(materials, id, before, after)`,
`addPlacedCommand(store, registry, obj)`,
`removePlacedCommand(store, registry, id)`,
`lightingCommand(adapter, before, after)`.

## §8 AI command API (`src/core/ai-commands.js`)

Supported `command` values: `setEntityTransform`, `setEntityVisibility`,
`setMaterialProperty`, `assignMaterial`, `placeObject`, `deletePlacedObject`,
`setLightingProperty`.

```js
validateAiCommand(cmd) → {ok, errors: string[]}
applyAiBatch(batch, ctx, {dryRun = false} = {})
  → {ok, applied: number, errors: [{index, command, message}], preview: [...]}
```

- `batch` = array of command objects (or `{commands: [...]}`).
- dry-run validates everything and returns `preview` describing each change
  (before/after values) WITHOUT mutating anything.
- Real application is atomic: validate all first; any error → nothing applied,
  `ok:false`, per-command error messages.
- Each applied command goes through the undo stack (one undo step per batch
  via a composite command).
- Unknown entities/materials/commands are validation errors, not exceptions.

## §9 Material catalog (`src/world/materials.js`)

```js
createMaterialCatalog({map, bus}) → catalog
catalog.list() → [{id, label, kind, supports:{texture,opacity,emissive,repeat}}]
catalog.get(id) → THREE.Material
catalog.getProps(id) → current editable props (color hex, opacity, repeat,
                       rotation, emissiveIntensity, texture info)
catalog.applyOverride(id, props)   // mutates live material, remembers base
catalog.reset(id)                  // restores captured base state
```

Catalog IDs (map keys exist on `map.materials`, see MAP_API_REPORT.md):
`road.main`→`road`, `road.shoulder`→`roadService`, `road.alt`→`roadAlt`,
`concrete`→`concrete`, `barrier`→`barrier`, `pillar`→`railMetal`,
`building.facade`→`facadeIndustrial` (representative; list all four facades
as `building.facade.office|dark|hotel|industrial` too),
`marking`→`marking`, `garage.floor`/`garage.wall`→resolved from service-area
meshes if identifiable, else omitted with a note. `vehicle` and `prop`
categories are editor-side placeholder materials for placed objects.
Catalog must capture each material's base state BEFORE first override so
`reset` and dirty-tracking work.

## §10 Runtime dev hook (`js/game.js` + `src/runtime/game-override-loader.js`)

The ONLY change to game runtime code, near where `this.map` is built:

```js
// Dev-only: apply exported editor overrides (?editorOverrides=1). The editor
// itself is never imported by the game; this loads plain JSON only.
if (new URLSearchParams(location.search).get('editorOverrides') === '1') {
  try {
    const { applyEditorOverrides } =
      await import('../tools/hesi-editor/src/runtime/game-override-loader.js');
    await applyEditorOverrides({ map: this.map, scene: this.roadScene });
  } catch (e) { console.warn('editor overrides skipped', e); }
}
```

Loader fetches `/data/editor/material-overrides.json` and
`/data/editor/lighting-overrides.json` (404-tolerant), validates with the
same schema module, applies to `map.materials` / scene fog+background.
Without the query param nothing loads; with the param but no files, the game
behaves exactly as production. Top-level `await` is NOT allowed in game.js —
wrap in the existing async boot flow; match surrounding style.

## §11 `package.json` (repo root, new — the game has none today)

```json
{
  "name": "shutoko-nights",
  "private": true,
  "scripts": {
    "editor": "node tools/hesi-editor/server.mjs",
    "editor:dev": "node tools/hesi-editor/server.mjs",
    "editor:test": "node --test tools/hesi-editor/test/unit/",
    "editor:smoke": "node tools/hesi-editor/test/smoke/editor.smoke.mjs",
    "start": "python -m http.server 8080"
  }
}
```

No `"type"` field (repo `.js` files are browser modules; node scripts use
`.mjs`). No dependencies — three/playwright already exist locally but stay
unmanaged. Do not touch `render.yaml` (static deploy, no build step).

## §12 Dev server (`server.mjs`)

Node `http` static server, port `8081` (env `HESI_EDITOR_PORT` overrides),
serving the repo root with correct MIME types (`js/mjs` → `text/javascript`,
plus html/css/json/svg/png/webmanifest). `/` and `/editor` redirect to
`/tools/hesi-editor/index.html`. Log the editor URL on start. No deps.

## §13 Editor page skeleton

`index.html`: dark theme matching the game's night palette (`#060a12`,
cyan/amber accents), importmap (above), `<script type="module"
src="./src/main.js">`. Layout grid: toolbar top / left scene+layer panel /
center canvas / right inspector / bottom asset+material tabs / status bar.
Loading overlay + error overlay elements live in the shell, styled in
`styles.css`.

## §14 Tests

- Unit: `node --test tools/hesi-editor/test/unit/` — pure JS only
  (schema/validator, serializer determinism, ids, command stack undo/redo,
  ai-command validation + dry-run + atomic rejection, override store).
- Smoke: playwright (`test/smoke/editor.smoke.mjs`), pattern copied from
  `.devtests/e2e.mjs` (own tiny server; chromium from local node_modules):
  editor loads without console errors, canvas renders, world group has
  children, clicking selects an entity, gizmo appears, material preview
  canvas updates, export produces valid v1 JSON.
