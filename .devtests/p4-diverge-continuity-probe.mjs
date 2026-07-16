/**
 * P4 temporary 2+2 diverge hard acceptance gate.
 *
 * This samples both exiting lanes, all three topology boundaries, their
 * transition-owned markings, the emitted paved/collision geometry, and the
 * actual guardrail vertices. A width animation or a visually shifted stripe
 * cannot satisfy this probe without the two real branch-lane handoffs.
 */
import * as THREE from 'three';
import { writeFile } from 'node:fs/promises';
import { HighwayMap } from '../js/map.js';

const ID = 'J2:diverge:c1_0:r1_0:start';
const outputArg = process.argv.find((argument) => argument.startsWith('--json='));
const outputPath = outputArg?.slice('--json='.length) || null;
const map = new HighwayMap(null, { addLighting: false, markingDebug: true });
const transition = map.progressiveTransitions.find((candidate) => candidate.id === ID);
if (!transition) throw new Error('P4 active transition is missing');
const zone = transition.sourceZone;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const point = (value) => new THREE.Vector3(value.x, value.y, value.z);
const distanceXZ = (left, right) => Math.hypot(left.x - right.x, left.z - right.z);
const degrees = (radians) => radians * 180 / Math.PI;
const round = (value, digits = 3) => +value.toFixed(digits);
const pathById = (collection, id) => collection.find((path) => path.id === id);
const interpolatePath = (path, hostS) => {
  let upper = 1;
  while (upper < path.points.length && path.points[upper].hostS < hostS) upper += 1;
  const right = path.points[Math.min(upper, path.points.length - 1)];
  const left = path.points[Math.max(0, upper - 1)];
  const t = clamp((hostS - left.hostS) / Math.max(1e-6, right.hostS - left.hostS), 0, 1);
  return point(left.position).lerp(point(right.position), t);
};
const pointToSegmentXZ = (value, start, end) => {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const denominator = dx * dx + dz * dz;
  const t = denominator > 1e-9
    ? clamp(((value.x - start.x) * dx + (value.z - start.z) * dz) / denominator, 0, 1)
    : 0;
  return {
    t,
    distance: Math.hypot(value.x - (start.x + dx * t), value.z - (start.z + dz * t)),
  };
};
const pointToPathXZ = (value, path) => Math.min(...path.points.slice(1).map((entry, index) => (
  pointToSegmentXZ(value, path.points[index].position, entry.position).distance
)));

const innerBoundary = pathById(transition.laneBoundaries, 'aux-inner-boundary');
const dividerBoundary = pathById(transition.laneBoundaries, 'aux-divider-boundary');
const outerBoundary = pathById(transition.laneBoundaries, 'aux-outer-boundary');
const innerMarking = pathById(transition.markingPaths, 'aux-inner-marking');
const dividerMarking = pathById(transition.markingPaths, 'aux-divider-marking');
const outerMarking = pathById(transition.markingPaths, 'aux-outer-marking');
const auxiliaryCentres = [0, 1].map((lane) => pathById(transition.laneCentres, `aux:${lane}`));
const laneCorridors = transition.auxiliaryLaneCorridors;
const combinedCorridor = transition.auxiliaryCorridor;
if ([innerBoundary, dividerBoundary, outerBoundary, innerMarking, dividerMarking,
  outerMarking, ...auxiliaryCentres].some((path) => !path)
  || laneCorridors.length !== 2 || !combinedCorridor.length) {
  throw new Error('P4 explicit 2+2 topology is incomplete');
}

