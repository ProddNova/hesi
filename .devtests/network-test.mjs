/**
 * Network integrity for the Shutoko rebuild:
 *  1. no grade crossings (corridor overlap at similar Y outside legal zones)
 *  2. junction edges are geometrically continuous (no long teleports)
 *  3. corridor union is escape-proof (random high-speed sweeps stay contained)
 *  4. traffic can walk the network forever (no dead ends except the stub)
 *  5. grand tour length sanity
 * Run: node .devtests/network-test.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const map = new HighwayMap(null, {});
let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// ---- route lengths ----
for (const id of map.getRouteIds()) {
  const route = map.getRoute(id);
  console.log(`   ${id.padEnd(16)} ${(route.length / 1000).toFixed(2)} km  lanes ${route.lanes}${route.closed ? ' (loop)' : ''}`);
}
const stats = map.getNetworkStats();
check('total network 70-95 km', stats.totalLengthKm > 70 && stats.totalLengthKm < 95, `${stats.totalLengthKm.toFixed(1)} km`);

// ---- 1. grade crossings ----
// For every pair of mainline routes, find XZ-close sample pairs; they must be
// either vertically separated (>= 5 m) or inside a legal shared zone (a
// registered edge within 700 m, or endpoint continuation).
const legalPoints = map.edges.flatMap((edge) => {
  const a = map._sampleCenter(edge.from.routeId, edge.from.distance, 1).position;
  const b = map._sampleCenter(edge.to.routeId, edge.to.distance, 1).position;
  return [a, b];
});
const nearLegal = (p) => legalPoints.some((q) => (p.x - q.x) ** 2 + (p.z - q.z) ** 2 < 700 * 700);
let crossings = 0;
const ids = map.getRouteIds({ includeService: true });
for (let i = 0; i < ids.length; i += 1) {
  for (let j = i + 1; j < ids.length; j += 1) {
    const a = map.getRoute(ids[i]);
    const b = map.getRoute(ids[j]);
    for (const sa of a.samples) {
      for (const sb of b.samples) {
        const dx = sa.point.x - sb.point.x;
        const dz = sa.point.z - sb.point.z;
        const limit = a.halfWidth + b.halfWidth;
        if (dx * dx + dz * dz > limit * limit) continue;
        const dy = Math.abs(sa.point.y - sb.point.y);
        if (dy >= 5) continue; // grade separated
        if (nearLegal(sa.point)) continue; // merge/diverge/continuation zone
        crossings += 1;
        if (crossings < 6) console.log(`   crossing ${ids[i]}@${sa.distance.toFixed(0)} ~ ${ids[j]}@${sb.distance.toFixed(0)} dy=${dy.toFixed(1)} at (${sa.point.x.toFixed(0)},${sa.point.z.toFixed(0)})`);
      }
    }
  }
}
check('no grade crossings outside junction zones', crossings === 0, `${crossings} illegal overlaps`);

// ---- 2. edge continuity ----
let worstJump = 0;
for (const edge of map.edges) {
  const fromRoute = map.getRoute(edge.from.routeId);
  const outerLane = edge.kind === 'diverge' ? fromRoute.lanes - 1 : 0;
  const from = map.sampleLane(edge.from.routeId, edge.from.distance, outerLane, edge.from.direction);
  const toRoute = map.getRoute(edge.to.routeId);
  const toLane = edge.kind === 'merge' ? toRoute.lanes - 1 : Math.min(outerLane, toRoute.lanes - 1);
  const to = map.sampleLane(edge.to.routeId, edge.to.distance, toLane, edge.to.direction);
  const jump = from.position.distanceTo(to.position);
  worstJump = Math.max(worstJump, jump);
  if (jump > 26) console.log(`   long jump ${jump.toFixed(1)}m: ${edge.kind} ${edge.from.routeId}@${edge.from.distance.toFixed(0)} -> ${edge.to.routeId}@${edge.to.distance.toFixed(0)}`);
}
check('junction edges continuous (< 26 m lateral)', worstJump <= 26, `worst ${worstJump.toFixed(1)} m`);

// tangential alignment at edges (no U-turn teleports)
let worstDot = 1;
for (const edge of map.edges) {
  const from = map.sampleLane(edge.from.routeId, edge.from.distance, 0, edge.from.direction);
  const to = map.sampleLane(edge.to.routeId, edge.to.distance, 0, edge.to.direction);
  const dot = from.tangent.dot(to.tangent);
  worstDot = Math.min(worstDot, dot);
  if (dot < 0.45) console.log(`   misaligned edge ${edge.kind} ${edge.from.routeId}->${edge.to.routeId} dot=${dot.toFixed(2)}`);
}
check('edge tangents aligned (dot > 0.45)', worstDot > 0.45, `worst ${worstDot.toFixed(2)}`);

// ---- 3. escape-proofing ----
// From many lane points, sweep outward at up to 111 m/s * 16 ms frames and
// verify the swept resolver always reports a hit and the corrected point is
// drivable.
let escapes = 0;
let stuck = 0;
const rng = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
for (let trial = 0; trial < 400; trial += 1) {
  const routeId = ids[Math.floor(rng() * ids.length)];
  const route = map.getRoute(routeId);
  const distance = rng() * route.length;
  const direction = route.bidirectional ? (rng() < 0.5 ? 1 : -1) : 1;
  const lane = Math.floor(rng() * route.lanes);
  const start = map.sampleLane(routeId, distance, lane, direction);
  const angle = rng() * Math.PI * 2;
  const speed = 20 + rng() * 91; // up to 400 km/h
  const velocity = new THREE.Vector3(Math.sin(angle) * speed, 0, Math.cos(angle) * speed);
  let position = start.position.clone();
  position.y += 0.4;
  for (let frame = 0; frame < 40; frame += 1) {
    const next = position.clone().addScaledVector(velocity, 1 / 60);
    const hit = map.sweepWallCollision(position, next, velocity, 0.85, 1.5);
    if (hit.hit) {
      position = hit.position.clone();
      velocity.copy(hit.velocity);
    } else {
      position = next;
    }
    if (!map.isPointDrivable(position, 2.6)) {
      // one recovery attempt via the resolver
      const fix = map.resolveWallCollision(position, velocity, 0.85);
      if (fix.hit) position = fix.position.clone();
      if (!map.isPointDrivable(position, 3.2)) {
        escapes += 1;
        if (escapes < 5) console.log(`   escape from ${routeId}@${distance.toFixed(0)} lane ${lane} at frame ${frame} pos (${position.x.toFixed(0)},${position.y.toFixed(1)},${position.z.toFixed(0)})`);
        break;
      }
    }
  }
  // after the barrage the car must not be stuck INSIDE a wall: resolver reports free
  const final = map.resolveWallCollision(position, null, 0.85);
  if (final.hit && final.correctionDistance > 1.2) stuck += 1;
}
check('no escapes through barriers (400 random 400 km/h barrages)', escapes === 0, `${escapes} escapes`);
check('never left stuck inside a wall', stuck === 0, `${stuck} stuck`);

// ---- 4. traffic walk ----
let deadEnds = 0;
for (let trial = 0; trial < 30; trial += 1) {
  const spawn = map.getTrafficSpawn(rng);
  let laneRef = spawn.laneRef;
  let s = spawn.distance;
  let alive = true;
  for (let step = 0; step < 2500 && alive; step += 1) {
    const result = map.advanceTraffic({ laneRef, s, distance: 28, vehicle: { poolIndex: trial } });
    if (!result) { alive = false; break; }
    laneRef = result.laneRef;
    s = result.s;
  }
  if (!alive) {
    deadEnds += 1;
    console.log(`   traffic died on ${laneRef?.routeId} dir ${laneRef?.direction} s=${s?.toFixed(0)}`);
  }
}
check('traffic walks 70 km from 30 spawns without dead-ending', deadEnds === 0, `${deadEnds} dead ends`);

// ---- 5. grand tour ----
const tour = ['c1', 'r11', 'wangan', 'dj', 'k1', 'wangan', 'r9'];
const tourKm = map.getRoute('c1').length + map.getRoute('r11').length + map.getRoute('wangan').length
  + map.getRoute('dj').length + map.getRoute('k1').length + map.getRoute('r9').length;
void tour;
const minutesAt140 = (tourKm / 1000) / 140 * 60;
check('grand tour ~30-45 min at 140 km/h', minutesAt140 > 28 && minutesAt140 < 48, `${(tourKm / 1000).toFixed(1)} km ≈ ${minutesAt140.toFixed(0)} min`);

// ---- lane convention: left-hand traffic ----
// A direction +1 lane centre must sit on the negative base-normal side.
const laneProbe = map.sampleLane('wangan', 5000, 0, 1);
const center = map._sampleCenter('wangan', 5000, 1);
const baseNormal = new THREE.Vector3(-center.baseTangent.z, 0, center.baseTangent.x);
const side = laneProbe.position.clone().sub(center.position).dot(baseNormal);
check('left-hand traffic (dir +1 lanes on negative base-normal side)', side < 0, `signed lateral ${side.toFixed(2)}`);

// roadInfo direction detection must agree with sampling
const info = map.getRoadInfo(laneProbe.position.clone());
check('getRoadInfo recovers direction +1 and route', info?.direction === 1 && info?.routeId === 'wangan', `dir ${info?.direction} route ${info?.routeId} lane ${info?.lane}`);
const laneProbe2 = map.sampleLane('wangan', 5000, 2, -1);
const info2 = map.getRoadInfo(laneProbe2.position.clone());
check('getRoadInfo recovers direction -1 lane 2', info2?.direction === -1 && info2?.lane === 2, `dir ${info2?.direction} lane ${info2?.lane}`);

console.log(`\n${failures === 0 ? 'ALL OK' : `${failures} FAILURES`}`);
process.exit(failures ? 1 : 0);
