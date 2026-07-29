/**
 * Traffic vs. the road surface, on slopes and banked bends.
 *
 * Two separate faults produced the same symptom ("cars sink through the road"):
 *
 *  1. POSITION. Lane samples placed a car on the horizontal plane through the
 *     centreline, but the deck is banked: y(s, l) = curveY(s) + tan(bank)·l.
 *     A car in an outer lane of a wide banked bend was off its own asphalt by
 *     up to half a metre, vertically.
 *  2. ATTITUDE. The mesh was yaw-only, so on a grade the body stayed level
 *     while the deck tilted away — nose or tail buried in the asphalt by
 *     halfLength·sin(grade).
 *  3. HAND-OFFS. At a junction the car kept the height of the route it was
 *     leaving and eased onto the new one over ~1 s, so at every exit where the
 *     decks meet at different heights it drove buried in (or floating over)
 *     the asphalt for tens of metres. It also "eased" across continuation
 *     edges whose routes are 55 m apart, which flew a car through the terrain.
 *
 * This drives the REAL TrafficSystem over the REAL map and measures all of it
 * against the map's own authoritative deck surface (_frameAt/_deckPoint, what
 * the asphalt is built from and what physics reads):
 *
 *   deckError  — vertical distance from the car's contact point to the deck.
 *   cornerDrop — how far the deepest of the four underside corners sits BELOW
 *                the deck. This is the number you actually see.
 *
 * Then, separately from the drive, two build-time surface checks:
 *
 *   hand-offs  — every directed junction edge traffic can take, walked through
 *                the real advanceTraffic, checking the car lands ON the deck.
 *   light pool — how far the additive lamp decals float over the asphalt. They
 *                are what cars visibly wade through when this is too large.
 *
 * Run from repo root:  node .devtests/traffic-slope-probe.mjs
 */
import * as THREE from 'three';
import { TrafficSystem } from '../js/traffic.js';
import { HighwayMap } from '../js/map.js';

const scene = new THREE.Group();
const map = new HighwayMap(null, {});
const traffic = new TrafficSystem(scene, map, { count: 60, density: 1 });

/**
 * Deck height under a world point, on ONE named route. The route has to be
 * pinned: a ramp climbing away from the mainline it crosses is metres off the
 * mainline's deck by design, and letting getRoadInfo pick the corridor would
 * score that healthy geometry as a fault.
 */
function deckYOn(routeId, position) {
  const route = map.routes.get(routeId);
  if (!route) return null;
  const projection = map.getNearestRoute(position, { maxDistance: 60, routeIds: [routeId] });
  if (projection?.route?.id !== routeId) return null;
  const frame = map._frameAt(route, projection.distance);
  return map._deckPoint(frame, projection.signedLateral).y;
}

const spawn = map.getInitialSpawn();
const player = {
  position: spawn.position.clone(),
  previousPosition: spawn.position.clone(),
  velocity: new THREE.Vector3(0, 0, 40),
  forward: new THREE.Vector3(Math.sin(spawn.heading), 0, Math.cos(spawn.heading)),
  heading: spawn.heading,
  speed: 40,
  width: 1.75,
  length: 4.4,
  height: 1.3,
  spec: {},
};

const stats = {
  samples: 0,
  deckErrorMax: 0,
  deckErrorSum: 0,
  cornerDropMax: 0,
  cornerDropSum: 0,
  cornerFitSum: 0,
  cornerFitCount: 0,
  pitchedMax: 0,
  gradeMax: 0,
  bankMax: 0,
};
const corner = new THREE.Vector3();