const acceptedLaneWidth = Math.min(zone.host.laneWidth, zone.branch.laneWidth) - 0.15;
const laneMetrics = laneCorridors.map((corridor, lane) => {
  const centrePath = auxiliaryCentres[lane];
  let minimumConsecutiveOverlap = Infinity;
  let maximumTangentStep = 0;
  let maximumMidpointError = 0;
  let previousDirection = null;
  for (let index = 0; index < corridor.length; index += 1) {
    const section = corridor[index];
    maximumMidpointError = Math.max(
      maximumMidpointError,
      distanceXZ(interpolatePath(centrePath, section.hostS), section.centre),
    );
    if (!index) continue;
    const previous = corridor[index - 1];
    const centreDistance = distanceXZ(previous.centre, section.centre);
    minimumConsecutiveOverlap = Math.min(
      minimumConsecutiveOverlap,
      (previous.width + section.width) * 0.5 - centreDistance,
    );
    const direction = point(section.centre).sub(point(previous.centre));
    direction.y = 0;
    direction.normalize();
    if (previousDirection) {
      maximumTangentStep = Math.max(
        maximumTangentStep,
        degrees(Math.acos(clamp(previousDirection.dot(direction), -1, 1))),
      );
    }
    previousDirection = direction;
  }
  const targetLane = transition.branchExitLanes[lane];
  const branchFrame = map._frameAt(zone.branch, transition.transferCompleteBranch);
  const targetLateral = map._laneOffset(zone.branch, targetLane, 1);
  const targetCentre = map._deckPoint(branchFrame, targetLateral, 0.035);
  const finalDirection = point(corridor.at(-1).centre).sub(point(corridor.at(-2).centre));
  finalDirection.y = 0;
  finalDirection.normalize();
  const branchDirection = branchFrame.tangent.clone();
  branchDirection.y = 0;
  branchDirection.normalize();
  return {
    lane,
    targetLane,
    minimumWidth: Math.min(...corridor.map((section) => section.width)),
    maximumWidth: Math.max(...corridor.map((section) => section.width)),
    prematureClosure: corridor.find((section) => (
      section.hostS < transition.transferComplete - 1e-4
      && section.width < acceptedLaneWidth
    )) || null,
    minimumConsecutiveOverlap,
    maximumTangentStep,
    maximumMidpointError,
    endpointCentreGap: distanceXZ(corridor.at(-1).centre, targetCentre),
    branchTangentHandoff: degrees(Math.acos(clamp(finalDirection.dot(branchDirection), -1, 1))),
  };
});

let maximumEnvelopeRetreat = 0;
const pavedAfterUsable = transition.pavedEnvelope.filter((row) => (
  row.hostS >= transition.parallelStart - 1e-4
  && row.hostS <= transition.transferComplete + 1e-4
));
for (let index = 1; index < pavedAfterUsable.length; index += 1) {
  maximumEnvelopeRetreat = Math.max(
    maximumEnvelopeRetreat,
    pavedAfterUsable[index - 1].extraWidth - pavedAfterUsable[index].extraWidth,
  );
}

let maximumDividerMidpointError = 0;
let maximumLaneCentreFractionError = 0;
let markingOrderViolations = 0;
let minimumOuterToDividerSeparation = Infinity;
let maximumOuterBoundaryOffsetError = 0;
for (let index = 0; index < combinedCorridor.length; index += 1) {
  const section = combinedCorridor[index];
  const divider = interpolatePath(dividerBoundary, section.hostS);
  maximumDividerMidpointError = Math.max(
    maximumDividerMidpointError,
    distanceXZ(divider, point(section.inner).lerp(point(section.outer), 0.5)),
  );
  for (let lane = 0; lane < 2; lane += 1) {
    const centre = interpolatePath(auxiliaryCentres[lane], section.hostS);
    const projection = pointToSegmentXZ(centre, section.inner, section.outer).t;
    maximumLaneCentreFractionError = Math.max(
      maximumLaneCentreFractionError,
      Math.abs(projection - (lane === 0 ? 0.25 : 0.75)),
    );
  }
  const markingPoints = [innerMarking, dividerMarking, outerMarking]
    .map((path) => interpolatePath(path, section.hostS));
  const projections = markingPoints.map((entry) => {
    const dx = section.outer.x - section.inner.x;
    const dz = section.outer.z - section.inner.z;
    const denominator = dx * dx + dz * dz;
    return ((entry.x - section.inner.x) * dx + (entry.z - section.inner.z) * dz) / denominator;
  });
  if (!(projections[0] < projections[1] && projections[1] < projections[2])) {
    markingOrderViolations += 1;
  }
  minimumOuterToDividerSeparation = Math.min(
    minimumOuterToDividerSeparation,
    distanceXZ(markingPoints[2], markingPoints[1]),
  );
  maximumOuterBoundaryOffsetError = Math.max(
    maximumOuterBoundaryOffsetError,
    Math.abs(distanceXZ(markingPoints[2], section.outer) - transition.auxiliaryMarkingShoulder),
  );
}

