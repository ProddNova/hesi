# Performance foundation status (2026-07-14)

## Targeted PC/iPad pass (2026-07-24)

The first optimization pass was validated with the newer real gameplay capture
`hesi-diagnostic-2026-07-24_17-58-43-371.json`, recorded at 1.4x traffic.
It averaged 99.3 fps overall and 96.1 fps while driving: the 144 fps objective
was not reached. Driving frame time was 10.0 ms p50, 14 ms p95 and 17 ms p99.
Profiled CPU averaged 8.57 ms: 5.56 ms render, 1.86 ms traffic, 0.40 ms physics,
0.01 ms map and 0.74 ms other.

The batching work did reduce sustained draw calls from roughly 369-515 in the
older capture to 143-192, but this translated to only about +1.4 fps while
driving. The earlier headless workload prediction was therefore not a valid
proxy for the real laptop and is superseded by the figures above.

The second pass keeps the exact original player `SpotLight` and targets the
measured costs instead:

- desktop starts at 0.82 internal render scale and iPad at 0.72, with a
  frame-time governor that can lower or recover scale while driving;
- WebGL MSAA is disabled on both profiles;
- traffic simulation uses lightweight single-sample lane queries, indexed
  junction edges and lane buckets rather than repeated all-vehicle scans;
- distant/behind traffic stays simulated but is omitted from render batches;
- the generated road world has static world matrices after boot, while the
  camera, player/headlight and animated markers are updated explicitly;
- desktop retains the 144 fps presentation target and iPad the 30 fps target.

The synthetic Chromium/SwiftShader performance probe becomes pathological when
the restored dynamic spotlight is present, so it remains useful only for
structural regression checks. It must not be quoted as proof of either target.
Final FPS confirmation requires a new diagnostic from the laptop and a separate
one from the physical iPad.

Current verification:

- 84-vehicle direct traffic benchmark: 0.243 ms mean, 0.287 ms p95;
- traffic behavior and indicator-direction probes: PASS;
- browser traffic/visual probe: 13/14; the only failure is its obsolete
  immortality assertion (the current game intentionally has three lives);
- real-world deterministic build test: PASS;
- JavaScript syntax checks: PASS;
- complete editor/runtime unit suite: 150/150.

The laptop diagnostic reports `RTX 5050 Laptop GPU`, despite the device
description saying RTX 5060. Windows/NVIDIA GPU selection should be checked if
the machine is expected to expose a 5060.

## Historical foundation (2026-07-14)

Scope: measurement foundation after the adaptive road-frame pass. No broad
refactor and no speculative optimization were performed. Merged geometry per
chunk/material, repeated-prop instancing, chunk visibility and resolution
quality profiles are unchanged. Low quality still uses the same road frames;
it reduces resolution/effects rather than damaging the drivable silhouette.

## Repeatable probe

`.devtests/performance.mjs` records three pure-node map builds and a browser
run at an 844×390 mobile viewport, device scale factor 2, Medium quality. The
browser is placed at the established `k1-industrial` landmark with density-1
traffic (44 active cars in both comparison runs), then samples 90 animation
frames. This intentionally matches the prior `landmarks.mjs` checkpoint.

The probe records:

