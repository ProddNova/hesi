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
 *
 * This drives the REAL TrafficSystem over the REAL map and measures both
 * against the map's own authoritative deck surface (_frameAt/_deckPoint, what
 * the asphalt is built from and what physics reads):
 *
 *   deckError  — vertical distance from the car's contact point to the deck.
 *   cornerDrop — how far the deepest of the four underside corners sits BELOW
 *                the deck. This is the number you actually see.
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

const deg = (rad) => `${(rad * 180 / Math.PI).toFixed(2)}°`;
const cm = (m) => `${(m * 100).toFixed(1)} cm`;
console.log('samples                :', stats.samples);
console.log('deck error   mean / max:', cm(stats.deckErrorSum / stats.samples), '/', cm(stats.deckErrorMax));
console.log('corner drop  mean / max:', cm(stats.cornerDropSum / stats.samples), '/', cm(stats.cornerDropMax));
console.log('underside fit      mean:', cm(stats.cornerFitSum / stats.cornerFitCount));
console.log('steepest grade driven  :', deg(stats.gradeMax));
console.log('steepest body pitch    :', deg(stats.pitchedMax));

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

if (failures.length) {
  console.log('\nFAIL');
  for (const failure of failures) console.log(' -', failure);
  process.exitCode = 1;
} else {
  console.log('\nPASS — traffic sits on the deck and follows its grade and bank');
}
