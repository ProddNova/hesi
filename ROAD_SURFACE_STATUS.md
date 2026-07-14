# Road surface + markings single-frame pass — status (2026-07-14)

Scope: visible asphalt continuity, lane-divider/edge-line continuity, and
agreement between the rendered surface and the analytic road sampler
(`getRoadInfo`). `js/physics.js` untouched; `data/routes.json`, the
extractor and the route topology untouched.

## Phase 0 — audit findings

How each consumer built its geometry BEFORE this pass:

| Consumer | Evaluator | Longitudinal samples | Orientation frame |
|---|---|---|---|
| Physics (`getRoadInfo`) | `route.curve.getPointAt(u)` (Catmull-Rom, arc-length param) at the projected `u`; height `curveY(s) + tan(bank(s))·lateral` | analytic — any `s` | horizontal normal + bank tilt |
| Asphalt deck (`_buildRouteGeometry`) | same curve | fixed step (30 m arterial / 24 m loop / 16 m ramp / 14 m service), linear quads between | same frame at stations |
| Dashed dividers | same curve | own stations every 15 m (26 m service) | **yaw-only horizontal instanced box, 6.2 m** |
| Edge / median lines | same curve | own stations every 21 m (30 m service) | **yaw-only horizontal instanced box, ~19.8 m** |

All four consumers already shared the spline evaluator and elevation
source. The divergence was in interpolation, station placement,
orientation — and, decisively, **face winding**:

1. **The deck was wound back-facing (the true root cause of the "glass
   floor").** Every deck quad's front face pointed DOWN, so the
   single-sided road material culled the real road surface when seen
   from above. What the player has been seeing as "asphalt" is the
   fascia **underside**, drawn 0.5 m (ground) / 1.35 m (elevated) below
   the physics surface — and wound to face UP. Confirmed by a
   culling-aware raycast at spawn: physics height 29.99, first visible
   surface `concreteDark` at 28.59; deck (29.97) and markings (30.01)
   only appear when forced DoubleSide. Consequences, matching the
   symptom list exactly: the car rides an invisible plane ~0.5–1.35 m
   above the visible mesh; and the visible "asphalt" jumps 0.85 m
   wherever `fasciaDepth` switches at the elevated threshold
   (y > 2.5 m) — the reported asphalt steps. The barriers/rails/walls
   never showed the problem because their materials are DoubleSide;
   the old marking BOXES showed *some* face everywhere because a box
   always has an up-facing face.
2. Markings were world-horizontal, yaw-only instanced boxes — no pitch
   on grades, no roll on banking. 37.5 % of edge-line box ends sat
   >0.10 m off the deck, 19.9 % >0.25 m, worst 2.16 m (`ramp_46`):
   the stepped dashes on descents and chord-like disconnected segments
   on curves.
3. The deck linearised the curve at a fixed step with no error bound:
   chord error vs the analytic surface up to **0.49 m vertical**
   (`ramp_17@102`) and metres laterally on tight loops. Physics follows
   the curve, so even with correct winding the car would hover/sink by
   the sagitta between stations.
4. The bank frame FLIPPED at S-curve inflections: `_bankAt` clamps
   `curvature·620` to ±0.075, which saturates for nearly any bend, so
   the roll snapped −0.075→+0.075 within ~4 m at every inflection — a
   0.72 m deck-edge twist step (measured `r6_3@1805`, ±0.367 m per
   edge) shared by physics and visuals.

## Phase 1 — the authoritative road frame

One shared sampler now feeds every rendered road surface (`js/map.js`):

- **`_frameAt(route, s)`** — THE road frame. Centre position, full 3D
  tangent, horizontal base normal, banked lateral, surface up, bank,
  half-width, lane data, grade — computed from the same
  `curve.getPointAt` / `_bankAt` / `_halfWidthAt` primitives that
  `getRoadInfo` samples for physics (deck surface
  `y(s,l) = curveY(s) + tan(bank(s))·l`). Deterministic in `s`: no
  parallel-transport drift, no flips on closed loops.
- **Slew-limited bank** (`_buildBankTable`): the raw clamped-curvature
  bank is sampled every ~6 m per route and smoothed with a ±24 m moving
  average, served by table lookup from `_bankAt`. Roll transitions now
  spread over ~50 m instead of snapping at inflections. Because
  `_bankAt` is the single source for physics corridors AND rendering,
  all consumers stay in agreement by construction (and runtime lookups
  got cheaper than the old two-curve-evaluation path).
- **Error-bounded refinement** (`_prepareRenderFrames`): stations seed
  at the old per-kind step, then each span subdivides while the drawn
  chord deviates from the analytic surface by >0.045 m vertically or
  >0.18 m laterally (checked at centre + both deck edges so bank twist
  counts; fine spans below 8 m subdivide on vertical error only; min
  segment ~1.6 m). Deck, fascia, barriers, rails, tunnel shells and
  wallSegments all consume these frames.
- **Winding fixed** for the deck top (up), fascia sides (outward) and
  underside (down). The visible asphalt IS the physics surface now.
- **Markings are painted onto the deck** (`_paintStrip`): dashes, solid
  edge lines and (for any future bidirectional route) median lines are
  merged quads that walk the SAME render frames and linearly
  interpolate the same corner points the deck triangles interpolate,
  lifted 0.055 m. They bend with curves, pitch with grades, roll with
  banking, follow width tapers (per-station half-width), skip stations
  where a taper leaves no room, and cannot float off the asphalt by
  construction. Edge lines are continuous strips (previously 19.8 m
  boxes with 1.2 m gaps).

## Verified at this checkpoint

- Render-vs-physics chord error after refinement: worst centre-line
  0.076 m, worst deck-edge 0.076 m (both at `ramp_17`, a known DATA
  kink — see below); means 0.001–0.007 m. Was 0.49 m / 0.367 m.
- `node .devtests/osm-validate.mjs`: **identical failure counts to the
  Phase C checkpoint** (rail 2 / overlap 21 / ramp-drive 47 /
  smoothness 50 / hygiene 0) — no regression; those are extractor-data
  issues out of scope here.
- `CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/e2e.mjs`:
  **25/25**.
- `landmarks.mjs`: 167 draw calls / 43.9 k triangles at 1× density
  (checkpoint baseline 167 / 35.8 k; pre-rebuild budget 189 / 49.5 k).
  Map build ~3 s headless (was ~1.8 s).
- Visual: `.devtests/marking-shots.mjs` (new noclip screenshot tool)
  captures slope/curve/S-bend/gore spots; `-before` vs `-fixed` shots
  in `.devtests/shots/` show continuous curved strips on the climbing
  Rainbow Bridge deck, the ramp_17 dive and the old bank-flip S-bend.

## Out of scope — recorded for the next pass

- **Data-side height steps** (~40 spots, 0.20–0.31 m over 2 m at
  anchored branch zones, e.g. `diverge k5_1 -> ramp_17 [branch]`, the
  Hakozaki ramp family): physics and render now agree faithfully on
  these, so they read as real bumps. Fixing them is extractor
  `holdEndZone` work (PHASE_C_STATUS.md "ramp-drive"), forbidden here.
- Junction overlap clearances (21), rail-continuity checker acceptance
  (2), smoothness checker calibration (50) — unchanged Phase C residue.
- Gore chevron paint (`_dressGores`) and PA parking-stall paint are
  still yaw-only instanced boxes on near-flat surfaces; migrate to
  `_paintStrip` during the junction pass.
- `_pushBox`/other single-sided merged geometry (city, portals) was
  authored against the old winding assumptions in places and papered
  over with DoubleSide materials; only road/fascia/marking winding was
  corrected in this pass. An orientation audit of the remaining
  single-sided buckets would let several materials drop DoubleSide.
- Guardrail/prop/signage placement still uses per-station yaw frames
  (fine for vertical posts); junction topology untouched.

## Curve smoothness + dash continuity follow-up (2026-07-14)

The remaining visible faceting came from `_prepareRenderFrames` testing
only the 50% point of each span and then relaxing lateral error from
0.18 m to 1.0 m below 8 m. Quarter-shaped S-curves and uneven curvature
could therefore pass the test, while long nearly planar grades could keep
the original ~30 m station spacing. The worst still-refinable tangent
change was 25.08° over 7.99 m (`ramp_25`); the longest span was 29.999 m.

The refinement test now evaluates 25%, 50% and 75% against the rendered
chord at the centre and both deck edges. It bounds vertical error to
0.035 m, plan/lateral error to 0.30 m and full-3D tangent change to 3°,
with 24 m maximum and ~1.5 m minimum segment safeguards. Parent quarter
samples are reused as child midpoints to avoid redundant spline work.
The final network has 48,969 render frames. Its worst span is 23.97 m;
the worst still-refinable tangent change is 2.98°, vertical error 0.03496 m
and lateral error 0.29998 m. The literal 156.06° maximum is unchanged at
the same 1.97 m `k5_uturn_4` source-data kink: it is already below the
minimum render span and is not a long faceted chord.

Dash audit: the prior route loop already used route distance, so no chunk
phase restart was found. The focused probe records all 17,378 generated
dash intervals and reports zero phase errors. The visible intermittent
loss was narrow paint following the same under-refined chords (most
noticeable through curves); `_paintDashedStrip` now makes the route-absolute
phase contract explicit. A separate latent loss path was fixed in
`_paintStrip`: when a lane boundary crosses a width taper, the valid part
of the span is clipped at the width crossing rather than dropping the
whole span because one endpoint is too narrow.

Verification at this checkpoint:

- `node .devtests/road-surface-probe.mjs`: PASS (3.52 s representative
  headless build; repeated values are recorded by the performance pass).
- `node .devtests/osm-validate.mjs`: unchanged known counts — rail 2 /
  overlap 21 / ramp-drive 47 / smoothness 50; geometry hygiene 0.
- `node .devtests/e2e.mjs`: 25/25 in the mobile touch viewport.
- Chase + noclip screenshots: `.devtests/shots/M-*-before.png`,
  `.devtests/shots/M-*-after.png` and `.devtests/shots/M-*-chase-after.png`
  for C1, Wangan, the R6 S-bend, ramp_17 and the Rainbow ascent.

## Seamless road-silhouette follow-up (2026-07-14)

The 24 m / 3 degree / 0.30 m render level still exposed individual chords in
an elevated Route 11 Daiba view. The broad bridge curve read as roughly eight
straight pieces even though the previous numeric probe passed.

Road rendering now has two refinement levels, both sampled exclusively by the
same authoritative `_frameAt(route, s)`:

- `renderFrames` retains the measured coarse level (48,969 frames) for tunnel
  shells, wall metadata and other non-silhouette work;
- `surfaceFrames` is a dense superset (81,679 frames) used by asphalt, fascia
  sides, markings, parapet caps/outer faces and handrails. Every coarse frame
  object is reused by the dense level; no second road evaluator or surface was
  introduced.

Each coarse span is tested again at 25%, 50% and 75%, including centre and both
deck edges. Refinable spans are bounded to 8 m, 0.75 degrees tangent change,
0.06 m plan chord error and 0.03 m vertical chord error. The existing ~1.5 m
minimum-span safeguard remains for literal source-data kinks. Measured maxima
for spans longer than 3 m are 7.9971 m, 0.74973 degrees, 0.059998 m lateral and
0.027740 m vertical. The `k5_uturn_4` 156 degree source kink is unchanged but
occupies only 1.97 m.

The dense silhouette does not multiply unrelated detail. Barrier-suppression
projections remain cached at roughly 9 m, wall metadata and tunnel shells use
`renderFrames`, and the non-silhouette underside uses the coarse level. The
DoubleSide parapet/rail materials keep only the cap/outer silhouette sheets
needed from chase and exterior views, avoiding redundant dense inner sheets.

Repeatable visual probe:

`node .devtests/road-silhouette-shots.mjs before|after`

It captures the elevated Route 11 Daiba curve plus C1 and R6 elevated/chase
views with traffic and UI removed. The Route 11 before image exposes the old
7-8 chords; the after image reads as a continuous arc, with fascia, edge paint,
parapet and rail remaining coincident. C1 and R6 chase/elevated shots show the
same continuity through the tight curve and S-bend.

Final validation:

- `node .devtests/road-surface-probe.mjs`: PASS;
- `node .devtests/performance.mjs`: PASS;
- `node .devtests/e2e.mjs`: 25/25;
- `node .devtests/osm-validate.mjs`: unchanged known failures -- rail 2 /
  overlap 21 / ramp-drive 47 / smoothness 50; geometry hygiene 0. No unrelated
  OSM/data fix was made.

## Faceted analytic centreline — ROOT CAUSE fix (2026-07-15)

Route 11 still showed long straight sections joined by visible corners after
both render-frame subdivision passes. Audit at the exact screenshot spot
(`r11_0` 2100–2650 m, control points every 20–40 m) sampled the ANALYTIC
`route.curve` every 1 m and proved the curve itself was faceted — render
refinement had been faithfully reproducing an already-angular centreline:

- current uniform Catmull-Rom at `tension 0.05` (OSM routes; 0.14 default):
  bending concentrated in 1–3 m spikes of up to **7.68 deg/m at each control
  point**, separated by 15–56 m dead-straight chords inside the bend;
- same points with centripetal parameterisation: the same ~89 deg of total
  bend spreads at <= 1.09 deg/m with no straight chords inside the bend.

Cause: three.js `'catmullrom'` builds Hermite tangents as
`tension * (p2 - p0)`, so near-zero tension (chosen earlier to stop uniform-CR
overshoot between unevenly spaced nodes) collapses every span toward its
straight chord with a corner at the control point. The render subdivision
passes could never fix this — the faceting was in the curve, not the mesh.

Fix (`_registerRoute`): build every route curve as **centripetal Catmull-Rom**
over the exact same control points. Centripetal parameterisation is
shape-preserving on uneven spacing (no overshoot, loops or cusps — the
original reason for the low tension), still interpolates every control point
exactly (endpoints and junction anchor points unchanged), and spreads
curvature smoothly between points. The `tension` config knob was removed. One
authoritative curve continues to feed physics, deck, markings, fascia and
barriers, so alignment holds by construction.

Verified:

- `node .devtests/road-surface-probe.mjs`: PASS — and the smoother curve
  needs far less subdivision: 19,032 render frames / 42,564 surface frames
  (was 48,969 / 81,679), headless build ~2.0 s (was ~3.5 s), same error
  bounds (worst 0.0598 m lateral / 0.0300 m vertical / 0.75 deg refinable);
- `node .devtests/road-silhouette-shots.mjs centripetal`: the Route 11 Daiba
  bend now reads as one continuous arc (`S-r11-daiba-broad-curve-centripetal`
  vs the chorded `-final`); C1 and R6 shots equally continuous;
- `node .devtests/e2e.mjs`: **25/25**;
- `node .devtests/performance.mjs`: PASS (frame p50 50.1 ms on the probe's
  throttled mobile profile, within limits);
- `node .devtests/osm-validate.mjs`: rail-continuity **2 → 0**, overlap
  21 → 20, ramp-drive 47 → 49, smoothness 50 → 67. Every added failure is a
  height-step in the SAME documented extractor data-kink families (`ramp_17`
  / Hakozaki, `ramp_46`, `daikoku_pa_access` anchored zones) — the smoother
  plan curve shifts where the 1 m sampler lands on those existing bumps. The
  two `transfer jump` entries pre-exist at identical magnitudes (verified
  against a baseline run of the previous commit). No new failure class.