const branchFrame = map._frameAt(zone.branch, transition.transferCompleteBranch);
const branchHalf = map._halfWidthAt(zone.branch, transition.transferCompleteBranch);
const targetBoundaryLaterals = [
  zone.hostwardSign * zone.branch.laneWidth,
  0,
  -zone.hostwardSign * zone.branch.laneWidth,
];
const endpointBoundaryGaps = [innerBoundary, dividerBoundary, outerBoundary].map((path, index) => (
  distanceXZ(path.points.at(-1).position, map._deckPoint(
    branchFrame,
    targetBoundaryLaterals[index],
    0.04,
  ))
));
const targetMarkingLaterals = [
  zone.hostwardSign * (branchHalf - 0.75),
  0,
  -zone.hostwardSign * (branchHalf - 0.75),
];
const endpointMarkingGaps = [innerMarking, dividerMarking, outerMarking].map((path, index) => (
  distanceXZ(path.points.at(-1).position, map._deckPoint(
    branchFrame,
    targetMarkingLaterals[index],
    0.055,
  ))
));

let pavementHoleSamples = 0;
let collisionHits = 0;
for (const corridor of laneCorridors) {
  for (const section of corridor) {
    for (const fraction of [0.15, 0.5, 0.85]) {
      const sample = point(section.inner).lerp(point(section.outer), fraction);
      if (!map.isPointDrivable(sample, 0.05)) pavementHoleSamples += 1;
      if (map.resolveWallCollision(sample, 0.4).hit) collisionHits += 1;
    }
  }
}
const markingPavementHoles = [innerMarking, dividerMarking, outerMarking]
  .flatMap((path) => path.points)
  .filter((entry) => (
    entry.hostS >= transition.openingStart - 1e-4
    && !map.isPointDrivable(point(entry.position), 0.1)
  ));
let continuingBranchPavementHoles = 0;
let continuingBranchWallHits = 0;
const continuationEnd = Math.min(zone.branch.length, transition.transferCompleteBranch + 48);
for (const lane of transition.branchExitLanes) {
  for (let branchS = transition.transferCompleteBranch; branchS <= continuationEnd; branchS += 2) {
    const sample = map.sampleLane(zone.branch.id, branchS, lane, 1).position;
    if (!map.isPointDrivable(sample, 0.05)) continuingBranchPavementHoles += 1;
    if (map.resolveWallCollision(sample, 0.4).hit) continuingBranchWallHits += 1;
  }
}

const nearestCombinedSection = (value) => combinedCorridor.reduce((best, section) => (
  distanceXZ(value, section.centre) < distanceXZ(value, best.centre) ? section : best
));
const entersExitCorridor = (value) => {
  const section = nearestCombinedSection(value);
  const proximity = pointToSegmentXZ(value, section.inner, section.outer);
  return proximity.t > 0.03 && proximity.t < 0.97 && proximity.distance < 0.45;
};
const hostRailSamples = (zone.host._progressiveRailSamples || [])
  .filter((sample) => sample.transitionId === ID && sample.role === 'host-exterior');
const branchRailSamples = (zone.branch._progressiveRailSamples || [])
  .filter((sample) => sample.transitionId === ID);
const exteriorBranchRail = branchRailSamples.filter((sample) => sample.role === 'branch-exterior');
const intrusiveRails = [...hostRailSamples, ...branchRailSamples]
  .filter((sample) => entersExitCorridor(sample.actualBasePosition));
const transitionWalls = map.wallSegments.filter((segment) => segment.progressiveTransitionId === ID);
const intrusiveWalls = transitionWalls.filter((segment) => {
  const middle = segment.start.clone().lerp(segment.end, 0.5);
  return [segment.start, middle, segment.end].some(entersExitCorridor);
});

