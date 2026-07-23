# PSXStyle player car pack status (2026-07-23)

## Scope

The old `3d/uploads_files_4887148_Toyota_Chaser.glb` custom car was removed.
The developer menu now exposes 50 selectable cars sourced from
`PSXStyleCars-DevEdition`.

The runtime asset subset lives under `3d/PSXStyleCars-DevEdition/`:

- 50 OBJ bodies;
- 11 OBJ wheel models;
- 7.12 MB total, versus 26.52 MB for the Unity authoring pack.

Unity metadata, prefabs, FBX duplicates, demo scenes, textures and spares are
not used by the browser and were intentionally not copied.

## Runtime design

- `JapanSedan` is the always-on default and the only playable/unlocked car.
- Boot fetches only the selected body and one wheel OBJ.
- Switching cars aborts stale requests and disposes the previous geometries and
  materials after the replacement shaders are precompiled.
- The developer menu exposes only the model picker; the enable toggle and scale
  control were removed.
- Body materials use lightweight Lambert/basic shaders with no texture maps,
  no transparency and no shadows.
- The four rims share one `InstancedMesh`; the four tires share another. Wheel
  steering updates those two small instance buffers only when the angle changes.
- The rectangular procedural car was removed. Its road anchor now contains only
  the headlight spotlights, and its garage slot is an empty compatibility anchor
  kept solely to preserve world-editor child indices.
- Existing saves migrate once to always-on `JapanSedan` at scale `1.0`.
- The world editor loads the same Japan Sedan model under the shared showroom
  anchor, so it is visible, selectable, movable and emitted directly into the
  garage build consumed by the game.
- Service-worker caching is on demand: a model becomes offline-ready after its
  first selection, but the 7.12 MB catalog is never added to the boot cache.

## Verification

Run:

`node .devtests/psx-car-pack-probe.mjs`

The probe checks the Japan Sedan default, the single playable-car catalog, the
picker-only UI, absence of procedural meshes, garage visibility/collision, all
50 picker models, persistence, GPU cleanup and browser console errors.

Japan Sedan costs 14,392 triangles and 6 draw calls. The heaviest model in the
full picker catalog remains below 17,400 triangles and 10 draw calls.

`npm run editor:test` passes all 130 tests. A dedicated garage browser probe
also verifies that `garage-part:0079` shows `JapanSedan`, attaches the transform
gizmo, records a move override and restores it through undo.
