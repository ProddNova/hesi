# Centreline fairing — offline processed asset (routes-smoothed)

Status: **complete, verified** (starting commit `c80c358`).
Fixes the two defects the centripetal-spline commit exposed: small waves in
broad curves, and sharp bends that change direction abruptly instead of one
broad arc.

## 1. Diagnostic gate — where do the waves come from?

Mandate: prove whether the waves live in the raw OSM points or are introduced
by the spline before creating any new dataset. Instruments (all committed):

- `tools/diagnose-centreline.mjs` — sliding-window circle fits (shrink-free
  local road model): lateral residuals of the raw points, of the current
  centripetal spline, and of a candidate faired curve, against the same
  circles, plus overlay SVGs (`tools/diagnosis-r11_*.svg`).
- `tools/diagnose-loo.mjs` / `tools/diagnose-loo-calibrated.mjs` —
  leave-one-out: distance from each raw point to the same centripetal CR
  built through its neighbours *without* it, bias-calibrated on synthetic
  points lying exactly on the local circle. This measures the lateral wave
  that interpolating that point forces on ANY curve.

Findings:

| measurement | value |
|---|---|
| calibrated LOO on straights (wangan) | ~0.01 m — instrument reads clean data as clean |
| calibrated LOO on Route 11 bends | p50 0.46–0.52 m, p90 ~1.6 m, worst 2.6–2.7 m |
| share of all vertices forcing > 0.3 m wave | 33 % network-wide, 54 % on r11 |
| spline residual vs raw residual (same circles) | ≈ equal — the spline adds little of its own |
| interior vertices EXACTLY collinear with neighbours (<1 cm) | **74.5 %** (r11 68–71 %, wangan 90 %) |
| vertices with real geometry (>0.5 m off chord) | 22.6 % — almost nothing in between |

The bimodal collinearity fingerprint identifies the mechanism:
`tools/extract-osm.js` Douglas-Peucker-simplifies at **2.0 m tolerance**
(`DP_TOLERANCE`, line 46) and then re-subdivides the surviving polygon at
≤ 40 m by *linear interpolation along the chords*. So the committed "raw"
path is a polygon whose chords cut up to 2 m inside the true road, densified
with exactly-collinear points; the DP survivors concentrate the direction
change ("abrupt bends"). Any interpolating curve — any tension, any
parameterisation — must reproduce that polygon.

**Verdict: the waves are present in the raw points, not introduced by the
centripetal spline.** The spline fix (c80c358) stays; per the gate, the
offline processed centreline is justified.

## 2. Solution — `tools/build-smoothed-routes.mjs`

One-off Node tool; reads `data/routes.json` (untouched), writes
`data/routes-smoothed.json` + `.js`. Runtime (`js/map.js`) now imports the
processed asset; no runtime smoothing. Per route, XZ only:

- resample the raw polyline at 6 m;
- penalized least squares `min Σ w|p−q|² + λ Σ|Δ³p|²` (λ = 3e5, calibrated
  by `--sweep`): the **third-difference** penalty is curvature-*change*
  energy — constant-curvature arcs cost nothing, so bends are not shrunk,
  only oscillation and corner spikes are removed; banded Cholesky solve;
- lateral deviation from the raw path capped at 1.8 m by iterative
  reweighting (worst outlier network-wide: 2.13 m at a single extreme
  corner apex on ramp_31);
- **protected zones emit the raw vertices verbatim** (exact shape AND arc
  length — the runtime derives mouths/tapers/stations by walking metres
  along the curve): route endpoints (position + tangent), every edge
  connection station ±45 m, the full diverge/merge anchor-blend span
  (2×anchorSpan, mirroring `map.js`), PA gate + access-leg spans, and
  everything within 700 m of a grounded PA (the Daikoku stack, whose
  descent spirals are synthesized from surrounding geometry);
- **cross-route clearance guard**: same-level centrelines closer than the
  sum of their estimated half-widths + 1.4 m may never end up tighter than
  the raw pair was — offending nodes are pinned back to raw on both routes
  and re-solved (parallel carriageways cannot pinch);
- elevation preserved: output y sampled from the **raw centripetal curve**
  (the game's previous profile) at the projected plan position;
- closed routes (c1_2) solved with circular padding;
- every distance reference (tunnels, bridges, serviceAreas, edges, lengths)
  remapped onto the smoothed polyline by windowed projection.

`data/route-overrides.json` (optional, applied to raw points before
smoothing, then regenerate):

```json
{ "r11_0": [ { "op": "move",   "index": 72, "to": [x, z] },
             { "op": "insert", "after": 72, "point": [x, y, z] },
             { "op": "delete", "index": 5 } ] }
```

No overrides were needed to meet acceptance.

Regeneration workflow: `node tools/extract-osm.js` (if OSM refresh) →
`node tools/build-smoothed-routes.mjs` → run validators.

## 3. Debug overlay

`tools/centreline-viewer.html` (serve the repo statically, e.g. the e2e
server, then open `/tools/centreline-viewer.html`): raw OSM polyline +
points, current spline (centripetal CR through raw), processed centreline,
and curvature intensity (blue right / red left, brighter = tighter) for
either curve; route selector, pan/zoom, URL params
(`?route=r11_0&cx=-1140&cz=-3770&m=500&curv=1&curvold=0`) for scripted
screenshots. Before/after on Route 11: the current spline alternates
red/blue inside single bends (the waves); the processed centreline holds one
sign per bend with clean transitions.

## 4. Acceptance

| check | result |
|---|---|
| r11_0 curvature sign flips | 15.2 → **2.8 /km** (baseline instrument: `tools/fairing-metrics.mjs`) |
| r11_1 curvature sign flips | 17.4 → **2.1 /km**; curvature jerk 1.31e-3 → 3.05e-4 |
| r11_0 sharpest bend | R ≈ 74 m → R ≈ 100 m single continuous arc (overlay verified) |
| network mean flips | 11.6 → 6.9 /km (protected zones keep raw geometry by design) |
| junctions / topology | `junctions`, `groups`, edge graph byte-identical; only distances remapped |
| osm-validate | rail-continuity **0** (=baseline), overlap 18 (<20), ramp-drive 47 (<49), smoothness 62 (<67), hygiene 0; **no new failure signatures** — every remaining failure is a pre-existing raw-data family |
| road-surface-probe | PASS (worst lateral 0.06 m, vertical 0.03 m) |
| performance probe | PASS |
| e2e | **25/25** |

Traffic and player physics consume `route.curve` (built from the processed
points) unchanged — one authoritative curve as before.

## 5. Notes / known limits

- The Daikoku stack (±700 m of the grounded PA) and all anchor-blend spans
  keep raw geometry deliberately; waves there are accepted in exchange for
  byte-stable synthesized geometry (PA spirals, gores). If those areas ever
  need fairing, the synthesizers must anchor to physical points rather than
  stations first.
- The pre-existing `k5_1 → ramp_17` height-step family is a raw elevation
  spike (y jumps +4.5 m and back within 70 m at ramp_17 s≈70) — an extractor
  elevation issue, out of scope for this XZ pass.
- Root-cause option for a future pass: lower `DP_TOLERANCE` in
  `tools/extract-osm.js` and re-extract; the fairing tool remains valid on
  any re-extracted data.