// The old guardrail check compared a rail only with the unmodified route half
// width. That falsely rejected a correctly relocated exterior rail, yet could
// miss a rail crossing the new drivable wing. The corrected invariant checks
// emitted vertices against the progressive paved envelope and independently
// rejects any vertex/wall that enters a sampled drivable cross-section.
let maximumHostRailEnvelopeError = 0;
for (const sample of hostRailSamples) {
  const envelope = transition.envelopeAt(sample.distance);
  const squeeze = 0.36 * (1 - sample.terminalFactor);
  const expectedBase = envelope.outerLateral
    - transition.sideSign * (0.42 - squeeze);
  maximumHostRailEnvelopeError = Math.max(
    maximumHostRailEnvelopeError,
    Math.abs(sample.actualOuterLateral - envelope.outerLateral),
    Math.abs(sample.actualBaseLateral - expectedBase),
  );
}
let maximumBranchRailEnvelopeError = 0;
for (const sample of exteriorBranchRail) {
  const frame = map._frameAt(zone.branch, sample.distance);
  const expectedOuter = -zone.hostwardSign * map._halfWidthAt(zone.branch, sample.distance);
  const squeeze = 0.36 * (1 - sample.terminalFactor);
  const expectedBase = expectedOuter - sample.side * (0.42 - squeeze);
  maximumBranchRailEnvelopeError = Math.max(
    maximumBranchRailEnvelopeError,
    Math.abs(sample.actualOuterLateral - expectedOuter),
    Math.abs(sample.actualBaseLateral - expectedBase),
    Math.abs(frame.half - map._halfWidthAt(zone.branch, sample.distance)),
  );
}
const railHandoffGap = hostRailSamples.length && exteriorBranchRail.length
  ? distanceXZ(hostRailSamples.at(-1).actualBasePosition, exteriorBranchRail[0].actualBasePosition)
  : Infinity;
const prematureGoreRails = branchRailSamples.filter((sample) => (
  sample.role === 'branch-gore'
  && sample.distance < transition.goreBranchStart - 0.01
));

const progressivePaint = map._markingLog.filter((piece) => (
  piece.kind === 'strip' && piece.owner === `progressive:${ID}`
));
const paintByTag = (tag) => progressivePaint
  .filter((piece) => piece.tag === tag)
  .sort((left, right) => left.sFrom - right.sFrom);
const paint = {
  outer: paintByTag('progressiveOuterEdge'),
  inner: paintByTag('progressiveAuxBoundary'),
  divider: paintByTag('progressiveExitDivider'),
  gore: paintByTag('progressiveBranchGoreEdge'),
};
const markingPathByTag = new Map([
  ['progressiveOuterEdge', outerMarking],
  ['progressiveAuxBoundary', innerMarking],
  ['progressiveExitDivider', dividerMarking],
]);
let maximumEmittedMarkingDeviation = 0;
for (const piece of progressivePaint) {
  const path = markingPathByTag.get(piece.tag);
  if (!path) continue;
  maximumEmittedMarkingDeviation = Math.max(
    maximumEmittedMarkingDeviation,
    pointToPathXZ(piece.start, path),
    pointToPathXZ(piece.end, path),
  );
}
const routeBranchDivider = map._markingLog.filter((piece) => (
  piece.kind === 'strip' && piece.routeId === zone.branch.id
  && piece.owner === `route:${zone.branch.id}` && piece.tag === 'laneDivider'
  && piece.sFrom >= transition.transferCompleteBranch - 0.01
)).sort((left, right) => left.sFrom - right.sFrom);
const routeBranchHostwardEdge = map._markingLog.filter((piece) => (
  piece.kind === 'strip' && piece.routeId === zone.branch.id
  && piece.owner === `route:${zone.branch.id}` && piece.tag === 'edgeLine'
  && piece.boundary === `edge:${zone.hostwardSign}`
  && piece.sFrom >= transition.markingSettleEnd - 0.01
)).sort((left, right) => left.sFrom - right.sFrom);
const routeBranchOuterEdge = map._markingLog.filter((piece) => (
  piece.kind === 'strip' && piece.routeId === zone.branch.id
  && piece.owner === `route:${zone.branch.id}` && piece.tag === 'edgeLine'
  && piece.boundary === `edge:${-zone.hostwardSign}`
  && piece.sFrom >= transition.transferCompleteBranch - 0.01
)).sort((left, right) => left.sFrom - right.sFrom);
const handoffGap = (from, to) => (from && to ? distanceXZ(from.end, to.start) : Infinity);
const markingGaps = {
  outerToRoute: handoffGap(paint.outer.at(-1), routeBranchOuterEdge[0]),
  innerDashToGore: handoffGap(paint.inner.at(-1), paint.gore[0]),
  dividerToRoute: handoffGap(paint.divider.at(-1), routeBranchDivider[0]),
  goreToRoute: handoffGap(paint.gore.at(-1), routeBranchHostwardEdge[0]),
};
const retainedRoutePaint = map._markingLog.filter((piece) => (
  piece.kind === 'strip' && piece.classification === 'route-local'
  && ((piece.routeId === zone.host.id
    && piece.boundary === `edge:${transition.sideSign}`
    && piece.sTo > transition.approachStart && piece.sFrom < transition.transferComplete)
  || (piece.routeId === zone.branch.id
    && piece.sTo > transition.branchInterval[0] && piece.sFrom < transition.branchInterval[1]))
));

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
check(transition.side === 'left', `driver-relative side is ${transition.side}`);
check(transition.topology === '2+2-diverge', `topology is ${transition.topology}`);
check(transition.hostLaneCount === 2 && transition.branchLaneCount === 2
  && transition.auxiliaryLaneCount === 2 && transition.temporaryLaneCount === 4,
'P4 is not 2 continuing + 2 exiting lanes');
check(transition.branchExitLanes.join(',') === '0,1',
  `branch targets are ${transition.branchExitLanes.join(',')}`);
