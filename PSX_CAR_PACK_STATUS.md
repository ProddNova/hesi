# PSXStyle custom car pack status (2026-07-23)

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

- The pack is not loaded or downloaded at boot.
- Enabling the option fetches only the selected body and one wheel OBJ.
- Switching cars aborts stale requests and disposes the previous geometries and
  materials after the replacement shaders are precompiled.
- Disabling the option aborts pending work, removes the car and disposes all of
  its GPU resources.
- Body materials use lightweight Lambert/basic shaders with no texture maps,
  no transparency and no shadows.
- The four rims share one `InstancedMesh`; the four tires share another. Wheel
  steering updates those two small instance buffers only when the angle changes.
- The procedural player car remains the zero-download fallback and retains its
  headlight spotlights.
- Saves created by the former GLB option migrate to `JapanLegendaryDrifter`
  with scale `1.0`; enabled/disabled state is preserved.
- Service-worker caching is on demand: a model becomes offline-ready after its
  first selection, but the 7.12 MB catalog is never added to the boot cache.

## Verification

Run:

`node .devtests/psx-car-pack-probe.mjs`

The probe checks all 50 files, live menu switching, persistence, lazy requests,
GPU cleanup, console errors and road rendering budgets.

Observed in mobile Chromium:

| Metric | Procedural car | PSX car |
|---|---:|---:|
| Full-scene draw calls | 140 | 134-135 |
| Full-scene triangles | 81,754 | 86,209-87,024 |
| Added GPU textures | 0 | 0 |
| Same-run frame p50 | 133.4 ms | 133.4 ms |

Typical cars cost 6-7 draw calls and roughly 4,500-5,500 triangles. The
heaviest model in the full catalog remains below 17,400 triangles and 10 draw
calls. The deleted GLB contained 35 primitives, 18 materials and roughly
21,000 triangles.

`npm run editor:test` also passes all 129 tests.
