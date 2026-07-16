/**
 * P4 diverge topology/continuity acceptance gate.
 *
 * The reference corridor is derived from source geometry: hold the fully
 * opened host auxiliary centre until branch lane 0 reaches it, then blend to
 * that real branch lane. The current Checkpoint-1 implementation is expected
 * to fail because it instead returns the auxiliary path to the host.
 */
import * as THREE from 'three';
import { writeFile } from 'node:fs/promises';
import { HighwayMap } from '../js/map.js';

const outputArg = process.argv.find((argument) => argument.startsWith('--json='));
const outputPath = outputArg?.slice('--json='.length) || null;
const map = new HighwayMap(null, { addLighting: false, markingDebug: true });
const transition = map.progressiveTransitions.find((candidate) => (
  candidate.id === 'J2:diverge:c1_0:r1_0:start'));
if (!transition) throw new Error('P4 active transition is missing');
const zone = transition.sourceZone;
const rows = [...zone.samples].sort((left, right) => left.hU - right.hU);
const aux = transition.laneCentres.find((lane) => lane.id === 'aux:0');
const laneEdge = zone.host.lanes * zone.host.laneWidth * 0.5;
const parallelAuxLateral = zone.side * (laneEdge + transition.auxiliaryWidth * 0.5);
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const point = (value) => new THREE.Vector3(value.x, value.y, value.z);
const distanceXZ = (left, right) => Math.hypot(left.x - right.x, left.z - right.z);
const degrees = (radians) => radians * 180 / Math.PI;
const round = (value, digits = 3) => +value.toFixed(digits);

const branchLane = (row, lane = 0) => map.sampleLane(zone.branch.id, row.bS, lane, 1);
const hostAuxPoint = (row) => map._deckPoint(map._frameAt(zone.host, row.hU), parallelAuxLateral, 0.035);
const outwardBranchLane0 = (row) => {
  const target = branchLane(row, 0).position;
  const projection = map._projectToRoute(zone.host, target, map._hostSeedIndex(zone.host, row.hS));
  return zone.side * projection.signedLateral;
};
const alignmentRow = rows.find((row) => outwardBranchLane0(row) >= Math.abs(parallelAuxLateral)) || rows.at(-1);
const splitRow = rows.find((row) => row.innerEdge >= row.hostHalf - 0.3) || rows.at(-1);
const exteriorHandoffRow = rows.find((row) => (
  row.unionOuter >= row.hostHalf + transition.targetExtraWidth - 0.1)) || splitRow;
const lastRow = rows.at(-1);
const handoffStartPoint = hostAuxPoint(exteriorHandoffRow);
const handoffEndPoint = point(branchLane(lastRow, 0).position);
handoffStartPoint.y += 0.035;
handoffEndPoint.y += 0.035;
const handoffControlLength = handoffStartPoint.distanceTo(handoffEndPoint) * 0.4;
const handoffStartTangent = map._frameAt(zone.host, exteriorHandoffRow.hU).tangent;
const handoffEndTangent = map._frameAt(zone.branch, lastRow.bS).tangent;
const handoffControl0 = handoffStartPoint.clone().addScaledVector(handoffStartTangent, handoffControlLength);
const handoffControl1 = handoffEndPoint.clone().addScaledVector(handoffEndTangent, -handoffControlLength);

const interpolateAux = (hostS) => {
  const points = aux.points;
  let upper = 1;
  while (upper < points.length && points[upper].hostS < hostS) upper += 1;
  if (upper >= points.length) return point(points.at(-1).position);
  const left = points[upper - 1];
  const right = points[upper];
  const t = clamp((hostS - left.hostS) / Math.max(1e-6, right.hostS - left.hostS), 0, 1);
  return point(left.position).lerp(point(right.position), t);
};
const intendedPointAtHost = (hostS) => {
  if (hostS <= exteriorHandoffRow.hU) {
    const frame = map._frameAt(zone.host, hostS);
    return map._deckPoint(frame, parallelAuxLateral, 0.035);
  }
  const t = clamp((hostS - exteriorHandoffRow.hU)
    / Math.max(1e-6, lastRow.hU - exteriorHandoffRow.hU), 0, 1);
  const u = 1 - t;
  return handoffStartPoint.clone().multiplyScalar(u * u * u)
    .add(handoffControl0.clone().multiplyScalar(3 * u * u * t))
    .add(handoffControl1.clone().multiplyScalar(3 * u * t * t))
    .add(handoffEndPoint.clone().multiplyScalar(t * t * t));
};
const intendedPoint = (row) => intendedPointAtHost(row.hU);
const nearestRowAtHost = (hostS) => rows.reduce((best, row) => (
  Math.abs(row.hU - hostS) < Math.abs(best.hU - hostS) ? row : best));