- map build time (three runs + median, plus the browser's direct build timer);
- full-scene and visible/rendered triangle counts;
- draw calls, geometry count and texture count;
- visible and total chunk counts;
- internal resolution, active traffic and mean/p50/p95 frame timing;
- browser errors.

It fails when draw calls exceed 175, visible triangles exceed 70k, median
headless build exceeds 4 s, frame p95 exceeds 150 ms, or browser errors occur.

## Measured baseline and current result

Baseline is the requested starting commit `10c3c39`; current is the Phase 1
commit `fa387dc` plus the measurement-only timer/probe. Both were measured by
the same probe, runtime, Three.js build, viewport, location and traffic count.

| Metric | `10c3c39` baseline | Current | Result |
|---|---:|---:|---|
| Headless map build, median of 3 | 1,909.9 ms | 3,197.8 ms | PASS (<4 s) |
| Browser map build | not instrumented | 2,502.6 ms | recorded going forward |
| Boot-to-map | 3,361.3 ms | 4,549.7 ms | context only (includes module/browser boot) |
| Visible triangles | 43,650 | 56,732 | PASS (<70k) |
| Draw calls | 170 | 166 | PASS; no increase |
| Renderer geometries | 423 | 437 | +14 |
| Renderer textures | 31 | 37 | +6 |
| Visible / total chunks | 11 / 234 | 11 / 234 | unchanged |
| Active traffic | 44 | 44 | matched |
| Frame mean | 83.89 ms | 88.33 ms | +5.3% under headless SwiftShader |
| Frame p50 / p95 | 83.3 / 100.0 ms | 83.4 / 100.1 ms | effectively unchanged |
| Full-scene triangles | 956,632 | 1,643,936 | expected adaptive-frame memory cost |
| Full-scene meshes / geometries | 4,680 / 2,666 | 4,688 / 2,674 | +8 / +8 |

The same-location baseline closely reproduces the earlier 167-call / 43.9k
landmark checkpoint; the few-call difference is normal frame/traffic timing.
The smooth-road pass adds geometry but stays inside all pass budgets, keeps
draw calls flat, and does not change p50/p95 approximate frame timing. Because
no measured hot spot justified a separate code change, this phase deliberately
stops at the performance foundation.

## Verification

- `node .devtests/performance.mjs`: PASS regression limits.
- `node .devtests/landmarks.mjs`: density 1× 167 calls / 61,172
  triangles; density 3× 192 / 44,804; no page errors.
- `node .devtests/road-surface-probe.mjs`: PASS geometry + dash limits.
- `node .devtests/e2e.mjs`: 25/25 after the road pass.
- `node .devtests/osm-validate.mjs`: known 2 / 21 / 47 / 50 failures
  unchanged; geometry hygiene 0.

Real-device iPhone validation remains a manual release check because
SwiftShader timing is useful for regression comparison, not a proxy for an
iPhone GPU or thermal behavior.

## Dense silhouette follow-up (2026-07-14)

The seamless-road pass adds a dedicated `surfaceFrames` level while retaining
the 48,969-frame coarse level for non-silhouette consumers. Low quality uses
the same dense road silhouette; it still removes wet-road effects rather than
coarsening the drivable surface.

The performance probe now reports true stored triangles by counting each
shared `BufferGeometry` once. It also retains the older per-mesh triangle
reference count for comparison, enforces the requested 170 draw-call ceiling,
and fails above 2 million stored triangles.

Same-machine comparison from requested start `1dd0812` to the final pass:

| Metric | `1dd0812` | Dense silhouette | Result |
|---|---:|---:|---|
| Headless map build, median of 3 | 2,068.9 ms | 2,829.8 ms | PASS (<4 s) |
| Browser map build | 1,888.5 ms | 2,381.8 ms | recorded |
| Visible triangles | 56,708 | 66,286 | PASS (<70k probe; <90k target) |
| Draw calls | 165 | 170 | PASS (<=170) |
| Full-scene triangle references | 1,643,936 | 2,004,340 | context |
| Full-scene stored triangles | not previously reported | 1,959,082 | PASS (<2m) |
| Renderer geometries / textures | 413 / 31 | 423 / 31 | bounded |
| Visible / total chunks | 11 / 234 | 11 / 234 | unchanged |
| Active traffic | 44 | 44 | matched |
| Frame mean / p50 / p95 | 69.07 / 66.7 / 83.4 ms | 62.59 / 66.6 / 66.7 ms | no SwiftShader regression |

Final `node .devtests/performance.mjs`: PASS. The map-build increase buys the
dense road silhouette while staying 1.17 s below the required ceiling; mobile
visible geometry rises by 9,578 triangles and remains below the previous 70k
probe limit. Draw calls land exactly on the requested ceiling without changing
chunk count or traffic density.