check(Math.abs(transition.targetExtraWidth - 7.1) <= 0.01,
  `paved widening is ${transition.targetExtraWidth.toFixed(2)} m`);
for (const metric of laneMetrics) {
  check(metric.minimumWidth >= acceptedLaneWidth,
    `aux:${metric.lane} pinches to ${metric.minimumWidth.toFixed(2)} m`);
  check(!metric.prematureClosure,
    `aux:${metric.lane} closes at ${metric.prematureClosure?.hostS.toFixed(2)}`);
  check(metric.minimumConsecutiveOverlap > 0,
    `aux:${metric.lane} consecutive sections do not overlap`);
  check(metric.maximumTangentStep <= 5,
    `aux:${metric.lane} tangent step ${metric.maximumTangentStep.toFixed(2)} deg`);
  check(metric.maximumMidpointError <= 0.05,
    `aux:${metric.lane} centre/boundary midpoint error ${metric.maximumMidpointError.toFixed(2)} m`);
  check(metric.endpointCentreGap <= 0.15,
    `aux:${metric.lane} misses branch:${metric.targetLane} centre by ${metric.endpointCentreGap.toFixed(2)} m`);
  check(metric.branchTangentHandoff <= 5,
    `aux:${metric.lane} branch tangent handoff ${metric.branchTangentHandoff.toFixed(2)} deg`);
}
check(Math.min(...combinedCorridor.map((section) => section.width)) >= 7.0,
  'combined exit carriageway loses its two-lane width');
check(maximumEnvelopeRetreat <= 0.01,
  `outer paved envelope retreats ${maximumEnvelopeRetreat.toFixed(2)} m`);
check(maximumDividerMidpointError <= 0.05,
  `exit divider leaves carriageway midpoint by ${maximumDividerMidpointError.toFixed(2)} m`);
check(maximumLaneCentreFractionError <= 0.02,
  `exit lane centres cross topology boundaries (${maximumLaneCentreFractionError.toFixed(3)})`);
check(markingOrderViolations === 0, `${markingOrderViolations} marking cross-sections are out of order`);
check(minimumOuterToDividerSeparation >= acceptedLaneWidth,
  `outer solid approaches branch divider to ${minimumOuterToDividerSeparation.toFixed(2)} m`);
check(maximumOuterBoundaryOffsetError <= 0.03,
  `outer solid leaves authoritative outer edge by ${maximumOuterBoundaryOffsetError.toFixed(2)} m`);
endpointBoundaryGaps.forEach((gap, index) => check(gap <= 0.15,
  `boundary ${index} misses real branch geometry by ${gap.toFixed(2)} m`));
endpointMarkingGaps.forEach((gap, index) => check(gap <= 0.15,
  `marking ${index} misses real branch target by ${gap.toFixed(2)} m`));
check(pavementHoleSamples === 0, `${pavementHoleSamples} exit-lane pavement holes`);
check(collisionHits === 0, `${collisionHits} exit-lane collision hits`);
check(markingPavementHoles.length === 0,
  `${markingPavementHoles.length} transition marking samples leave paved union`);
check(continuingBranchPavementHoles === 0,
  `${continuingBranchPavementHoles} continuing branch pavement holes`);
check(continuingBranchWallHits === 0, `${continuingBranchWallHits} continuing branch wall hits`);
check(intrusiveRails.length === 0, `${intrusiveRails.length} emitted rail vertices enter exit lanes`);
check(intrusiveWalls.length === 0, `${intrusiveWalls.length} collision wall spans enter exit lanes`);
check(maximumHostRailEnvelopeError <= 0.03,
  `host rail departs progressive paved envelope by ${maximumHostRailEnvelopeError.toFixed(3)} m`);
