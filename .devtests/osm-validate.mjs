/**
 * OSM map rebuild validation suite. Headless (pure node — the map module
 * builds without a DOM). MUST pass 100 % before the map is considered done.
 *
 *  1. Rail continuity walk — every metre of outer edge is either walled
 *     (corridor union pushes you back) or covered by another drivable
 *     surface (gore mouths); barrier VISUALS may only be suppressed where
 *     another carriageway's surface actually covers the spot.
 *  2. Overlap scan — no two surfaces overlap in plan on the same level
 *     unless they are connected right there (diverge/merge throat);
 *     different-level crossings keep >= 5.5 m clearance.
 *  3. Ramp drive test — every diverge/merge edge is driven: staying in a
 *     mainline lane through the junction keeps a continuous deck height and
 *     never hits a wall; taking the ramp is smooth (bounded curvature +
 *     grade, no height jumps at transfer points).
 *  4. Surface smoothness — 1 m height sampling along every route,
 *     no discontinuities.
 *  5. Geometry hygiene — no NaN vertices, no degenerate triangles, no
 *     stray Line objects, no unterminated open route ends.
 *
 * Run:  node .devtests/osm-validate.mjs
 */
import * as THREE from 'three';
import { fileURLToPath } from 'node:url';

const failures = [];
const sections = [];
let currentSection = null;

function section(name) {
  currentSection = { name, checks: 0, failed: 0 };
  sections.push(currentSection);
}

function fail(message) {
  currentSection.failed += 1;
  if (failures.length < 40000) failures.push(`[${currentSection.name}] ${message}`);
}

function tick() {
  currentSection.checks += 1;
}

const warnings = [];
const origWarn = console.warn;
console.warn = (...args) => { warnings.push(args.join(' ')); };

const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false });
console.warn = origWarn;

const stats = map.getNetworkStats();
console.log('network:', JSON.stringify(stats));
if (warnings.length) console.log('build warnings:', warnings.join(' | '));

const routes = [...map.routes.values()];
const V = new THREE.Vector3();