const usableRows = transition.pavedEnvelope.filter((row) => (
  row.hostS >= transition.parallelStart - 0.01 && row.hostS <= alignmentRow.hU + 0.01));
const minimumUsableExtraWidth = Math.min(...usableRows.map((row) => row.extraWidth));
const prematureClosure = usableRows.find((row) => row.extraWidth < transition.auxiliaryWidth - 0.15) || null;
const sourceOuterAt = (hostS) => {
  let upper = 1;
  while (upper < rows.length && rows[upper].hU < hostS) upper += 1;
  if (upper >= rows.length) return rows.at(-1).unionOuter;
  const left = rows[upper - 1];
  const right = rows[upper];
  const t = (hostS - left.hU) / Math.max(1e-6, right.hU - left.hU);
  return left.unionOuter + (right.unionOuter - left.unionOuter) * t;
};
let maximumAuthoritativeOuterStep = 0;
let maximumSourceOuterStep = 0;
let previousAuthoritativeOuter = null;
let previousSourceOuter = null;
for (const row of transition.pavedEnvelope) {
  const sourceOuter = sourceOuterAt(row.hostS);
  const authoritativeOuter = Math.max(row.baseHalf + row.extraWidth, sourceOuter);
  if (previousAuthoritativeOuter !== null) {
    maximumAuthoritativeOuterStep = Math.max(maximumAuthoritativeOuterStep,
      Math.abs(authoritativeOuter - previousAuthoritativeOuter));
    maximumSourceOuterStep = Math.max(maximumSourceOuterStep,
      Math.abs(sourceOuter - previousSourceOuter));
  }
  previousAuthoritativeOuter = authoritativeOuter;
  previousSourceOuter = sourceOuter;
}
const endpointGapToBranchLane0 = distanceXZ(
  point(aux.points.at(-1).position),
  branchLane(lastRow, 0).position,
);

let maximumReferencePathGap = 0;
let maximumAuxTangentStep = 0;
let previousDirection = null;
for (let index = 1; index < aux.points.length; index += 1) {
  const a = point(aux.points[index - 1].position);
  const b = point(aux.points[index].position);
  const direction = b.clone().sub(a).normalize();
  if (previousDirection) {
    maximumAuxTangentStep = Math.max(maximumAuxTangentStep,
      degrees(Math.acos(clamp(previousDirection.dot(direction), -1, 1))));
  }
  previousDirection = direction;
  const row = nearestRowAtHost(aux.points[index].hostS);
  if (row.hU >= exteriorHandoffRow.hU) {
    maximumReferencePathGap = Math.max(maximumReferencePathGap,
      distanceXZ(b, intendedPointAtHost(aux.points[index].hostS)));
  }
}

let pavementHoleSamples = 0;
let collisionCorrectionSamples = 0;
let maximumCollisionCorrection = 0;
for (const row of rows.filter((candidate) => candidate.hU >= transition.parallelStart)) {
  const probe = intendedPoint(row);
  const road = map.getRoadInfo(probe, zone.host.id);
  if (!road?.drivable) pavementHoleSamples += 1;
  const collision = map.resolveWallCollision(probe, 0.9);
  if (collision.hit) {
    collisionCorrectionSamples += 1;
    maximumCollisionCorrection = Math.max(maximumCollisionCorrection, collision.correctionDistance || 0);
  }
}

const interiorRailSamples = (zone.host._progressiveRailSamples || []).filter((sample) => {
  if (sample.transitionId !== transition.id || sample.side !== zone.side) return false;
  if (sample.distance < exteriorHandoffRow.hU || sample.distance > splitRow.hU) return false;
  const row = nearestRowAtHost(sample.distance);
  const emittedOutward = zone.side * sample.actualOuterLateral;
  return emittedOutward < row.unionOuter - 0.25;
});

const progressivePaint = map._markingLog.filter((piece) => (
  piece.kind === 'strip' && piece.owner === `progressive:${transition.id}`));
const illegalSolidPieces = progressivePaint.filter((piece) => (
  piece.tag === 'progressiveOuterEdge'
  && piece.sTo > exteriorHandoffRow.hU + 0.01
  && piece.sFrom < splitRow.hU - 0.01));
const illegalSolidLength = illegalSolidPieces.reduce((sum, piece) => sum
  + Math.max(0, Math.min(piece.sTo, splitRow.hU) - Math.max(piece.sFrom, exteriorHandoffRow.hU)), 0);
const dashPieces = progressivePaint.filter((piece) => piece.tag === 'progressiveAuxBoundary')
  .sort((left, right) => left.sFrom - right.sFrom);
