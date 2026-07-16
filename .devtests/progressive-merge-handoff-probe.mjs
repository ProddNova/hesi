import { HighwayMap } from '../js/map.js';

const P2_ID = 'J48:merge:wangan_1:ramp_41:end';
const map = new HighwayMap(null, { addLighting: false });
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
  const trueOpening = Math.min(...zone.markingOpening.host);
  const terminalBranchS = zone.which === 'end'
    ? Math.max(...zone.samples.map((row) => row.bS))
    : Math.min(...zone.samples.map((row) => row.bS));
  const terminalRow = zone.samples.reduce((closest, row) => (
    Math.abs(row.bS - terminalBranchS) < Math.abs(closest.bS - terminalBranchS) ? row : closest
  ));
  const trueHandoffComplete = terminalRow.hU;
  const fiveLaneStart = transition.fiveLaneStart ?? transition.parallelStart;
  const fiveLaneEnd = transition.fiveLaneEnd ?? transition.absorptionStart;
  const rampPaths = transition.laneCentres.filter((path) => path.id.startsWith('aux:'));
  const boundaryPaths = ['aux-inner-boundary', 'aux-divider-boundary', 'aux-outer-boundary']
    .map((id) => transition.laneBoundaries.find((path) => path.id === id));

  check(Math.abs((transition.mergeOpeningStart ?? transition.openingStart) - trueOpening) <= 0.02,
    `${P2_ID}: OPENING is not the exact rendered crossable opening`);
  check(Math.abs((transition.mergeHandoffComplete ?? fiveLaneStart) - trueHandoffComplete) <= 0.02,
    `${P2_ID}: full-connection point is not the branch ownership terminal`);
  check(fiveLaneStart >= trueHandoffComplete - 0.02,
    `${P2_ID}: temporary five-lane ownership begins before the real handoff`);
  check(transition.absorptionStart > trueHandoffComplete + 0.02,
    `${P2_ID}: ramp absorption begins before the branch reaches wangan_1`);
  check(fiveLaneEnd > fiveLaneStart + transition.auxiliaryWidth,
    `${P2_ID}: no measurable full-width five-lane section precedes absorption`);
  check(rampPaths.length === 2, `${P2_ID}: expected two ramp-origin centre paths`);
  check(boundaryPaths.every(Boolean), `${P2_ID}: expected three ramp-origin boundary paths`);

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
      transition.hostLaneCount * transition.auxiliaryWidth * 0.5
      + transition.auxiliaryWidth * (lane + 0.5)
    ));
    fullTargets.forEach((sample, lane) => check(
      Math.abs(sample.lateral - expectedLaterals[lane]) <= 0.03,
      `${P2_ID}: ramp centre aux:${lane} does not reach its temporary five-lane centre`,
    ));
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