for (let step = 0; step < 5400; step += 1) {
  player.previousPosition.copy(player.position);
  player.position.addScaledVector(player.forward, player.speed / 60);
  const road = map.getRoadInfo(player.position);
  if (road) {
    player.position.copy(road.center);
    player.heading = road.heading;
    player.forward.set(Math.sin(road.heading), 0, Math.cos(road.heading));
  }
  traffic.update(1 / 60, player);

  // Sample a few vehicles per step rather than all of them every step: the
  // point is coverage of the network, not of one frame.
  if (step % 10) continue;
  for (const vehicle of traffic.active) {
    if (vehicle.spawnGrace > 0) continue;
    const routeId = vehicle.laneRef?.routeId;
    const deckY = deckYOn(routeId, vehicle.position);
    if (deckY === null) continue;
    const deckError = Math.abs(vehicle.position.y - deckY);

    let drop = 0;
    vehicle.mesh.updateMatrix();
    const halfLength = vehicle.length * 0.5;
    const halfWidth = vehicle.width * 0.5;
    for (const sz of [-1, 1]) {
      for (const sx of [-1, 1]) {
        corner.set(sx * halfWidth, 0, sz * halfLength).applyMatrix4(vehicle.mesh.matrix);
        const cornerDeck = deckYOn(routeId, corner);
        if (cornerDeck === null) continue;
        drop = Math.max(drop, cornerDeck - corner.y);
        // Unsigned fit of the whole underside. Unlike the drop this also
        // punishes floating, so it is what catches an attitude that leans the
        // right amount the wrong way: an inverted roll trades one sunken
        // corner for another and barely moves the drop, but doubles this.
        stats.cornerFitSum += Math.abs(corner.y - cornerDeck);
        stats.cornerFitCount += 1;
      }
    }

    const grade = Math.abs(Math.asin(THREE.MathUtils.clamp(vehicle.tangent.y, -1, 1)));
    stats.samples += 1;
    stats.deckErrorSum += deckError;
    stats.deckErrorMax = Math.max(stats.deckErrorMax, deckError);
    stats.cornerDropSum += drop;
    stats.cornerDropMax = Math.max(stats.cornerDropMax, drop);
    stats.gradeMax = Math.max(stats.gradeMax, grade);
    stats.pitchedMax = Math.max(stats.pitchedMax, Math.abs(Math.asin(
      THREE.MathUtils.clamp(new THREE.Vector3(0, 0, 1).applyQuaternion(vehicle.mesh.quaternion).y, -1, 1),
    )));
  }
}

