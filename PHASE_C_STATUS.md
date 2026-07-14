# Phase C status — WIP checkpoint (2026-07-14)

Phases A (OSM extraction) and B (graph-driven generator) are committed and
green: e2e 25/25 on iPhone viewport, indicator/grip/traffic suites OK,
167 draw calls / 35.8k triangles (better than the 189/49.5k baseline).
Phase C (the new validation suite, `.devtests/osm-validate.mjs`) drove the
failure count from ~3,800 to ~120 through extractor/generator fixes; this
checkpoint lands everything mid-iteration so a fresh session can finish.

## Suite state at this checkpoint (`node .devtests/osm-validate.mjs`)

```
FAIL  rail-continuity      70900 checks,  2 failures
FAIL  overlap-clearance     3348 checks, 21 failures
FAIL  ramp-drive           42491 checks, 47 failures
FAIL  smoothness           212528 checks, 50 failures
PASS  geometry-hygiene    283511 checks,  0 failures
```

Full failure list: `.devtests/osm-validate-failures.txt` (regenerated on
each failing run). All classes below.

Verified AT this checkpoint commit: the counts above reproduce exactly,
and the browser e2e passes **25/25** (iPhone-like touch viewport,
`CHROMIUM_PATH=/opt/pw-browsers/chromium node .devtests/e2e.mjs`) — the
game boots, drives, scores, banks, refuels, tows, garages and saves on
the checkpointed map.

### rail-continuity (2)
- `escape correction left road shibaura_pa_access d=726 side=1`
- `escape correction left road daikoku_pa_access d=924 side=1`
- Hypothesis: wall-correction near PA access-lane spirals lands on a
  different loop/deck; likely a checker acceptance issue (the correction
  IS onto a drivable surface), or the spiral corridor projection needs the
  same full-3D retry that `_corridorsAt` got (`js/map.js`, search
  "spirals, stacked loops").

### overlap-clearance (21)
Pairs (all inside JCT complexes): r9_1×ramp_25 (Hakozaki), r6_0×ramp_18,
r1_3×ramp_12, k5_1×wangan_1, k5_1×ramp_41, ramp_18×ramp_19,
ramp_1×shibaura_pa_access, daikoku_pa_access×k5_0/k5_1.
- These are branch corridors running alongside/under their JCT complex
  with 1–5.5 m vertical gaps beyond the 340 m connection-exemption window.
- Applied (verified): sibling-branch exemption in extractor separation +
  checker; plan-hold fade so nudges never tear seams; near-miss vertical
  clearance scan (centres < 6 m); skew margin `need = halfSum + 4.0`.
- Next lever: either raise the exemption window for chains that belong to
  the same junction cluster, or extend the near-miss clearance scan to
  edge-overlap (lateral < halfSum) with vertical bumping when the pair is
  neither sibling nor parallel-separable. Beware: the Hakozaki/Namamugi
  knots are 3-level; vertical bumps there fight the pinned taper zones —
  that's what the freedom-weighted bump split is for.

### ramp-drive (47)
- ~40 height steps of 0.20–0.31 m over 2 m (10–15 %) at anchored branch
  zones, dominated by `diverge k5_1 -> ramp_17 [branch]` (Namamugi K5→K1
  dive) and the Hakozaki family (ramp_25/27/31/46, r6_3/r6_0 branches).
- A handful of curvature 0.13–0.38 /m at gore mouths, plus 1–2 transfer
  jumps ~7–11 m at fork continuations (r9_0→ramp_19 was fixed by the
  plan-hold fade; re-check which remain).
