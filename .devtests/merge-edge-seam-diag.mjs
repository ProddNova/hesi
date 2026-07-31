/**
 * Diagnostic for the reported break in the paved surface where ramp_8's deck
 * hands over to the wangan_0 progressive envelope: walk the host stations and
 * report, in WORLD space, the outermost paved point of the host envelope and of
 * the ramp's own deck, plus where each side's parapet actually draws.
 *
 * Run: node .devtests/merge-edge-seam-diag.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const map = new HighwayMap(null, {});
const t = map.progressiveTransitions.find((r) => r.id.startsWith('J13:'));
const host = map.routes.get(t.hostRouteId);
const branch = map.routes.get(t.branchRouteId);
const side = t.sideSign;

const frameAt = (route, distance) => {
  const center = map._sampleCenter(route, distance, 1);
  const tangent = center.baseTangent;
  const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
  return { position: center.position, tangent, normal, bank: map._bankAt(route, distance), route, distance };
};

console.log(`rail release=${t.railOpeningStart.toFixed(1)} opening=${t.openingStart.toFixed(1)}`
  + ` FULL5=${t.parallelStart.toFixed(1)}  branch span=${t.branchInterval.map((v) => v.toFixed(1)).join('..')}`
  + ` of ${branch.length.toFixed(1)}`);
console.log('\n  hostS   envOuterLat  envOuterWorldLat  rampOuterWorldLat  gap    hostRail  branchOuterRail');
let previous = null;
for (let s = t.approachStart - 10; s <= t.parallelStart + 60; s += 4) {
  const frame = frameAt(host, s);
  const envLat = map._surfaceEdgeLateral({ ...frame, half: map._halfWidthAt(host, s) }, side, 0);
  const envPoint = map._deckPoint(frame, envLat, 0);
  // Where is the ramp's own outer edge, measured in the host's frame?
  const projection = map._projectToRoute(branch, envPoint);
  let rampOuter = null;
  if (projection.endOvershoot <= 2) {
    const bFrame = frameAt(branch, projection.distance);
    const bHalf = map._halfWidthAt(branch, projection.distance);
    const bPoint = map._deckPoint(bFrame, side * bHalf, 0);
    rampOuter = map._projectToRoute(host, bPoint).signedLateral;
  }
  const hostRail = (host._railRuns?.[side] || []).some((run) => s >= run.from && s <= run.to);
  const branchRail = projection.endOvershoot <= 2
    && (branch._railRuns?.[side] || []).some((run) => projection.distance >= run.from && projection.distance <= run.to);
  const outerWorld = rampOuter === null ? envLat : (Math.abs(rampOuter) > Math.abs(envLat) ? rampOuter : envLat);
  const jump = previous === null ? 0 : outerWorld - previous;
  previous = outerWorld;
  console.log(`  ${s.toFixed(1).padStart(7)}  ${envLat.toFixed(2).padStart(10)}`
    + `  ${envLat.toFixed(2).padStart(15)}  ${(rampOuter === null ? '-' : rampOuter.toFixed(2)).padStart(16)}`
    + `  ${Math.abs(jump) > 0.6 ? `JUMP ${jump.toFixed(2)}` : ''.padStart(6)}`
    + `  ${hostRail ? 'on ' : 'off'}       ${projection.endOvershoot <= 2 ? (branchRail ? 'on' : 'off') : '-'}`);
}