let maximumDashGap = 0;
for (let index = 1; index < dashPieces.length; index += 1) {
  maximumDashGap = Math.max(maximumDashGap, dashPieces[index].sFrom - dashPieces[index - 1].sTo);
}
const branchBoundaryAtEnd = map._deckPoint(
  map._frameAt(zone.branch, lastRow.bS),
  zone.hostwardSign * laneEdge,
  0.04,
);
const transitionBoundaryAtEnd = transition.laneBoundaries
  .find((boundary) => boundary.id === 'aux-boundary')?.points.at(-1)?.position;
const markingHandoffGap = transitionBoundaryAtEnd
  ? distanceXZ(transitionBoundaryAtEnd, branchBoundaryAtEnd)
  : Infinity;

const metrics = {
  junctionId: transition.id,
  side: transition.side,
  hostRouteId: transition.hostRouteId,
  branchRouteId: transition.branchRouteId,
  hostLaneCount: transition.hostLaneCount,
  branchLaneCount: transition.branchLaneCount,
  alignment: { hostS: round(alignmentRow.hU), branchS: round(alignmentRow.bS) },
  physicalSplit: { hostS: round(splitRow.hU), branchS: round(splitRow.bS) },
  exteriorHandoff: { hostS: round(exteriorHandoffRow.hU), branchS: round(exteriorHandoffRow.bS) },
  auxiliary: {
    width: round(transition.auxiliaryWidth),
    minimumUsableExtraWidth: round(minimumUsableExtraWidth),
    prematureClosureHostS: prematureClosure ? round(prematureClosure.hostS) : null,
    endpointGapToBranchLane0: round(endpointGapToBranchLane0),
    maximumReferencePathGap: round(maximumReferencePathGap),
    maximumTangentStepDeg: round(maximumAuxTangentStep),
    maximumAuthoritativeOuterStep: round(maximumAuthoritativeOuterStep),
    maximumSourceOuterStep: round(maximumSourceOuterStep),
  },
  pavementCollision: {
    sampledStations: rows.filter((candidate) => candidate.hU >= transition.parallelStart).length,
    pavementHoleSamples,
    collisionCorrectionSamples,
    maximumCollisionCorrection: round(maximumCollisionCorrection),
  },
  guardrail: {
    emittedInteriorSamples: interiorRailSamples.length,
    firstInteriorHostS: interiorRailSamples.length ? round(interiorRailSamples[0].distance) : null,
  },
  markings: {
    illegalSolidAcrossExitLength: round(illegalSolidLength),
    maximumDashGap: round(maximumDashGap),
    handoffGapToBranchBoundary: round(markingHandoffGap),
  },
};

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
check(transition.side === 'left', `driver-relative side is ${transition.side}`);
check(minimumUsableExtraWidth >= transition.auxiliaryWidth - 0.15,
  `auxiliary width closes to ${minimumUsableExtraWidth.toFixed(2)} m before branch alignment`);
check(!prematureClosure, `premature lane closure starts at host s=${prematureClosure?.hostS.toFixed(1)}`);
check(endpointGapToBranchLane0 <= 0.5,
  `auxiliary endpoint is ${endpointGapToBranchLane0.toFixed(2)} m from branch lane 0`);
check(maximumReferencePathGap <= 0.75,
  `auxiliary path departs the source-derived handoff by ${maximumReferencePathGap.toFixed(2)} m`);
check(maximumAuxTangentStep <= 5, `auxiliary tangent step ${maximumAuxTangentStep.toFixed(2)} deg`);
check(maximumAuthoritativeOuterStep <= Math.max(0.7, maximumSourceOuterStep + 0.05),
  `paved-union lateral step ${maximumAuthoritativeOuterStep.toFixed(2)} m exceeds source trajectory`);
check(pavementHoleSamples === 0, `${pavementHoleSamples} intended-corridor pavement holes`);
check(collisionCorrectionSamples === 0,
  `${collisionCorrectionSamples} intended-corridor collision corrections (max ${maximumCollisionCorrection.toFixed(2)} m)`);
check(interiorRailSamples.length === 0,
  `${interiorRailSamples.length} emitted host-rail samples lie inside the shared paved union`);
check(illegalSolidLength <= 0.5, `${illegalSolidLength.toFixed(1)} m solid marking crosses the exit handoff`);
check(maximumDashGap <= 6.2, `unexplained dash gap ${maximumDashGap.toFixed(2)} m`);
check(markingHandoffGap <= 0.75,
  `temporary boundary ends ${markingHandoffGap.toFixed(2)} m from the branch boundary`);

const report = { expectedInvariant: 'open auxiliary -> source-derived branch lane 0 handoff', metrics, failures };
if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(metrics, null, 2));
if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${transition.id}: ${failure}`));
  console.error(`P4 DIVERGE CONTINUITY PROBE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('P4 DIVERGE CONTINUITY PROBE: PASS');
}