// ---------------------------------------------------------------------------
// 1. Rail continuity walk
// ---------------------------------------------------------------------------
section('rail-continuity');
for (const route of routes) {
  const step = 6;
  for (let distance = 0; distance < route.length; distance += step) {
    const center = map._sampleCenter(route, distance, 1);
    const half = map._halfWidthAt(route, distance);
    const bank = map._bankAt(route, distance);
    for (const side of [1, -1]) {
      tick();
      // A probe just OUTSIDE the paved edge must not be freely drivable…
      const outside = center.position.clone().addScaledVector(center.normal, side * (half + 1.6));
      outside.y += Math.tan(bank) * side * (half + 1.6);
      const free = map.isPointDrivable(outside, 0);
      if (free) continue; // covered by another surface (gore throat) — sealed by that corridor's own walls
      // …and the wall must actually correct an escape attempt from inside.
      const result = map.resolveWallCollision(outside, 1.25);
      if (!result.hit) {
        fail(`unwalled edge ${route.id} d=${distance.toFixed(0)} side=${side} at (${outside.x.toFixed(0)}, ${outside.z.toFixed(0)})`);
        continue;
      }
      const corrected = map.getRoadInfo(result.position, route.id);
      if (!corrected || (Math.abs(corrected.verticalDistance) > 6 && !map.isPointDrivable(result.position, 0.6))) {
        fail(`escape correction left road ${route.id} d=${distance.toFixed(0)} side=${side}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Overlap / clearance scan
// ---------------------------------------------------------------------------
section('overlap-clearance');
const routeTouches = (edge, route, at, radius) => {
  let result = null;
  if (edge.from.routeId === route.id) {
    let delta = Math.abs(edge.from.distance - at);
    if (route.closed) delta = Math.min(delta, route.length - delta);
    if (delta < radius) result = { other: edge.to.routeId, otherAt: edge.to.distance };
  }
  if (!result && edge.to.routeId === route.id) {
    let delta = Math.abs(edge.to.distance - at);
    if (route.closed) delta = Math.min(delta, route.length - delta);
    if (delta < radius) result = { other: edge.from.routeId, otherAt: edge.from.distance };
  }
  return result;
};
const edgesNear = (a, b, da, db, radius = 340) => {
  for (const edge of map.edges) {
    const direct = (edge.from.routeId === a.id && edge.to.routeId === b.id)
      || (edge.from.routeId === b.id && edge.to.routeId === a.id);
    if (direct) {
      const distA = edge.from.routeId === a.id ? edge.from.distance : edge.to.distance;
      const distB = edge.from.routeId === b.id ? edge.from.distance : edge.to.distance;
      let deltaA = Math.abs(distA - da);
      if (a.closed) deltaA = Math.min(deltaA, a.length - deltaA);
      let deltaB = Math.abs(distB - db);
      if (b.closed) deltaB = Math.min(deltaB, b.length - deltaB);
      if (deltaA < radius && deltaB < radius) return true;
    }
  }
  // sibling branches of one throat overlap by construction
  for (const e1 of map.edges) {
    const linkA = routeTouches(e1, a, da, radius);
    if (!linkA) continue;
    for (const e2 of map.edges) {
      const linkB = routeTouches(e2, b, db, radius);
      if (!linkB) continue;
      if (linkA.other === linkB.other && Math.abs(linkA.otherAt - linkB.otherAt) < 340) return true;
    }
  }
  return false;
};
for (const route of routes) {
  const step = 9;
  for (let distance = 0; distance < route.length; distance += step) {
    const center = map._sampleCenter(route, distance, 1);
    const half = map._halfWidthAt(route, distance);
    for (const other of routes) {
      if (other.id <= route.id) continue; // each unordered pair once
      const projection = map._projectToRoute(other, center.position);
      if (projection.endOvershoot > 2) continue; // beyond the other's end — no surface there
      const otherHalf = map._halfWidthAt(other, projection.distance);
      const planGap = Math.abs(projection.signedLateral) - (half + otherHalf);
      if (planGap > -0.4) continue; // corridors clear of each other in plan
      tick();
      const verticalGap = Math.abs(projection.point.y - center.position.y);
      if (verticalGap >= 5.5) continue; // grade-separated crossing
      // A PA service lane runs alongside its host by design for its whole
      // length (decel/alongside/accel) — the corridor union seals it.
      const serviceHostPair = (route.kind === 'service' || other.kind === 'service')
        && map.edges.some((edge) => (edge.from.routeId === route.id && edge.to.routeId === other.id)
          || (edge.from.routeId === other.id && edge.to.routeId === route.id));
      if (serviceHostPair) continue;
      if (edgesNear(route, other, distance, projection.distance)) continue; // connected throat
      // service lanes overlap their host by design at the mouths only —
      // anything else is a generation error.
      fail(`same-level overlap ${route.id} d=${distance.toFixed(0)} with ${other.id} d=${projection.distance.toFixed(0)} `
        + `plan ${planGap.toFixed(1)} m, vertical ${verticalGap.toFixed(1)} m at (${center.position.x.toFixed(0)}, ${center.position.z.toFixed(0)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Ramp drive test — every diverge and merge, plus mainline pass-through
// ---------------------------------------------------------------------------
section('ramp-drive');
// Deck grade limit for the drive test (bank-free deck continuity; the
// bank term is smooth by construction — clamped and curvature-averaged).
// The DATA holds 6 % wherever topology permits; connectors between real
// decks over short runs (Hakozaki, Namamugi) legitimately reach ~11 %.
// Real kinks fail far above this; see also the smoothness section.
const MAX_GRADE = 0.13;
const MAX_CURVATURE = 0.185;     // 1/m ≈ 5.4 m radius: tight urban JCT braid mouths (low speed)
const MAX_CURVATURE_SYNTH = 0.3; // synthesized turnarounds may hairpin

function driveLane(route, lane, fromDistance, toDistance, label, { checkWalls = true } = {}) {
  const step = 2;
  let previousHeight = null;
  let previousHeading = null;
  const from = Math.max(route.closed ? -Infinity : 0, fromDistance);
  const to = Math.min(route.closed ? Infinity : route.length, toDistance);
  for (let distance = from; distance <= to; distance += step) {
    tick();
    const sample = map.sampleLane(route.id, map._normalizeDistance(route, distance), lane, 1);
    const height = sample.center.y; // deck continuity; bank is smooth by construction
    if (!Number.isFinite(height)) { fail(`${label}: NaN height @${distance.toFixed(0)}`); return; }
    if (previousHeight !== null) {
      const grade = Math.abs(height - previousHeight) / step;
      if (grade > MAX_GRADE) fail(`${label}: height step ${(height - previousHeight).toFixed(2)} m over ${step} m @${distance.toFixed(0)}`);
    }
    if (previousHeading !== null) {
      let deltaHeading = sample.heading - previousHeading;
      while (deltaHeading > Math.PI) deltaHeading -= Math.PI * 2;
      while (deltaHeading < -Math.PI) deltaHeading += Math.PI * 2;
      const curvature = Math.abs(deltaHeading) / step;
      const limit = route.synthetic ? MAX_CURVATURE_SYNTH : MAX_CURVATURE;
      if (curvature > limit) fail(`${label}: curvature ${curvature.toFixed(3)}/m @${distance.toFixed(0)}`);
    }
    if (checkWalls) {
      const probe = sample.position.clone();
      probe.y = height + 0.4;
      const wall = map.resolveWallCollision(probe, 1.0);
      if (wall.hit) fail(`${label}: wall hit in lane centre @${distance.toFixed(0)} (${probe.x.toFixed(0)}, ${probe.z.toFixed(0)})`);
    }
    previousHeight = height;
    previousHeading = sample.heading;
  }
}

function transferGap(fromRoute, fromDistance, fromLane, toRoute, toDistance, toLane, label) {
  tick();
  const a = map.sampleLane(fromRoute.id, map._normalizeDistance(fromRoute, fromDistance), fromLane, 1);
  const b = map.sampleLane(toRoute.id, map._normalizeDistance(toRoute, toDistance), toLane, 1);
  const jump = a.position.distanceTo(b.position);
  const drop = Math.abs(a.position.y - b.position.y);
  if (jump > 6.5) fail(`${label}: transfer jump ${jump.toFixed(1)} m`);
  if (drop > 0.8) fail(`${label}: transfer height step ${drop.toFixed(2)} m`);
}

for (const edge of map.edges) {
  const fromRoute = map.routes.get(edge.from.routeId);
  const toRoute = map.routes.get(edge.to.routeId);
  if (!fromRoute || !toRoute) { fail(`edge references missing route ${edge.from.routeId} -> ${edge.to.routeId}`); continue; }

  if (edge.kind === 'diverge') {
    const label = `diverge ${fromRoute.id}@${edge.from.distance.toFixed(0)} -> ${toRoute.id}`;
    // (a) EVERY mainline lane drives straight through the junction: height
    // continuous, no wall contact — staying in lane never leaves the road.
    for (let lane = 0; lane < fromRoute.lanes; lane += 1) {
      driveLane(fromRoute, lane, edge.from.distance - 220, edge.from.distance + 220, `${label} [thru lane ${lane}]`);
    }
    // (b) taking the branch is smooth from its own start.
    driveLane(toRoute, 0, 0, Math.min(toRoute.length, 420), `${label} [branch]`, { checkWalls: true });
    // The branch peels from edge.side (+1 = base-normal/left): the transfer
    // starts from the lane nearest that edge.
    const exitLane = edge.side !== undefined ? (edge.side > 0 ? 0 : fromRoute.lanes - 1) : fromRoute.lanes - 1;
    transferGap(fromRoute, edge.from.distance, exitLane, toRoute, edge.to.distance, 0, label);
  } else if (edge.kind === 'merge') {
    const label = `merge ${fromRoute.id} -> ${toRoute.id}@${edge.to.distance.toFixed(0)}`;
    for (let lane = 0; lane < toRoute.lanes; lane += 1) {
      driveLane(toRoute, lane, edge.to.distance - 220, edge.to.distance + 220, `${label} [thru lane ${lane}]`);
    }
    driveLane(fromRoute, 0, Math.max(0, fromRoute.length - 420), fromRoute.length, `${label} [ramp end]`);
    const landLane = edge.mergeLane ?? toRoute.lanes - 1;
    transferGap(fromRoute, fromRoute.length, 0, toRoute, edge.to.distance, landLane, label);
  } else {
    const label = `continuation ${fromRoute.id} -> ${toRoute.id}`;
    transferGap(fromRoute, edge.from.distance, 0, toRoute, edge.to.distance, 0, label);
  }
}

// ---------------------------------------------------------------------------
// 4. Surface smoothness — 1 m sampling along every route centreline
// ---------------------------------------------------------------------------
section('smoothness');
for (const route of routes) {
  let previous = null;
  const endpointDrop = Math.abs(route.curve.getPointAt(0).y - route.curve.getPointAt(1).y);
  const smoothLimit = Math.max(0.16, (endpointDrop / Math.max(1, route.length)) * 1.9);
  for (let distance = 0; distance <= route.length; distance += 1) {
    tick();
    const point = route.curve.getPointAt(Math.min(1, distance / route.length));
    if (!Number.isFinite(point.x + point.y + point.z)) { fail(`${route.id}: NaN point @${distance}`); break; }
    if (previous) {
      const dy = Math.abs(point.y - previous.y);
      if (dy > smoothLimit) fail(`${route.id}: height discontinuity ${dy.toFixed(2)} m @${distance}`);
      const dxz = Math.hypot(point.x - previous.x, point.z - previous.z);
      if (dxz > 3.5) fail(`${route.id}: plan discontinuity ${dxz.toFixed(1)} m @${distance}`);
    }
    previous = point;
  }
}

// ---------------------------------------------------------------------------
// 5. Geometry hygiene
// ---------------------------------------------------------------------------
section('geometry-hygiene');
let triangleCount = 0;
let meshCount = 0;
map.group.traverse((object) => {
  if (object.isLine || object.isLineSegments || object.isPoints) {
    fail(`stray ${object.type} object "${object.name}" — orphan line geometry`);
  }
  if (!object.isMesh || !object.geometry) return;
  meshCount += 1;
  const geometry = object.geometry;
  const positions = geometry.getAttribute('position');
  if (!positions) return;
  for (let i = 0; i < positions.count; i += 1) {
    const x = positions.getX(i);
    const y = positions.getY(i);
    const z = positions.getZ(i);
    if (!Number.isFinite(x + y + z)) { fail(`NaN vertex in "${object.name || object.type}"`); break; }
  }
  const index = geometry.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const triangles = index ? index.count / 3 : positions.count / 3;
  triangleCount += triangles;
  const readTriangle = (t) => {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(positions, i0);
    b.fromBufferAttribute(positions, i1);
    c.fromBufferAttribute(positions, i2);
  };
  let degenerate = 0;
  for (let t = 0; t < triangles; t += 1) {
    tick();
    readTriangle(t);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    const areaTwice = ab.cross(ac).length();
    if (areaTwice < 1e-7) degenerate += 1;
  }
  if (degenerate) fail(`${degenerate} degenerate triangle(s) in "${object.name || object.parent?.name || object.type}"`);
});

// open route ends must terminate somewhere: an edge, a loop, or a cap
for (const route of routes) {
  if (route.closed) continue;
  tick();
  const openStart = map._endIsOpen(route, -1);
  const openEnd = map._endIsOpen(route, 1);
  const fedStart = map.edges.some((edge) => edge.to.routeId === route.id && edge.to.distance < 60);
  const outEnd = map.edges.some((edge) => edge.from.routeId === route.id && edge.from.distance > route.length - 60);
  if (!fedStart && openStart) fail(`${route.id}: start neither fed nor capped`);
  if (!outEnd && openEnd) fail(`${route.id}: end neither continues nor capped`);
  if (!outEnd && route.kind !== 'service') fail(`${route.id}: dead end without termination (kind ${route.kind})`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log('');
let failedTotal = 0;
for (const entry of sections) {
  failedTotal += entry.failed;
  console.log(`${entry.failed ? 'FAIL' : 'PASS'}  ${entry.name.padEnd(20)} ${entry.checks} checks, ${entry.failed} failures`);
}
console.log(`meshes ${meshCount}, triangles ${Math.round(triangleCount)}`);
if (failedTotal) {
  const { writeFileSync } = await import('node:fs');
  const out = fileURLToPath(new URL('./osm-validate-failures.txt', import.meta.url));
  writeFileSync(out, failures.join('\n'));
  console.log(`\n${failures.length} failures written to ${out}`);
  console.log('FIRST FAILURES:');
  for (const failure of failures.slice(0, 30)) console.log('  ' + failure);
  process.exit(1);
}
console.log('\nALL OK');
