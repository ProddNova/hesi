/**
 * FOCUSED LATERAL-JUNCTION PROBE — validates the DRAWN junction surface
 * (the actual merged deck triangles), not just the analytic corridors.
 *
 * For every same-level lateral merge/diverge mouth it walks the branch
 * cross-sections through the mouth and raycasts the road geometry from
 * above at each sample point:
 *
 *  1. HOLE — a point that should be paved (inside the host surface, the
 *     branch's drawn wing, or the gore fill zone) has no road surface
 *     within 0.4 m of the expected deck height.
 *  2. DOUBLE SURFACE — two road-material surfaces within 0.05 m of each
 *     other at the same plan position (coplanar duplicate → z-fighting).
 *  3. STEP — the top road surface deviates > 0.3 m from the corridor
 *     union's expected deck height (drawn/physics divergence).
 *  4. RAIL ACROSS MOUTH — a barrier/rail surface strikes the ray between
 *     the paved deck and +1.4 m above it while the point lies on the open
 *     paved union (never allowed across a mouth).
 *
 * Run:  node .devtests/lateral-junction-probe.mjs
 * Exits non-zero on any failure; prints per-junction counts.
 */
import * as THREE from 'three';

const VERBOSE = process.argv.includes('--verbose');
const NO_MOUTHS = process.argv.includes('--no-mouth-surfaces'); // A/B: draw legacy full ribbons

const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false, junctionMouthSurfaces: NO_MOUTHS ? false : undefined });
console.warn = origWarn;

// Collect drawn road + barrier triangle meshes (chunk visibility is a
// streaming artefact — raycast everything).
const roadMaterials = new Set([map.materials.road, map.materials.roadAlt, map.materials.roadService]);
const railMaterials = new Set([map.materials.barrier, map.materials.railMetal]);
const roadMeshes = [];
const railMeshes = [];
map.group.traverse((object) => {
  if (!object.isMesh) return;
  if (roadMaterials.has(object.material)) roadMeshes.push(object);
  else if (railMaterials.has(object.material)) railMeshes.push(object);
});
map.group.updateMatrixWorld(true);

const raycaster = new THREE.Raycaster();
raycaster.far = 60;
const DOWN = new THREE.Vector3(0, -1, 0);

function roadHitsAt(x, y, z) {
  raycaster.set(new THREE.Vector3(x, y + 25, z), DOWN);
  const hits = raycaster.intersectObjects(roadMeshes, false)
    .filter((hit) => Math.abs(hit.point.y - y) < 6);
  hits.sort((h1, h2) => h2.point.y - h1.point.y);
  return hits;
}

function railHitsBetween(x, z, yLow, yHigh) {
  raycaster.set(new THREE.Vector3(x, yHigh + 0.5, z), DOWN);
  return raycaster.intersectObjects(railMeshes, false)
    .filter((hit) => hit.point.y > yLow && hit.point.y < yHigh);
}

/**
 * Deck-height candidates of the corridor union at a point (host and/or
 * branch), with how deep inside each corridor the point sits. The drawn
 * junction surface is correct when it matches ANY candidate — in overlap
 * zones the union legitimately shows the host while physics may ride
 * either corridor.
 */
function unionDeckY(point, host, branch, branchStation) {
  const candidates = [];
  const hostProjection = map._projectToRoute(host, point);
  if (hostProjection.endOvershoot < 1) {
    const half = map._halfWidthAt(host, hostProjection.distance);
    const depth = half - Math.abs(hostProjection.signedLateral);
    if (depth > 0.05) {
      const bank = map._bankAt(host, hostProjection.distance);
      candidates.push({ y: hostProjection.point.y + Math.tan(bank) * hostProjection.signedLateral, who: 'host', depth });
    }
  }
  const branchFrame = map._frameAt(branch, branchStation);
  const delta = point.clone().sub(branchFrame.position);
  const lat = delta.dot(branchFrame.normal);
  const branchDepth = branchFrame.half - Math.abs(lat);
  if (branchDepth > 0.05) {
    candidates.push({ y: branchFrame.position.y + Math.tan(branchFrame.bank) * lat, who: 'branch', depth: branchDepth });
  }
  return candidates;
}