check(maximumBranchRailEnvelopeError <= 0.03,
  `branch rail departs branch paved exterior by ${maximumBranchRailEnvelopeError.toFixed(3)} m`);
check(railHandoffGap <= 2, `guardrail handoff gap is ${railHandoffGap.toFixed(2)} m`);
check(prematureGoreRails.length === 0, `${prematureGoreRails.length} gore rails precede ownership transfer`);
Object.entries(paint).forEach(([role, pieces]) => check(pieces.length > 0, `missing ${role} paint`));
check(maximumEmittedMarkingDeviation <= 0.55,
  `emitted paint leaves topology path by ${maximumEmittedMarkingDeviation.toFixed(2)} m`);
check(markingGaps.outerToRoute <= 2,
  `transition/route outer-solid handoff gap ${markingGaps.outerToRoute.toFixed(2)} m`);
check(markingGaps.innerDashToGore <= 6.5,
  `inner dash/gore gap ${markingGaps.innerDashToGore.toFixed(2)} m`);
check(markingGaps.dividerToRoute <= 9.3,
  `exit-divider/route handoff gap ${markingGaps.dividerToRoute.toFixed(2)} m`);
check(markingGaps.goreToRoute <= 2,
  `gore/route solid handoff gap ${markingGaps.goreToRoute.toFixed(2)} m`);
check(retainedRoutePaint.length === 0,
  `${retainedRoutePaint.length} route-local marking pieces survive transition ownership`);

const metrics = {
  junctionId: ID,
  topology: transition.topology,
  lanes: laneMetrics.map((metric) => ({
    lane: `aux:${metric.lane}`,
    target: `branch:${metric.targetLane}`,
    minimumWidth: round(metric.minimumWidth),
    maximumWidth: round(metric.maximumWidth),
    minimumConsecutiveOverlap: round(metric.minimumConsecutiveOverlap),
    maximumTangentStepDeg: round(metric.maximumTangentStep),
    endpointCentreGap: round(metric.endpointCentreGap),
  })),
  envelope: {
    targetExtraWidth: round(transition.targetExtraWidth),
    minimumCombinedWidth: round(Math.min(...combinedCorridor.map((section) => section.width))),
    maximumRetreat: round(maximumEnvelopeRetreat),
    handoffHostS: round(transition.exteriorHandoffStart),
    handoffBranchS: round(transition.exteriorHandoffBranchStart),
  },
  topologyContinuity: {
    maximumDividerMidpointError: round(maximumDividerMidpointError),
    maximumLaneCentreFractionError: round(maximumLaneCentreFractionError),
    markingOrderViolations,
    minimumOuterToDividerSeparation: round(minimumOuterToDividerSeparation),
    endpointBoundaryGaps: endpointBoundaryGaps.map(round),
    endpointMarkingGaps: endpointMarkingGaps.map(round),
  },
  pavementCollision: {
    pavementHoleSamples,
    collisionHits,
    markingPavementHoles: markingPavementHoles.length,
    continuingBranchPavementHoles,
    continuingBranchWallHits,
  },
  guardrails: {
    hostSamples: hostRailSamples.length,
    branchSamples: branchRailSamples.length,
    intrusiveRails: intrusiveRails.length,
    intrusiveWalls: intrusiveWalls.length,
    maximumHostEnvelopeError: round(maximumHostRailEnvelopeError),
    maximumBranchEnvelopeError: round(maximumBranchRailEnvelopeError),
    handoffGap: round(railHandoffGap),
  },
  markings: {
    pieces: Object.fromEntries(Object.entries(paint).map(([role, pieces]) => [role, pieces.length])),
    maximumEmittedPathDeviation: round(maximumEmittedMarkingDeviation),
    maximumOuterBoundaryOffsetError: round(maximumOuterBoundaryOffsetError),
    gaps: Object.fromEntries(Object.entries(markingGaps).map(([key, value]) => [key, round(value)])),
    retainedRoutePaint: retainedRoutePaint.length,
  },
  failures,
};
const report = {
  expectedInvariant: 'P4 remains a 2+2 section until aux:0/aux:1 become real r1_0 lane 0/lane 1',
  metrics,
};
if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(metrics, null, 2));
if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${ID}: ${failure}`));
  console.error(`P4 DIVERGE CONTINUITY PROBE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('P4 DIVERGE CONTINUITY PROBE: PASS');
}
