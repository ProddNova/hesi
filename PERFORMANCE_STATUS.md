# Performance foundation status (2026-07-14)

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
