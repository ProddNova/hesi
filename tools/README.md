# tools/

## extract-osm.js — real-world road network extraction

One-off offline script that builds `data/routes.json` (+ `data/routes.js`,
the same payload as an ES module the game imports) from OpenStreetMap via
the Overpass API. **The game never calls any API at runtime** — the output
is committed to the repo.

```
node tools/extract-osm.js            # uses tools/cache/ if present
node tools/extract-osm.js --refresh  # force re-query Overpass
node tools/extract-osm.js --offline  # fail instead of querying (CI use)
```

No dependencies (Node >= 18 for built-in fetch). Raw Overpass responses are
cached in `tools/cache/` (gitignored) so re-runs are instant and the
transform stays reproducible. A visual sanity check of the extracted
network is written to `tools/debug-map.svg`.

### What it extracts

Shuto Expressway subset, `highway=motorway` + `motorway_link`, matched by
way name/ref inside a Tokyo/Yokohama bbox:

- **C1** 都心環状線 (both carriageway loops)
- **11** 台場線 incl. Rainbow Bridge
- **B** 湾岸線, clipped Tatsumi ↔ just past Daikoku (incl. Tokyo Port Tunnel)
- **9** 深川線
- **1** 羽田線 (Hamazakibashi → Haneda; how R11/C1 really interconnect, and
  where Heiwajima PA actually lives)
- **6** 向島線 stub (Edobashi ↔ Hakozaki; how R9 really reaches C1)
- **K1** 横羽線 (Haneda → Namamugi)
- **K5** 大黒線 (Namamugi → Daikoku JCT)
- every `motorway_link` chain interconnecting the above (Daikoku JCT stack,
  Tatsumi, Daiba, Hakozaki, Namamugi…), plus PA locations for 芝浦 / 辰巳 /
  平和島 / 大黒 (OSM centroids, name-matched)

### Pipeline

1. Overpass query (mirror fallback + retry), cached raw.
2. Classify ways per route group; node-level clip to the game subset.
3. Absorb unnamed connector pieces; bridge JCT concurrency gaps (the through
   carriageway inside a JCT is often mapped under the crossing route's name)
   by shortest-path search over the unclassified way graph.
4. Stitch ways into maximal one-way carriageway chains; merge fragments;
   detect closed loops.
5. Keep `motorway_link` chains attached to the subset at both ends
   (iterative closure, so Daikoku's braided ramps survive), or attached at
   one end + ending at a PA.
6. Prune stub branches that only feed routes outside the subset; stitch
   dangling concurrency ends (C1 loop closure); synthesize teardrop
   turnarounds at clip cut ends; drop disconnected islands.
7. Project lat/lon → local metres (equirectangular around 35.68 N 139.77 E,
   true 1:1 scale; +X east, +Z north).
8. Elevation: per-way base from `layer`/`bridge`/`tunnel` (12 m per layer,
   tunnels −15 m), connection-pinned smoothing, ≤ 6 % grades, ≥ 6.5 m
   deck-to-deck clearance enforced at plan crossings, plan-separation pass
   so parallel carriageways never overlap.
9. Douglas-Peucker simplify (2 m tolerance), re-resolve graph connection
   distances, emit routes/edges/junctions/service areas/terrain.

### Output schema (data/routes.json)

```
meta        { origin, bbox, laneWidth, stats }
groups      [{ id, code, name, nameJa, kind, destinations }]
routes      [{ id, group, kind: mainline|ramp, closed, synthetic, lanes,
               speedLimit, length, points: [[x,y,z]…], tunnels: [{start,end}],
               bridges: [{start,end}], destinations, paId }]
edges       [{ from: {route, distance}, to: {route, distance},
               kind: continuation|diverge|merge, point: [x,z] }]
junctions   [{ id, name, nameJa, x, z, groups }]
serviceAreas[{ id, name, x, z, routeId, distance, lateral, side,
               hasGarage, density, width, length }]
terrain     [{ name, x, z, w, d }]
```

All routes are one-way carriageways travelled from `points[0]` to
`points[last]` (direction +1). Connections exist ONLY where OSM has shared
nodes — this graph is the ground truth for what connects to what.

Data © OpenStreetMap contributors, ODbL 1.0.
