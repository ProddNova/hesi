import { HighwayMap } from '../js/map.js';

const P2_ID = 'J48:merge:wangan_1:ramp_41:end';
const map = new HighwayMap(null, { addLighting: false, legacyFlow: true });
const transition = map.progressiveTransitionById.get(P2_ID);
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const distance = (left, right) => Math.hypot(
  left.x - right.x,
  left.y - right.y,
  left.z - right.z,
);
const samplePath = (path, hostS) => {
  let upper = 1;
  while (upper < path.points.length && path.points[upper].hostS < hostS) upper += 1;
  if (upper >= path.points.length) return path.points.at(-1);
  const left = path.points[upper - 1];
  const right = path.points[upper];
  const factor = (hostS - left.hostS) / Math.max(1e-6, right.hostS - left.hostS);
  return {
    hostS,
    lateral: left.lateral + (right.lateral - left.lateral) * factor,
    position: {
      x: left.position.x + (right.position.x - left.position.x) * factor,
      y: left.position.y + (right.position.y - left.position.y) * factor,
      z: left.position.z + (right.position.z - left.position.z) * factor,
    },
  };
};

check(transition, `${P2_ID}: missing transition`);
if (transition) {
  const zone = transition.sourceZone;
  const laneWidth = zone.host.laneWidth;
  const hostLaneEdge = zone.host.lanes * laneWidth * 0.5;
  const temporaryPairCentre = hostLaneEdge + laneWidth;
  const rawBranchCentreLateral = zone.branch.lanes % 2
    ? 0
    : (map._laneOffset(zone.branch, 0, 1)
      + map._laneOffset(zone.branch, zone.branch.lanes - 1, 1)) * 0.5;
  const rawOutwardAt = (row, lateral) => {
    const point = row.frame.position.clone().addScaledVector(row.frame.normal, lateral);
    const projection = map._projectToRoute(zone.host, point, map._hostSeedIndex(zone.host, row.hS));
    return transition.sideSign * projection.signedLateral;
  };
  const rows = [...zone.samples].sort((left, right) => left.hU - right.hU);
  const crossingAtOrBelow = (valueAt, target) => {
    for (let index = 1; index < rows.length; index += 1) {
      const left = rows[index - 1];
      const right = rows[index];
      const leftValue = valueAt(left);
      const rightValue = valueAt(right);
      if (leftValue < target || rightValue > target) continue;
      const factor = (leftValue - target) / Math.max(1e-6, leftValue - rightValue);
      return left.hU + (right.hU - left.hU) * factor;
    }
    return null;
  };
  // The physical opening is where the ramp's hostward paved edge first
  // reaches the true exterior lane boundary of the unchanged three-lane host.
  // Full-five ownership begins later, where the raw ramp pair midpoint reaches
  // the midpoint of the two appended normal-width slots.
  const trueOpening = crossingAtOrBelow(
    (row) => rawOutwardAt(row, zone.hostwardSign * row.half),
    hostLaneEdge,
  );
  const trueHandoffComplete = crossingAtOrBelow(
    (row) => rawOutwardAt(row, rawBranchCentreLateral),
    temporaryPairCentre,
  );
  const fiveLaneStart = transition.fiveLaneStart ?? transition.parallelStart;
  const fiveLaneEnd = transition.fiveLaneEnd ?? transition.absorptionStart;
  const hostPaths = transition.laneCentres.filter((path) => path.id.startsWith('host:'));
  const rampPaths = transition.laneCentres.filter((path) => path.id.startsWith('aux:'));
  const boundaryPaths = ['aux-inner-boundary', 'aux-divider-boundary', 'aux-outer-boundary']
    .map((id) => transition.laneBoundaries.find((path) => path.id === id));

  check(trueOpening !== null, `${P2_ID}: no geometric ramp-pavement/host-edge opening found`);
  check(trueHandoffComplete !== null, `${P2_ID}: no geometric ramp-centre/temporary-slot handoff found`);
  check(Math.abs((transition.mergeOpeningStart ?? transition.openingStart) - trueOpening) <= 0.02,
    `${P2_ID}: OPENING is not the real three-lane-host exterior handoff`);
  check(Math.abs((transition.mergeHandoffComplete ?? fiveLaneStart) - trueHandoffComplete) <= 0.02,
    `${P2_ID}: full-five start is not where the ramp reaches its two appended slots`);
  check(fiveLaneStart >= trueHandoffComplete - 0.02,
    `${P2_ID}: temporary five-lane ownership begins before the real handoff`);
  check(transition.absorptionStart > trueHandoffComplete + 0.02,
    `${P2_ID}: ramp absorption begins before the branch reaches wangan_1`);
  check(fiveLaneEnd > fiveLaneStart + transition.auxiliaryWidth,
    `${P2_ID}: no measurable full-width five-lane section precedes absorption`);
  check(rampPaths.length === 2, `${P2_ID}: expected two ramp-origin centre paths`);
  check(hostPaths.length === 3, `${P2_ID}: expected three unchanged host centre paths`);
  check(boundaryPaths.every(Boolean), `${P2_ID}: expected three ramp-origin boundary paths`);

  const expectedHostLaterals = Array.from(
    { length: zone.host.lanes },
    (_, lane) => map._laneOffset(zone.host, lane, 1),
  );
  for (const path of hostPaths) {
    const lane = Number(path.id.split(':')[1]);
    for (const point of path.points) {
      check(Math.abs(point.lateral - expectedHostLaterals[lane]) <= 1e-6,
        `${P2_ID}: ${path.id} moved or narrowed at ${point.hostS.toFixed(2)}`);
    }
  }

  const approachPairPoint = rows[0].frame.position.clone()
    .addScaledVector(rows[0].frame.normal, rawBranchCentreLateral);
  const approachProjection = map._projectToRoute(zone.host, approachPairPoint);
  check(Math.sign(approachProjection.signedLateral) === transition.sideSign,
    `${P2_ID}: declared merge side does not match the ramp approach geometry`);

  const preOpeningStations = transition.pavedEnvelope
    .map((row) => row.hostS)
    .filter((hostS) => hostS < trueOpening - 0.01 && hostS >= trueOpening - 45);
  for (const hostS of preOpeningStations) {
    const branchS = transition.branchAtHost(hostS);
    const branchFrame = map._frameAt(zone.branch, branchS);
    const branchEdge = map._deckPoint(
      branchFrame,
      zone.hostwardSign * map._halfWidthAt(zone.branch, branchS),
    );
    const projection = map._projectToRoute(zone.host, branchEdge, map._hostSeedIndex(zone.host, hostS));
    const outward = transition.sideSign * projection.signedLateral;
    check(outward >= hostLaneEdge - 0.03,
      `${P2_ID}: ramp pavement overlaps a host lane before OPENING at ${hostS.toFixed(2)} (${outward.toFixed(3)} < ${hostLaneEdge.toFixed(3)})`);
  }

  if (rampPaths.length === 2) {
    const preHandoffStations = transition.pavedEnvelope
      .map((row) => row.hostS)
      .filter((hostS) => hostS >= trueOpening - 0.01 && hostS <= trueHandoffComplete + 0.01);
    const widths = preHandoffStations.map((hostS) => distance(
      samplePath(rampPaths[0], hostS).position,
      samplePath(rampPaths[1], hostS).position,
    ));
    const minimumWidth = Math.min(...widths);
    check(minimumWidth >= transition.auxiliaryWidth - 0.03,
      `${P2_ID}: ramp lane-centre spacing collapses before handoff (${minimumWidth.toFixed(3)} m)`);

    const fullTargets = rampPaths.map((path) => samplePath(path, fiveLaneStart));
    const expectedLaterals = [0, 1].map((lane) => transition.sideSign * (
      transition.hostLaneCount * laneWidth * 0.5
      + transition.auxiliaryWidth * (lane + 0.5)
    ));
    fullTargets.forEach((sample, lane) => check(
      Math.abs(sample.lateral - expectedLaterals[lane]) <= 0.03,
      `${P2_ID}: ramp centre aux:${lane} does not reach its temporary five-lane centre`,
    ));
    const allFiveOffsets = [
      ...hostPaths.map((path) => samplePath(path, fiveLaneStart).lateral),
      ...fullTargets.map((sample) => sample.lateral),
    ];
    const orderedOffsets = [...allFiveOffsets].sort((left, right) => (
      transition.sideSign > 0 ? right - left : left - right
    ));
    for (let index = 1; index < orderedOffsets.length; index += 1) {
      check(Math.abs(Math.abs(orderedOffsets[index - 1] - orderedOffsets[index]) - laneWidth) <= 0.03,
        `${P2_ID}: temporary slots ${index - 1}/${index} are not one normal lane width apart`);
    }
    check(Math.abs(transition.envelopeAt(fiveLaneStart).extra - 2 * laneWidth) <= 1e-6,
      `${P2_ID}: full-five envelope is not exactly two lane widths wider`);
    const fullFiveStations = transition.pavedEnvelope
      .map((row) => row.hostS)
      .filter((hostS) => hostS >= fiveLaneStart - 0.01 && hostS <= fiveLaneEnd + 0.01);
    for (const hostS of fullFiveStations) {
      const ordered = [...hostPaths, ...rampPaths]
        .map((path) => samplePath(path, hostS).lateral)
        .sort((left, right) => (transition.sideSign > 0 ? right - left : left - right));
      for (let lane = 1; lane < ordered.length; lane += 1) {
        check(Math.abs(ordered[lane - 1] - ordered[lane]) >= laneWidth - 0.03,
          `${P2_ID}: temporary lane ${lane} pinches inside the full-five section at ${hostS.toFixed(2)}`);
      }
      check(Math.abs(transition.envelopeAt(hostS).extra - 2 * laneWidth) <= 1e-6,
        `${P2_ID}: full-five envelope narrows before first absorption at ${hostS.toFixed(2)}`);
    }
    for (const corridor of transition.auxiliaryLaneCorridors) {
      const fullFiveWidths = corridor
        .filter((section) => section.hostS >= fiveLaneStart - 0.01
          && section.hostS <= fiveLaneEnd + 0.01)
        .map((section) => section.width);
      check(Math.min(...fullFiveWidths) >= laneWidth - 0.03,
        `${P2_ID}: ${corridor[0]?.id || 'ramp lane'} loses usable width in the full-five section`);
    }
    const downstreamHostS = Math.min(fiveLaneEnd - 0.2, fiveLaneStart + 0.5);
    const downstreamBranchS = transition.branchAtHost(downstreamHostS);
    const downstreamBranchFrame = map._frameAt(zone.branch, downstreamBranchS);
    const clip = map._mouthClipAt(zone.branch, downstreamBranchFrame);
    check(clip?.skip && clip.progressive === transition.id,
      `${P2_ID}: source ramp pavement still renders after full-five ownership begins`);
    const downstreamAux = samplePath(rampPaths[0], downstreamHostS);
    const downstreamPoint = new downstreamBranchFrame.position.constructor(
      downstreamAux.position.x,
      downstreamAux.position.y + 0.05,
      downstreamAux.position.z,
    );
    const corridorIds = map._corridorsAt(downstreamPoint, 0.2).map(({ route }) => route.id);
    check(!corridorIds.includes(zone.branch.id),
      `${P2_ID}: source ramp collision deck survives after host ownership handoff`);
    console.log(`TEMPORARY LANE OFFSETS (${transition.side} merge): ${orderedOffsets.map((value) => value.toFixed(3)).join(', ')}`);
  }

  if (boundaryPaths.every(Boolean)) {
    const preOwnershipStations = transition.pavedEnvelope
      .map((row) => row.hostS)
      .filter((hostS) => hostS >= trueOpening - 0.01 && hostS <= fiveLaneStart + 0.01);
    for (const hostS of preOwnershipStations) {
      const samples = boundaryPaths.map((path) => samplePath(path, hostS));
      const innerWidth = distance(samples[0].position, samples[1].position);
      const outerWidth = distance(samples[1].position, samples[2].position);
      check(innerWidth >= transition.auxiliaryWidth - 0.03,
        `${P2_ID}: inner ramp boundary converges before five-lane ownership at ${hostS.toFixed(2)}`);
      check(outerWidth >= transition.auxiliaryWidth - 0.03,
        `${P2_ID}: outer ramp boundary converges before five-lane ownership at ${hostS.toFixed(2)}`);
    }
  }

  console.log(JSON.stringify({
    opening: trueOpening,
    handoffComplete: trueHandoffComplete,
    fiveLaneStart,
    fiveLaneEnd,
    firstAbsorptionStart: transition.absorptionStart,
    secondAbsorptionStart: transition.secondAbsorptionStart,
  }, null, 2));
}

if (failures.length) {
  failures.forEach((failure) => console.error(`FAIL ${failure}`));
  console.error(`PROGRESSIVE MERGE HANDOFF PROBE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log('PROGRESSIVE MERGE HANDOFF PROBE: PASS');
}