// ---------------------------------------------------------------------------
// Junction hand-offs. The drive above rarely reaches a route end, so drive a
// pooled vehicle off the end of every traffic route instead — through the REAL
// _updateVehicle, so the blend under test is the shipping one and not a copy
// of it that could drift.
// ---------------------------------------------------------------------------
const handoff = { count: 0, offDeckMax: 0, offDeckSum: 0, strayMax: 0, blendedMax: 0, offRoad: 0 };
{
  const probe = traffic.pool[0];
  const realPoolIndex = probe.poolIndex;
  for (const route of map.routes.values()) {
    if (!route.traffic) continue;
    for (let lane = 0; lane < route.lanes; lane += 1) {
      // advanceAlongRoute picks between several continuation/merge options with
      // `poolIndex % options.length`, so one vehicle only ever walks one branch.
      // Sweep the index or whole edges never get exercised — including the
      // r11_0 -> ramp_14 continuation whose routes are 55 m apart.
      for (let branch = 0; branch < 4; branch += 1) {
      probe.poolIndex = branch;
      const direction = route.oneWay ? route.oneWayDirection : 1;
      const laneRef = map._laneRefFor(route, lane, direction);
      const s = direction > 0 ? Math.max(0, route.length - 260) : Math.min(route.length, 260);
      const start = map.sampleTrafficLane(laneRef, s);
      if (!start) continue;

      traffic.active = [probe];
      probe.active = true;
      probe.laneRef = laneRef;
      probe.laneKey = `${route.id}:${lane}:${direction > 0 ? '+' : '-'}`;
      probe.s = s;
      probe.mapState = null;
      probe.blendOffset = null;
      probe.position.copy(start.position);
      probe.previousPosition.copy(start.position);
      probe.tangent.copy(start.tangent);
      probe.up.set(0, 1, 0);
      probe.speed = 30;
      probe.forcedSpeed = true;
      probe.targetSpeed = 30;
      probe.acceleration = 0;
      probe.spawnGrace = 0;

      for (let i = 0; i < 700; i += 1) {
        const before = probe.laneRef?.routeId;
        if (!traffic._updateVehicle(probe, 1 / 60, player, {})) break;
        const routeId = probe.laneRef?.routeId;
        const blended = probe.blendOffset ? probe.blendOffset.length() : 0;
        handoff.blendedMax = Math.max(handoff.blendedMax, blended);
        if (routeId === before && !blended) continue;
        // Landed on (or is easing onto) a route. Two different questions, and
        // they need two different references.
        //
        // HEIGHT is measured against the car's OWN route's deck. Letting
        // getRoadInfo choose the corridor does not work here: at a stacked
        // junction it resolves a car on r11_0 to the r1_2 deck crossing 64 cm
        // below, and every large "error" it reported was that mismatch rather
        // than a car off its road.
        //
        // BEING ON ASPHALT AT ALL is the opposite: a gore blend crosses the
        // HOST's deck by design, so that one has to accept any corridor.
        const deck = deckYOn(routeId, probe.position);
        if (deck !== null) {
          const off = Math.abs(probe.position.y - deck);
          handoff.count += 1;
          handoff.offDeckSum += off;
          handoff.offDeckMax = Math.max(handoff.offDeckMax, off);
        }
        const road = map.getRoadInfo(probe.position);
        if (!road) { handoff.offRoad += 1; continue; }
        handoff.strayMax = Math.max(handoff.strayMax,
          Math.abs(road.signedLateral) - road.roadHalfWidth);
      }
      probe.active = false;
      }
    }
  }
  probe.poolIndex = realPoolIndex;
  traffic.active = [];
}

// ---------------------------------------------------------------------------
// Lamp ground decals. Read the instance matrices of the additive pools the map
// ACTUALLY BUILT and measure them against the asphalt under them — this is the
// "cars drive through a cloud of light" number. Reading the built geometry
// rather than recomputing the lamp walk means a change to the lift constants
// or to the sag probe shows up here; a private copy of the maths would not.
// ---------------------------------------------------------------------------
const poolLift = [];
{
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const meshes = [];
  map.group.traverse((object) => {
    if (object.isInstancedMesh && /pool:lightPool$/.test(object.name)) meshes.push(object);
  });
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    for (let i = 0; i < mesh.count; i += 1) {
      mesh.getMatrixAt(i, matrix);
      matrix.premultiply(mesh.matrixWorld);
      // The unit quad is 1x1 in local XZ, so ±0.3 down local Z walks the
      // bright core of the glow; outside that the sprite has faded out.
      for (const f of [-0.3, -0.15, 0, 0.15, 0.3]) {
        point.set(0, 0, f).applyMatrix4(matrix);
        const road = map.getRoadInfo(point);
        if (!road?.route || !road.onRoadSurface) continue;
        const deck = map._deckPoint(map._frameAt(road.route, road.distance), road.signedLateral).y;
        poolLift.push(point.y - deck);
      }
    }
  }
}
poolLift.sort((a, b) => a - b);
const q = (p) => poolLift[Math.floor(p * (poolLift.length - 1))];