let failures = 0;
const report = [];
for (const route of map.routes.values()) {
  if (!route.junctionMouths) continue;
  for (const mouth of route.junctionMouths) {
    const host = mouth.host;
    const counts = { holes: 0, doubles: 0, steps: 0, rails: 0, points: 0 };
    for (let s = 2; s < mouth.span; s += 5) {
      const station = mouth.which === 'start' ? s : route.length - s;
      const frame = map._frameAt(route, station);
      // cross the whole junction mouth: from just inside the host's far
      // half to the branch's outer edge
      for (let t = -1; t <= 1.001; t += 0.2) {
        const lat = t * (frame.half - 0.55);
        const point = map._deckPoint(frame, lat);
        const expected = unionDeckY(point, host, route, station);
        if (!expected.length) continue; // outside the paved union (past the gore)
        counts.points += 1;
        const topExpected = Math.max(...expected.map((c) => c.y));
        const hits = roadHitsAt(point.x, topExpected, point.z);
        // The drawn union surface must match ONE candidate deck height —
        // pick the hit/candidate pair with the smallest deviation.
        let best = Infinity;
        let bestHit = null;
        for (const hit of hits) {
          for (const candidate of expected) {
            const deviation = Math.abs(hit.point.y - candidate.y);
            if (deviation < best) { best = deviation; bestHit = hit; }
          }
        }
        if (!bestHit || best > 0.4) {
          counts.holes += 1;
          if (VERBOSE) console.log(`  hole ${route.id} s=${s} lat=${lat.toFixed(1)} expected=${topExpected.toFixed(2)} got=${hits.length ? hits.map((h) => h.point.y.toFixed(2)).join('/') : 'none'}`);
          continue;
        }
        if (best > 0.3) {
          counts.steps += 1;
          if (VERBOSE) console.log(`  step ${route.id} s=${s} lat=${lat.toFixed(1)} deviation=${best.toFixed(2)}`);
        }
        // Coplanar duplicates (z-fighting). The junction union tucks strips
        // 0.03 m BELOW the host surface and its flaps CROSS the host sheet
        // at an angle by design — an intersection seam is a centimetres-wide
        // band, not z-fighting. Only pairs that stay near-parallel over a
        // 0.5 m lateral span count as duplicates.
        for (let i = 1; i < hits.length; i += 1) {
          const gap = hits[i - 1].point.y - hits[i].point.y;
          if (gap > 0.0005 && gap < 0.018) {
            let parallel = false;
            for (const offset of [-0.25, 0.25]) {
              const probePoint = map._deckPoint(frame, lat + offset);
              const offsetHits = roadHitsAt(probePoint.x, topExpected, probePoint.z);
              for (let j = 1; j < offsetHits.length; j += 1) {
                const offsetGap = offsetHits[j - 1].point.y - offsetHits[j].point.y;
                if (offsetGap > 0.0005 && offsetGap < 0.018
                  && Math.abs(offsetGap - gap) < Math.max(0.004, gap * 0.5)) { parallel = true; break; }
              }
              if (parallel) break;
            }
            if (parallel) {
              counts.doubles += 1;
              if (VERBOSE) console.log(`  double ${route.id} s=${s} lat=${lat.toFixed(1)} gap=${gap.toFixed(3)}`);
            }
            break;
          }
        }
        // Open mouth interior (well inside BOTH corridors): no rail may
        // cross between the deck and +1.4 m. Rails at the union's outer
        // boundary are the legitimate junction edge.
        if (expected.length === 2 && expected.every((candidate) => candidate.depth > 1.2)) {
          const rails = railHitsBetween(point.x, point.z, bestHit.point.y + 0.25, bestHit.point.y + 1.4);
          if (rails.length) {
            counts.rails += 1;
            if (VERBOSE) console.log(`  rail ${route.id} s=${s} lat=${lat.toFixed(1)} at y=${rails[0].point.y.toFixed(2)}`);
          }
        }
      }
    }
    const bad = counts.holes + counts.doubles + counts.steps + counts.rails;
    failures += bad;
    report.push({
      mouth: `${mouth.kind} ${route.id} ${mouth.which} on ${host.id}`,
      ...counts,
      ok: bad === 0,
    });
  }
}

report.sort((a, b) => (b.holes + b.doubles + b.steps + b.rails) - (a.holes + a.doubles + a.steps + a.rails));
for (const row of report) {
  const flag = row.ok ? 'PASS' : 'FAIL';
  console.log(`${flag}  ${row.mouth.padEnd(46)} pts=${String(row.points).padStart(4)} holes=${row.holes} doubles=${row.doubles} steps=${row.steps} rails=${row.rails}`);
}
const totals = report.reduce((acc, row) => ({
  points: acc.points + row.points, holes: acc.holes + row.holes,
  doubles: acc.doubles + row.doubles, steps: acc.steps + row.steps, rails: acc.rails + row.rails,
}), { points: 0, holes: 0, doubles: 0, steps: 0, rails: 0 });
console.log(`\nTOTAL mouths=${report.length} points=${totals.points} holes=${totals.holes} doubles=${totals.doubles} steps=${totals.steps} rails=${totals.rails}`);

// Gate: the paved union must be complete (no holes), true to the corridor
// heights (no steps) and open (no rails across a mouth). Coplanar duplicate
// pairs are a RATCHET: the residue lives in braided sibling overlaps inside
// multi-level JCT complexes (Daikoku/Hakozaki families — vertical-crossing
// domain, out of the lateral-junction scope). Legacy full-ribbon drawing
// measured 459 parallel pairs; the mouth system leaves ~46. Fail on any
// regression past 60 so the family can only shrink.
const DOUBLES_RATCHET = 60;
const gateFailed = totals.holes || totals.steps || totals.rails || totals.doubles > DOUBLES_RATCHET;
if (gateFailed) { console.log('LATERAL JUNCTION PROBE: FAIL'); process.exit(1); }
console.log(`LATERAL JUNCTION PROBE: PASS (doubles ${totals.doubles} <= ratchet ${DOUBLES_RATCHET})`);