- Root cause chain (all understood, partially fixed): branch endpoint
  elevations are HELD to the host's deck profile through the taper
  (extractor `holdEndZone`, pinned masks respected by clearance bumps,
  grade sweeps and relax); `finalGradePolish` now computes the grade limit
  from free spans BETWEEN pinned zones (last applied fix — VERIFIED in the
  last run, brought ramp_17's data under control but the engine still
  shows ~0.26 m steps at @82: probably the map-side plan-blend zone where
  raw heights meet the spline; see `js/map.js _anchorEndpoint`, "PLAN
  blend only" — data heights are authoritative there).
- Checker calibration applied: deck grade measured bank-free; MAX_GRADE
  0.13; MAX_CURVATURE 0.16 (0.3 for synthetic turnarounds).

### smoothness (50)
- Was 0 two runs ago; regressed to 50 after the span-aware grade-limit
  change in `finalGradePolish` (UNVERIFIED interaction — this was applied
  during a Bash-throttled window). Likely the per-route smoothness
  allowance (`smoothLimit = max(0.16, endpointDrop/len * 1.9)`) no longer
  matches profiles whose steepness is between pinned zones rather than
  endpoint-to-endpoint. Either compute the allowance span-aware in the
  checker too, or cap the extractor's span-aware limit.

## Applied but NOT individually verified (Bash throttling)

1. `finalGradePolish`: grade limit from free spans between pinned zones
   (extractor). The last full run INCLUDES this — counts above reflect it.
2. Checker: MAX_GRADE 0.13 flat (removed per-route gradeLimit).
3. Debug instrumentation removed from the extractor (dbgProfile) — the
   extractor runs clean (sanity-checked).

## What a fresh session should do, in order

1. Re-run `node tools/extract-osm.js && node .devtests/osm-validate.mjs`;
   read `.devtests/osm-validate-failures.txt` per class.
2. Fix smoothness regression: make the checker's per-route allowance
   span-aware (mirror `finalGradePolish`'s `required` computation), or
   clamp the extractor limit to ≤ 0.11.
3. Ramp-drive residue: for the ~0.26 m steps at branch starts (@~80–180),
   compare engine curve heights vs data heights point-by-point on ramp_17
   (`diverge k5_1@3380`); if engine == data there, the step is in the
   DATA hold boundary (extend `holdSpan` floor 44 → ~60 or ease the hold
   boundary with one interpolated point); if engine != data, the map-side
   anchoring still touches heights somewhere.
4. Overlap residue: implement junction-cluster exemption (chains whose
   connections all sit within one `junctions[]` cluster radius ~450 m are
   one braided complex — the corridor union seals them; suppressed-barrier
   logic already handles visuals) OR extend near-miss vertical clearance
   as described above. Re-eyeball Hakozaki in the landmarks screenshots
   after (junction integrity is the LAST thing to cut — do not paper over
   without looking).
5. Rail (2): make the escape-correction acceptance in the checker accept
   corrections landing on any drivable surface (`isPointDrivable` at the
   corrected point with margin 1.0, currently 0.6), after confirming with
   a probe that the corrected points are indeed on the PA lane.
6. When suite is green: re-run `CHROMIUM_PATH=/opt/pw-browsers/chromium
   node .devtests/e2e.mjs` (25/25 expected) and `landmarks.mjs`
   (draw-call/triangle report + screenshots), update REBUILD-OSM.md
   "Results", bump `?v=` cache tokens if js/map.js changed, and fill the
   final report per the task spec (way counts are in
   `data/routes.json .meta.stats`).

## Key files

- `tools/extract-osm.js` — extractor + graph surgery + elevation solver.
- `data/routes.json` / `data/routes.js` — committed network (regenerate
  with the extractor; Overpass responses are cached in `tools/cache/`,
  gitignored).
- `js/map.js` — `_defineNetwork` (loader), `_registerDataRoute` /
  `_anchorEndpoint` (side-anchored blended tapers), `_defineServiceAreas`
  (PA lots + spiral access), corridor union collision (untouched engine).
- `.devtests/osm-validate.mjs` — Phase C suite (this is the gate).
- `REBUILD-OSM.md` — the rebuild documentation (Results still pending).