const deg = (rad) => `${(rad * 180 / Math.PI).toFixed(2)}°`;
const cm = (m) => `${(m * 100).toFixed(1)} cm`;
console.log('samples                :', stats.samples);
console.log('deck error   mean / max:', cm(stats.deckErrorSum / stats.samples), '/', cm(stats.deckErrorMax));
console.log('corner drop  mean / max:', cm(stats.cornerDropSum / stats.samples), '/', cm(stats.cornerDropMax));
console.log('underside fit      mean:', cm(stats.cornerFitSum / stats.cornerFitCount));
console.log('steepest grade driven  :', deg(stats.gradeMax));
console.log('steepest body pitch    :', deg(stats.pitchedMax));
console.log('hand-off frames checked:', handoff.count);
console.log('  off the deck while handing over mean / max:', cm(handoff.offDeckSum / handoff.count), '/', cm(handoff.offDeckMax));
console.log('  widest blend offset carried              :', `${handoff.blendedMax.toFixed(2)} m`);
console.log('  furthest outside the paved corridor      :', `${handoff.strayMax.toFixed(2)} m`);
console.log('  frames on no road surface at all         :', handoff.offRoad);
console.log('light pool over the asphalt (bright core), n =', poolLift.length);
console.log('  p50', cm(q(0.5)), ' p90', cm(q(0.9)), ' p99', cm(q(0.99)));

const failures = [];
if (stats.samples < 500) failures.push(`only ${stats.samples} samples — the drive never got going`);
if (stats.deckErrorMax > 0.05) failures.push(`lane centres off the deck by up to ${cm(stats.deckErrorMax)}`);
// The body is a rigid chord over a curving deck, so its nose corner still cuts
// a few centimetres inside the arc on the tightest ramp bends. That residual is
// geometry, not attitude, and is well under the old half-metre dive.
if (stats.cornerDropMax > 0.15) failures.push(`body corners under the deck by up to ${cm(stats.cornerDropMax)}`);
if (stats.cornerFitSum / stats.cornerFitCount > 0.03) {
  failures.push(`underside sits ${cm(stats.cornerFitSum / stats.cornerFitCount)} off the deck on average`);
}
// A body that never pitches on a network with real gradients is the old bug.
if (stats.gradeMax > 0.02 && stats.pitchedMax < stats.gradeMax * 0.5) {
  failures.push(`body stays level (${deg(stats.pitchedMax)}) on grades up to ${deg(stats.gradeMax)}`);
}
// Landing on a junction must put the car on the new road, not on the old
// road's height. A couple of centimetres is the sampler's own projection
// error; anything more is the vertical blend coming back.
if (handoff.count < 40) failures.push(`only ${handoff.count} hand-off frames checked — the junction sweep is not running`);
if (handoff.offDeckMax > 0.08) failures.push(`cars sit ${cm(handoff.offDeckMax)} off the deck while handing over`);
// Easing across a gap wider than a few lane widths drags the car through
// whatever lies between two routes that do not actually meet — including, on
// r11_0 -> ramp_14, 55 m of open air.
// A blend may carry a car across the gore, never off the paved corridor.
if (handoff.strayMax > 2) {
  failures.push(`a hand-off blend puts cars ${handoff.strayMax.toFixed(1)} m past the paved edge`);
}
if (handoff.offRoad > 0) {
  failures.push(`${handoff.offRoad} hand-off frames put a car on no road surface at all`);
}
// The lamp ribbon has to lie ON the road. Every centimetre it floats is a
// centimetre of car that visibly drives through it. The tail is a flat quad
// spanning a curving deck — the only way to shrink it further is to break the
// ribbon into shorter segments, which would re-tune how the glow reads.
if (q(0.5) > 0.06) failures.push(`light pools float ${cm(q(0.5))} over the asphalt at the median`);
if (q(0.9) > 0.16) failures.push(`light pools float ${cm(q(0.9))} over the asphalt at p90`);
if (q(0.99) > 0.28) failures.push(`light pools float ${cm(q(0.99))} over the asphalt at p99`);
// Floating is the bug being fixed, but burying the ribbon in the deck trades
// it for a hard dark band, so guard that direction too.
if (q(0.01) < -0.05) failures.push(`light pools sink ${cm(-q(0.01))} into the asphalt at p1`);

if (failures.length) {
  console.log('\nFAIL');
  for (const failure of failures) console.log(' -', failure);
  process.exitCode = 1;
} else {
  console.log('\nPASS — traffic sits on the deck and follows its grade and bank');
}
