# Shutoko Map Rebuild from Real OSM Data (2026-07-14)

The road network was rebuilt from OpenStreetMap ground truth. Junction
geometry that used to be hand-invented (and broke: center-splitting ramps,
stray cap geometry, missing rails, dirty overlaps) is now generated from a
committed topology graph with construction rules that make those failures
structurally impossible, verified by an automated suite.

## Phase A — extraction (tools/extract-osm.js → data/routes.json)

- Overpass API query (cached in tools/cache/, gitignored; mirrors +
  retries), `highway=motorway` + `motorway_link` in a Tokyo/Yokohama bbox.
- Route subset matched by name/ref: C1 都心環状線, 11 台場線 (Rainbow
  Bridge), B 湾岸線 clipped Tatsumi↔Daikoku (Tokyo Port Tunnel), 9 深川線,
  1 羽田線 (how R11 really meets C1 at Hamazakibashi; hosts Heiwajima PA),
  6 向島線 stub (how R9 really meets C1 at Edobashi), K1 横羽線, K5 大黒線
  (Namamugi → Daikoku JCT) — plus every `motorway_link` chain that forms a
  complete path within the subset (directed reachability keep-rule).
- Equirectangular projection around 35.68 N 139.77 E, true 1:1 metres.
- Topology graph from shared OSM node ids — connections exist ONLY where
  OSM has them. Way chains → one-way carriageway chains (fragment merge,
  loop closure detection, node-level clipping at subset boundaries).
- Mapping-quirk surgery: concurrency gap bridging (through-carriageways
  inside JCTs are often mapped under the crossing route's name — shortest
  directed path search re-absorbs them), external stub pruning, dangling
  ramp pruning to fixpoint, C1 loop stitching, fork/confluence mouth
  slotting (bifurcating chains split from the SIDES of the host width,
  never from the centreline), teardrop turnarounds at clip cut ends,
  disconnected island removal.
- Elevation: per-way base from layer/bridge/tunnel tags (12 m per layer,
  tunnels −15 m), connection-pinned relaxation, ≤ 6 % grades, plan
  separation of parallel carriageways, ≥ 6.5 m deck-to-deck clearance at
  crossings enforced on FINAL geometry with endpoint re-pinning, and a
  final grade polish pass.
- Douglas-Peucker simplification at 2 m tolerance in 3D (elevation counts,
  so clearance bumps survive).
- Output: `data/routes.json` + `data/routes.js` (same payload as ESM). The
  game never calls any API at runtime.

## Phase B — generator (js/map.js)

The proven engine (corridor-union collision, analytic road sampling for
physics, chunk streaming, PS2 dressing) is kept; the network definition is
replaced by a loader over the committed graph:

- Every route is an independently extruded one-way carriageway (lanes from
  OSM, 3.5 m lanes, dashed dividers, solid edge lines, banked curves).
- **Diverges/merges are re-anchored to the OUTER edge of the host**: a
  parallel taper runs alongside (deck heights glued, elevations blended)
  before the branch peels away — ramps can never split a carriageway down
  the middle, and staying in a mainline lane never captures you onto a
  ramp. Side is detected from the branch's real geometry; traffic AI gets
  side-aware merge lanes.
- Guardrails walk the outer edges of every drivable surface; visuals are
  suppressed ONLY where another carriageway's surface covers the spot
  (gore mouths), while collision (the corridor union) stays continuous
  everywhere — bridge, tunnel, ramps, PA lanes included. Gores get chevron
  paint and a crash cushion at the barrier split.
- Crossings keep ≥ 5.5 m clearance (enforced in data); same-level overlap
  outside connection throats is a validation ERROR.
- PAs at their OSM centroids on the clear side of their real carriageway
  (footprint-scored side selection), with synthesized decel/accel access
  lanes whose descent stays under ~5 %; Daikoku PA is a ground-level lot
  under the real JCT stack. Score banking, refuel, tow and the Shibaura
  garage all reconnected unchanged.
- Traffic drives the new graph (diverge probability, side-aware merge
  lanes, hand-off blending); chunk streaming rebuilt around the network
  bounds; the phone Map app and minimap render the real network; signage
  regenerates from per-route destinations (OSM `destination` tags where
  present) and junction names from `motorway_junction` nodes; Rainbow
  Bridge dressing spans both real carriageways; Tokyo Tower and the Daiba
  ferris wheel sit at their real coordinates; terrain slabs project from
  real geography.

## Phase C — validation (.devtests/osm-validate.mjs)

Headless suite over the actual built map, must pass 100 %:

1. **Rail continuity walk** — every 6 m of every outer edge: either
   another drivable surface covers the spot, or the wall corrects an
   escape probe (with the correction landing back on the road).
2. **Overlap scan** — no same-level plan overlap between unconnected
   surfaces; different-level crossings ≥ 5.5 m.
3. **Ramp drive test** — every diverge/merge edge: all mainline lanes
   driven straight through the junction (continuous deck height, zero
   wall contact); the branch driven end-to-end (bounded curvature +
   grade); transfer points land without jumps. Deck grade is measured
   bank-free (the bank term is clamped and curvature-averaged by
   construction); connectors between real decks over short runs
   (Hakozaki, Namamugi) carry their topology-forced grade.
4. **Surface smoothness** — 1 m height sampling along every route, with
   a per-route allowance for steep-by-topology connectors.
5. **Geometry hygiene** — no NaN vertices, no degenerate triangles, no
   stray Line objects (the "random horizontal lines" bug class), no
   unterminated open ends.

Plus the existing browser suites re-run on the new map: e2e (25 checks,
iPhone-like touch viewport), indicator/grip/traffic/spin tests.

## Results

(filled at the end of the pass — see final report)

## Known limitations

- The subset is cut where the real network continues (Tatsumi, Daikoku,
  Namamugi, Heiwajima-north, Mukojima): synthesized teardrop turnarounds
  keep traffic flowing; they are marked `synthetic` in the data.
- PA lots are simplified rectangles at real locations; their access lanes
  are synthesized (real PA slip roads in OSM dead-end into parking aisles
  we do not model).
- Elevation is derived from layer/bridge/tunnel tags, not survey data —
  it is plausible, smooth and clearance-correct rather than surveyed.
