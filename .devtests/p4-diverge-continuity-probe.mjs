/**
 * P4 diverge hard acceptance gate.
 *
 * This probe intentionally does not infer success from a width animation or
 * from the auxiliary centre alone. It samples the complete transition-owned
 * corridor (inner boundary, centre and outer boundary), checks it against the
 * real branch feed lane, then tests the rendered collision/rail geometry that
 * could physically close the exit.
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
const corridor = transition.auxiliaryCorridor;
const aux = transition.laneCentres.find((lane) => lane.id === 'aux:0');
const innerBoundary = transition.laneBoundaries.find((path) => path.id === 'aux-inner-boundary');
const outerBoundary = transition.laneBoundaries.find((path) => path.id === 'aux-outer-boundary');
if (!corridor?.length || !aux || !innerBoundary || !outerBoundary) {
  throw new Error('P4 explicit auxiliary corridor topology is incomplete');
}

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const point = (value) => new THREE.Vector3(value.x, value.y, value.z);
const distanceXZ = (left, right) => Math.hypot(left.x - right.x, left.z - right.z);
const degrees = (radians) => radians * 180 / Math.PI;
const round = (value, digits = 3) => +value.toFixed(digits);
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
const nearestSection = (value) => corridor.reduce((best, section) => (
  distanceXZ(value, section.centre) < distanceXZ(value, best.centre) ? section : best
));

const acceptedLaneWidth = Math.min(zone.host.laneWidth, zone.branch.laneWidth) - 0.15;
const minimumCorridorWidth = Math.min(...corridor.map((section) => section.width));
const prematureClosure = corridor.find((section) => (
  section.hostS < transition.transferComplete - 1e-4 && section.width < acceptedLaneWidth
)) || null;

let minimumConsecutiveOverlap = Infinity;
let maximumCentreTangentStep = 0;
let previousDirection = null;
for (let index = 1; index < corridor.length; index += 1) {
  const previous = corridor[index - 1];
  const current = corridor[index];
  const centreDistance = distanceXZ(previous.centre, current.centre);
  minimumConsecutiveOverlap = Math.min(
    minimumConsecutiveOverlap,
    (previous.width + current.width) * 0.5 - centreDistance,
  );
  const direction = point(current.centre).sub(point(previous.centre)).normalize();
  if (previousDirection) {
    maximumCentreTangentStep = Math.max(
      maximumCentreTangentStep,
      degrees(Math.acos(clamp(previousDirection.dot(direction), -1, 1))),
    );
  }
  previousDirection = direction;
}

const pavedAfterOpening = transition.pavedEnvelope.filter((row) => (
  row.hostS >= transition.parallelStart - 1e-4
  && row.hostS <= transition.transferComplete + 1e-4
));
let maximumEnvelopeRetreat = 0;
for (let index = 1; index < pavedAfterOpening.length; index += 1) {
  maximumEnvelopeRetreat = Math.max(
    maximumEnvelopeRetreat,
    pavedAfterOpening[index - 1].extraWidth - pavedAfterOpening[index].extraWidth,
  );
}

const last = corridor.at(-1);
const branchFrame = map._frameAt(zone.branch, transition.transferCompleteBranch);
const feedCentreLateral = map._laneOffset(zone.branch, transition.branchFeedLane, 1);
const feedHalfWidth = zone.branch.laneWidth * 0.5;
const targetCentre = map._deckPoint(branchFrame, feedCentreLateral, 0.035);
const targetInner = map._deckPoint(
  branchFrame,
  feedCentreLateral + zone.hostwardSign * feedHalfWidth,
  0.04,
);
const targetOuter = map._deckPoint(
  branchFrame,
  feedCentreLateral - zone.hostwardSign * feedHalfWidth,
  0.04,
);
const endpointCentreGap = distanceXZ(last.centre, targetCentre);
const endpointInnerGap = distanceXZ(last.inner, targetInner);
const endpointOuterGap = distanceXZ(last.outer, targetOuter);
const branchOwnershipSections = corridor.filter((section) => section.ownership === 'branch');
const firstBranchOwnership = branchOwnershipSections[0] || null;
const finalCorridorDirection = point(last.centre).sub(point(corridor.at(-2).centre));
finalCorridorDirection.y = 0;
finalCorridorDirection.normalize();
const branchDirection = branchFrame.tangent.clone();
branchDirection.y = 0;
branchDirection.normalize();
const branchTangentHandoffDeg = degrees(Math.acos(clamp(
  finalCorridorDirection.dot(branchDirection),
  -1,
  1,
)));

let continuingBranchSamples = 0;
let continuingBranchPavementHoles = 0;
let continuingBranchWallHits = 0;
const continuationEnd = Math.min(zone.branch.length, transition.transferCompleteBranch + 48);
for (let branchS = transition.transferCompleteBranch; branchS <= continuationEnd; branchS += 2) {
  const frame = map._frameAt(zone.branch, branchS);
  const sample = map._deckPoint(frame, feedCentreLateral, 0.035);
  continuingBranchSamples += 1;
  if (!map.getRoadInfo(sample, zone.branch.id)?.drivable) continuingBranchPavementHoles += 1;
  if (map.resolveWallCollision(sample, 0.4).hit) continuingBranchWallHits += 1;
}

let maximumCentreMidpointError = 0;
for (const section of corridor) {
  const modelCentre = interpolatePath(aux, section.hostS);
  maximumCentreMidpointError = Math.max(
    maximumCentreMidpointError,
    distanceXZ(modelCentre, section.centre),
  );
}

let pavementHoleSamples = 0;
let collisionCorrectionSamples = 0;
let maximumCollisionCorrection = 0;
const interiorFractions = [0.12, 0.3, 0.5, 0.7, 0.88];
for (const section of corridor) {
  for (const fraction of interiorFractions) {
    const sample = point(section.inner).lerp(point(section.outer), fraction);
    const road = map.getRoadInfo(sample, zone.host.id);
    if (!road?.drivable) pavementHoleSamples += 1;
    const collision = map.resolveWallCollision(sample, 0.4);
    if (collision.hit) {
      collisionCorrectionSamples += 1;
      maximumCollisionCorrection = Math.max(
        maximumCollisionCorrection,
        collision.correctionDistance || 0,
      );
    }
  }
}

const emittedRails = [
  ...(zone.host._progressiveRailSamples || []),
  ...(zone.branch._progressiveRailSamples || []),
].filter((sample) => sample.transitionId === transition.id);
const intrusiveRails = emittedRails.filter((sample) => {
  const value = point(sample.actualBasePosition);
  const section = nearestSection(value);
  const proximity = pointToSegmentXZ(value, section.inner, section.outer);
  return proximity.t > 0.03 && proximity.t < 0.97 && proximity.distance < 0.45;
});

const transitionWalls = map.wallSegments.filter((segment) => (
  segment.progressiveTransitionId === transition.id));
const intrusiveWalls = transitionWalls.filter((segment) => {
  const start = point(segment.start);
  const end = point(segment.end);
  return [start, start.clone().lerp(end, 0.5), end].some((value) => {
    const section = nearestSection(value);
    const proximity = pointToSegmentXZ(value, section.inner, section.outer);
    return proximity.t > 0.03 && proximity.t < 0.97 && proximity.distance < 0.45;
  });
});

const progressivePaint = map._markingLog.filter((piece) => (
  piece.kind === 'strip' && piece.owner === `progressive:${transition.id}`));
const prematureGorePaint = progressivePaint.filter((piece) => (
  piece.tag === 'progressiveBranchGoreEdge'
  && piece.sFrom < transition.transferCompleteBranch - 0.01
));
const innerMarkingPath = transition.markingPaths.find((path) => path.id === 'aux-inner-marking');
const outerMarkingPath = transition.markingPaths.find((path) => path.id === 'aux-outer-marking');
const expectedHostMarkedWidth = zone.host.laneWidth
  + Math.max(0, (zone.host.shoulder || 0) - 0.75);
const expectedBranchMarkedWidth = zone.branch.laneWidth
  + Math.max(0, (zone.branch.shoulder || 0) - 0.75);
const expectedMarkedWidth = Math.min(expectedHostMarkedWidth, expectedBranchMarkedWidth);
const markingSections = innerMarkingPath.points.map((inner, index) => {
  const outer = outerMarkingPath.points[index];
  const innerLaneBoundary = innerBoundary.points[index];
  const outerLaneBoundary = outerBoundary.points[index];
  return {
    hostS: inner.hostS,
    width: distanceXZ(inner.position, outer.position),
    innerBoundaryOffset: distanceXZ(inner.position, innerLaneBoundary.position),
    outerBoundaryOffset: distanceXZ(outer.position, outerLaneBoundary.position),
  };
});
const usableMarkingSections = markingSections.filter((section) => (
  section.hostS >= transition.parallelStart - 1e-4
  && section.hostS <= transition.transferComplete + 1e-4
));
const minimumUsableMarkedWidth = Math.min(...usableMarkingSections.map((section) => section.width));
const maximumUsableMarkedWidthError = Math.max(...usableMarkingSections.map((section) => (
  Math.abs(section.width - expectedMarkedWidth)
)));
const maximumMarkingShoulderBudgetError = Math.max(...usableMarkingSections.map((section) => (
  Math.abs(
    section.innerBoundaryOffset + section.outerBoundaryOffset
    - transition.auxiliaryMarkingShoulder,
  )
)));
const preHandoffOuterMarkingSections = outerMarkingPath.points.filter((entry) => (
  entry.hostS <= transition.exteriorHandoffStart + 1e-4
));
const maximumOuterEnvelopeInsetError = Math.max(...preHandoffOuterMarkingSections.map((entry) => {
  const frame = map._frameAt(zone.host, map._normalizeDistance(zone.host, entry.hostS));
  const envelopeEdge = map._deckPoint(frame, transition.envelopeAt(entry.hostS).outerLateral, 0.04);
  return Math.abs(distanceXZ(entry.position, envelopeEdge) - 0.75);
}));
const targetInnerMarking = map._deckPoint(
  branchFrame,
  feedCentreLateral + zone.hostwardSign * (feedHalfWidth + transition.auxiliaryMarkingShoulder),
  0.055,
);
const targetOuterMarking = map._deckPoint(
  branchFrame,
  feedCentreLateral - zone.hostwardSign * feedHalfWidth,
  0.055,
);
const endpointInnerMarkingGap = distanceXZ(innerMarkingPath.points.at(-1).position, targetInnerMarking);
const endpointOuterMarkingGap = distanceXZ(outerMarkingPath.points.at(-1).position, targetOuterMarking);

const markingPathByTag = new Map([
  ['progressiveOuterEdge', outerMarkingPath],
  ['progressiveAuxBoundary', innerMarkingPath],
  ['progressiveBranchAuxBoundary', innerMarkingPath],
  ['progressiveBranchDivider', outerMarkingPath],
]);
const boundaryPaint = progressivePaint.filter((piece) => markingPathByTag.has(piece.tag));
let maximumEmittedMarkingBoundaryDeviation = 0;
for (const piece of boundaryPaint) {
  const path = markingPathByTag.get(piece.tag);
  maximumEmittedMarkingBoundaryDeviation = Math.max(
    maximumEmittedMarkingBoundaryDeviation,
    pointToPathXZ(piece.start, path),
    pointToPathXZ(piece.end, path),
  );
}
const paintByTag = (tag) => progressivePaint
  .filter((piece) => piece.tag === tag)
  .sort((left, right) => left.sFrom - right.sFrom);
const hostOuterPaint = paintByTag('progressiveOuterEdge');
const hostInnerPaint = paintByTag('progressiveAuxBoundary');
const branchInnerPaint = paintByTag('progressiveBranchAuxBoundary');
const branchDividerPaint = paintByTag('progressiveBranchDivider');
const branchGorePaint = paintByTag('progressiveBranchGoreEdge');
const routeBranchDividerPaint = map._markingLog
  .filter((piece) => (
    piece.kind === 'strip'
    && piece.routeId === zone.branch.id
    && piece.owner === `route:${zone.branch.id}`
    && piece.tag === 'laneDivider'
    && piece.sFrom >= transition.transferCompleteBranch - 0.01
  ))
  .sort((left, right) => left.sFrom - right.sFrom);
const routeBranchHostwardEdgePaint = map._markingLog
  .filter((piece) => (
    piece.kind === 'strip'
    && piece.routeId === zone.branch.id
    && piece.owner === `route:${zone.branch.id}`
    && piece.tag === 'edgeLine'
    && piece.boundary === `edge:${zone.hostwardSign}`
    && piece.sFrom >= transition.markingSettleEnd - 0.01
  ))
  .sort((left, right) => left.sFrom - right.sFrom);
const handoffGap = (from, to) => (
  from && to ? distanceXZ(from.end, to.start) : null
);
const outerSolidToDividerGap = handoffGap(hostOuterPaint.at(-1), branchDividerPaint[0]);
const innerDashRouteHandoffGap = handoffGap(hostInnerPaint.at(-1), branchInnerPaint[0]);
const innerDashToGoreGap = handoffGap(branchInnerPaint.at(-1), branchGorePaint[0]);
const dividerDashRouteHandoffGap = handoffGap(
  branchDividerPaint.at(-1),
  routeBranchDividerPaint[0],
);
const goreSolidRouteEdgeGap = handoffGap(
  branchGorePaint.at(-1),
  routeBranchHostwardEdgePaint[0],
);

const metrics = {
  junctionId: transition.id,
  side: transition.side,
  feed: {
    branchRouteId: transition.branchRouteId,
    branchLane: transition.branchFeedLane,
    centreLateral: round(feedCentreLateral),
    innerBoundaryLateral: round(feedCentreLateral + zone.hostwardSign * feedHalfWidth),
    outerBoundaryLateral: round(feedCentreLateral - zone.hostwardSign * feedHalfWidth),
  },
  phases: {
    usableHostS: round(transition.parallelStart),
    handoffHostS: round(transition.exteriorHandoffStart),
    transferCompleteHostS: round(transition.transferComplete),
    transferCompleteBranchS: round(transition.transferCompleteBranch),
    goreHostS: round(transition.goreStart),
    goreBranchS: round(transition.goreBranchStart),
  },
  corridor: {
    sections: corridor.length,
    acceptedLaneWidth: round(acceptedLaneWidth),
    minimumWidth: round(minimumCorridorWidth),
    prematureClosureHostS: prematureClosure ? round(prematureClosure.hostS) : null,
    minimumConsecutiveOverlap: round(minimumConsecutiveOverlap),
    maximumCentreTangentStepDeg: round(maximumCentreTangentStep),
    maximumCentreMidpointError: round(maximumCentreMidpointError),
    maximumPavedEnvelopeRetreat: round(maximumEnvelopeRetreat),
    endpointCentreGap: round(endpointCentreGap),
    endpointInnerGap: round(endpointInnerGap),
    endpointOuterGap: round(endpointOuterGap),
    branchTangentHandoffDeg: round(branchTangentHandoffDeg),
    firstBranchOwnershipHostS: firstBranchOwnership ? round(firstBranchOwnership.hostS) : null,
  },
  pavementCollision: {
    sampledInteriorPoints: corridor.length * interiorFractions.length,
    pavementHoleSamples,
    collisionCorrectionSamples,
    maximumCollisionCorrection: round(maximumCollisionCorrection),
    continuingBranchSamples,
    continuingBranchPavementHoles,
    continuingBranchWallHits,
  },
  guardrailCollision: {
    emittedRailSamples: emittedRails.length,
    intrusiveRailSamples: intrusiveRails.length,
    transitionWallSegments: transitionWalls.length,
    intrusiveWallSegments: intrusiveWalls.length,
  },
  markings: {
    prematureGorePieces: prematureGorePaint.length,
    hostOuterPieces: hostOuterPaint.length,
    hostInnerPieces: hostInnerPaint.length,
    branchInnerPieces: branchInnerPaint.length,
    branchDividerPieces: branchDividerPaint.length,
    branchGorePieces: branchGorePaint.length,
    expectedMarkedWidth: round(expectedMarkedWidth),
    modelMarkedWidth: round(transition.auxiliaryMarkedWidth),
    minimumUsableMarkedWidth: round(minimumUsableMarkedWidth),
    maximumUsableMarkedWidthError: round(maximumUsableMarkedWidthError),
    maximumMarkingShoulderBudgetError: round(maximumMarkingShoulderBudgetError),
    maximumOuterEnvelopeInsetError: round(maximumOuterEnvelopeInsetError),
    endpointInnerMarkingGap: round(endpointInnerMarkingGap),
    endpointOuterMarkingGap: round(endpointOuterMarkingGap),
    maximumEmittedBoundaryDeviation: round(maximumEmittedMarkingBoundaryDeviation),
    outerSolidToDividerGap: outerSolidToDividerGap === null ? null : round(outerSolidToDividerGap),
    innerDashRouteHandoffGap: innerDashRouteHandoffGap === null
      ? null : round(innerDashRouteHandoffGap),
    innerDashToGoreGap: innerDashToGoreGap === null ? null : round(innerDashToGoreGap),
    dividerDashRouteHandoffGap: dividerDashRouteHandoffGap === null
      ? null : round(dividerDashRouteHandoffGap),
    goreSolidRouteEdgeGap: goreSolidRouteEdgeGap === null ? null : round(goreSolidRouteEdgeGap),
  },
};

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
check(transition.side === 'left', `driver-relative side is ${transition.side}`);
check(minimumCorridorWidth >= acceptedLaneWidth,
  `corridor closes to ${minimumCorridorWidth.toFixed(2)} m (threshold ${acceptedLaneWidth.toFixed(2)} m)`);
check(!prematureClosure, `premature closure at host s=${prematureClosure?.hostS.toFixed(2)}`);
check(minimumConsecutiveOverlap > 0,
  `consecutive corridor sections leave ${Math.abs(minimumConsecutiveOverlap).toFixed(2)} m uncovered`);
check(maximumEnvelopeRetreat <= 0.01,
  `outer paved envelope retreats ${maximumEnvelopeRetreat.toFixed(2)} m before branch ownership`);
check(maximumCentreTangentStep <= 5,
  `auxiliary centre tangent step ${maximumCentreTangentStep.toFixed(2)} deg`);
check(maximumCentreMidpointError <= 0.05,
  `auxiliary centre departs its two boundaries by ${maximumCentreMidpointError.toFixed(2)} m`);
check(endpointCentreGap <= 0.15,
  `centre ends ${endpointCentreGap.toFixed(2)} m from real branch lane centre`);
check(endpointInnerGap <= 0.15,
  `inner boundary ends ${endpointInnerGap.toFixed(2)} m from real branch lane boundary`);
check(endpointOuterGap <= 0.15,
  `outer boundary ends ${endpointOuterGap.toFixed(2)} m from real branch lane boundary`);
check(branchTangentHandoffDeg <= 5,
  `auxiliary centre reaches branch with a ${branchTangentHandoffDeg.toFixed(2)} deg tangent step`);
check(branchOwnershipSections.length === 1
  && Math.abs(firstBranchOwnership.hostS - transition.transferComplete) <= 0.01,
`branch ownership starts before the complete final cross-section`);
check(transition.goreStart >= transition.transferComplete - 0.01
  && transition.goreBranchStart >= transition.transferCompleteBranch - 0.01,
`gore begins before corridor transfer completes`);
check(pavementHoleSamples === 0, `${pavementHoleSamples} corridor interior pavement holes`);
check(collisionCorrectionSamples === 0,
  `${collisionCorrectionSamples} corridor interior collision corrections`);
check(continuingBranchPavementHoles === 0,
  `${continuingBranchPavementHoles} pavement holes after branch ownership`);
check(continuingBranchWallHits === 0,
  `${continuingBranchWallHits} collision walls block the continuing feed lane`);
check(intrusiveRails.length === 0, `${intrusiveRails.length} emitted rail samples enter the corridor`);
check(intrusiveWalls.length === 0, `${intrusiveWalls.length} collision wall segments enter the corridor`);
check(prematureGorePaint.length === 0, `${prematureGorePaint.length} gore pieces precede transfer completion`);
check(Math.abs(transition.auxiliaryMarkedWidth - expectedMarkedWidth) <= 0.01,
  `marked width model is ${transition.auxiliaryMarkedWidth.toFixed(2)} m, expected ${expectedMarkedWidth.toFixed(2)} m`);
check(minimumUsableMarkedWidth >= expectedMarkedWidth - 0.05,
  `usable auxiliary markings pinch to ${minimumUsableMarkedWidth.toFixed(2)} m`);
check(maximumUsableMarkedWidthError <= 0.05,
  `auxiliary marked width varies by ${maximumUsableMarkedWidthError.toFixed(2)} m after becoming usable`);
check(maximumMarkingShoulderBudgetError <= 0.02,
  `marking shoulder transfer loses or gains ${maximumMarkingShoulderBudgetError.toFixed(2)} m`);
check(maximumOuterEnvelopeInsetError <= 0.02,
  `outer edge marking departs from the authoritative 0.75 m paved-edge inset by ${maximumOuterEnvelopeInsetError.toFixed(2)} m`);
check(endpointInnerMarkingGap <= 0.15,
  `inner marking ends ${endpointInnerMarkingGap.toFixed(2)} m from the real branch edge-line target`);
check(endpointOuterMarkingGap <= 0.15,
  `outer marking ends ${endpointOuterMarkingGap.toFixed(2)} m from the real branch-divider target`);
check(hostOuterPaint.length > 0 && hostInnerPaint.length > 0
  && branchInnerPaint.length > 0 && branchDividerPaint.length > 0
  && branchGorePaint.length > 0,
'transition-owned host/branch marking geometry was not emitted');
check(maximumEmittedMarkingBoundaryDeviation <= 0.5,
  `emitted marking departs the authoritative boundary path by ${maximumEmittedMarkingBoundaryDeviation.toFixed(2)} m`);
// Gaps are bounded by their actual dash pattern's off-length, with only a
// small surface-frame interpolation allowance. These are continuity checks,
// not values tuned to whatever the current renderer happens to emit.
check(outerSolidToDividerGap !== null && outerSolidToDividerGap <= 1.5,
  `solid-to-dashed outer handoff gap is ${outerSolidToDividerGap?.toFixed(2) ?? 'missing'} m`);
check(innerDashRouteHandoffGap !== null && innerDashRouteHandoffGap <= 6.25,
  `host-to-branch inner dash gap is ${innerDashRouteHandoffGap?.toFixed(2) ?? 'missing'} m`);
check(innerDashToGoreGap !== null && innerDashToGoreGap <= 6.25,
  `dashed-to-solid gore handoff gap is ${innerDashToGoreGap?.toFixed(2) ?? 'missing'} m`);
check(dividerDashRouteHandoffGap !== null && dividerDashRouteHandoffGap <= 9.05,
  `transition-to-route divider gap is ${dividerDashRouteHandoffGap?.toFixed(2) ?? 'missing'} m`);
check(goreSolidRouteEdgeGap !== null && goreSolidRouteEdgeGap <= 2,
  `gore-to-route solid handoff gap is ${goreSolidRouteEdgeGap?.toFixed(2) ?? 'missing'} m`);

const report = {
  expectedInvariant: 'once usable, P4 corridor remains positive and transfers into real r1_0 lane 0',
  metrics,
  failures,
};
if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(metrics, null, 2));
if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${transition.id}: ${failure}`));
  console.error(`P4 DIVERGE CONTINUITY PROBE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('P4 DIVERGE CONTINUITY PROBE: PASS');
}
