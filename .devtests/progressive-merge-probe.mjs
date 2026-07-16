/** Focused geometry/topology/paint/rail/physics gate for the four prototypes. */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const LEGACY = process.argv.includes('--legacy');
const map = new HighwayMap(null, { addLighting: false, markingDebug: true, progressiveMerges: !LEGACY });
const failures = [];
const fail = (id, message) => failures.push(`${id}: ${message}`);
const radiansToDegrees = (value) => value * 180 / Math.PI;
const direction = (left, right) => new THREE.Vector3(
  right.x - left.x,
  right.y - left.y,
  right.z - left.z,
).normalize();
const worldPoint = (point, lift = 0) => new THREE.Vector3(point.x, point.y + lift, point.z);
const intersects = (from, to, interval) => to >= interval[0] - 0.01 && from <= interval[1] + 0.01;

if (LEGACY && map.progressiveTransitions.length === 0) {
  console.error('PROGRESSIVE MERGE PROBE: FAIL (legacy has no progressive transition records)');
  process.exitCode = 1;
} else {
  if (map.progressiveTransitions.length !== 4) fail('global', `record count ${map.progressiveTransitions.length}`);
  for (const transition of map.progressiveTransitions) {
    const id = transition.id;
    const phaseValues = [
      transition.approachStart,
      transition.openingStart,
      transition.parallelStart,
      transition.absorptionStart,
      transition.transitionEnd,
    ];
    if (!phaseValues.every((value, index) => index === 0 || value > phaseValues[index - 1])) fail(id, 'phase order');
    if (transition.length < 100) fail(id, `transition length ${transition.length.toFixed(1)} m`);

    // Geometry: position/tangent/width continuity and monotonic quintic phases.
    let worstLaneStep = 0;
    let worstTangentDelta = 0;
    for (const lane of transition.laneCentres) {
      let previousDirection = null;
      for (let index = 1; index < lane.points.length; index += 1) {
        const a = lane.points[index - 1];
        const b = lane.points[index];
        const step = worldPoint(a.position).distanceTo(worldPoint(b.position));
        worstLaneStep = Math.max(worstLaneStep, step);
        const heading = direction(a.position, b.position);
        if (previousDirection) {
          worstTangentDelta = Math.max(
            worstTangentDelta,
            radiansToDegrees(Math.acos(THREE.MathUtils.clamp(previousDirection.dot(heading), -1, 1))),
          );
        }
        previousDirection = heading;
      }
    }
    if (worstLaneStep > 3.2) fail(id, `position discontinuity ${worstLaneStep.toFixed(2)} m`);
    if (worstTangentDelta > 4.5) fail(id, `tangent discontinuity ${worstTangentDelta.toFixed(2)} deg`);

    let worstWidthStep = 0;
    let lastOpening = -Infinity;
    let lastAbsorption = Infinity;
    for (let index = 0; index < transition.pavedEnvelope.length; index += 1) {
      const row = transition.pavedEnvelope[index];
      if (index) worstWidthStep = Math.max(
        worstWidthStep,
        Math.abs(row.extraWidth - transition.pavedEnvelope[index - 1].extraWidth),
      );
      if (row.hostS >= transition.openingStart - 0.01 && row.hostS <= transition.parallelStart + 0.01) {
        if (row.extraWidth + 0.002 < lastOpening) fail(id, 'non-monotonic opening width');
        lastOpening = row.extraWidth;
      }
      if (row.hostS >= transition.absorptionStart - 0.01 && row.hostS <= transition.transitionEnd + 0.01) {
        if (row.extraWidth - 0.002 > lastAbsorption) fail(id, 'non-monotonic absorption width');
        lastAbsorption = row.extraWidth;
      }
      if (!(row.lateralMin < row.lateralMax)) fail(id, `inverted pavement at ${row.hostS.toFixed(1)}`);
    }
    if (worstWidthStep > 0.7) fail(id, `width step ${worstWidthStep.toFixed(2)} m`);
    const first = transition.pavedEnvelope[0];
    const last = transition.pavedEnvelope.at(-1);
    if (first.extraWidth > 0.002 || last.extraWidth > 0.002) fail(id, 'final width does not match stable host');

    // Lane topology and pavement/physics agreement.
    if (transition.temporaryLaneCount !== transition.hostLaneCount + 1) fail(id, 'temporary lane count');
    if (transition.finalLaneCount !== transition.hostLaneCount) fail(id, 'final lane count');
    if (!transition.laneMappings.some((mapping) => mapping.outcome.includes('absorbed')
      || mapping.outcome.includes('separates') || mapping.outcome.includes('opens'))) fail(id, 'no explicit absorbed/separated mapping');
    const ownershipIds = new Set();
    for (const boundary of transition.markingOwnership) {
      if (!boundary.owner) fail(id, `ownerless boundary ${boundary.id}`);
      if (ownershipIds.has(boundary.id)) fail(id, `duplicate boundary ${boundary.id}`);
      ownershipIds.add(boundary.id);
    }

    const sampleStride = Math.max(1, Math.floor(transition.pavedEnvelope.length / 24));
    const routeSequence = [];
    let worstHeightError = 0;
    for (let index = 0; index < transition.pavedEnvelope.length; index += sampleStride) {
      const row = transition.pavedEnvelope[index];
      const frame = map._frameAt(transition.sourceZone.host, map._normalizeDistance(transition.sourceZone.host, row.hostS));
      for (const fraction of [0.08, 0.28, 0.5, 0.72, 0.92]) {
        const lateral = row.lateralMin + (row.lateralMax - row.lateralMin) * fraction;
        const point = map._deckPoint(frame, lateral, 0.05);
        if (!map.isPointDrivable(point, 0.05)) fail(id, `pavement hole at ${row.hostS.toFixed(1)} / ${fraction}`);
      }
      if (row.hostS < transition.openingStart || row.hostS > transition.transitionEnd) continue;
      const aux = transition.laneCentres.at(-1).points[index];
      if (!aux) continue;
      if (aux.lateral < row.lateralMin + 0.3 || aux.lateral > row.lateralMax - 0.3) {
        fail(id, `aux lane outside pavement at ${row.hostS.toFixed(1)}`);
      }
      const point = worldPoint(aux.position, 0.05);
      const info = map.getRoadInfo(point, transition.hostRouteId);
      routeSequence.push(info?.routeId || 'none');
      if (!info || info.routeId !== transition.hostRouteId) fail(id, `route ownership ${info?.routeId || 'none'} at ${row.hostS.toFixed(1)}`);
      if (info) worstHeightError = Math.max(worstHeightError, Math.abs(info.height - aux.position.y + 0.035));
      const collision = map.resolveWallCollision(point, 1.1);
      if (collision.hit) fail(id, `wall in auxiliary lane at ${row.hostS.toFixed(1)}`);
    }
    if (new Set(routeSequence).size > 1) fail(id, `route ownership oscillation ${[...new Set(routeSequence)].join(',')}`);
    if (worstHeightError > 0.08) fail(id, `height switch ${worstHeightError.toFixed(3)} m`);

    // Branch surface must hand its covered progressive section to the host.
    let progressiveHandOffs = 0;
    for (const row of transition.sourceZone.samples) {
      const phase = transition.phaseAtBranch(row.bS);
      if (!phase || phase === 'approach') continue;
      const frame = map._frameAt(transition.sourceZone.branch, row.bS);
      for (const lateral of [-frame.half * 0.5, 0, frame.half * 0.5]) {
        if (map._surfaceDefersToHost(transition.sourceZone.branch, row.bS, lateral)) progressiveHandOffs += 1;
      }
    }
    if (!progressiveHandOffs) fail(id, 'no branch-to-host surface hand-off');

    // Drive every source-lane centre through the full progressive interval.
    // This catches a collision hand-off that is geometrically inside the
    // surface union but still too close to the current host-envelope edge for
    // a vehicle footprint.
    let driveSamples = 0;
    const branchRoute = transition.sourceZone.branch;
    for (let lane = 0; lane < branchRoute.lanes; lane += 1) {
      let laneFailed = false;
      for (let distance = transition.branchInterval[0]; distance <= transition.branchInterval[1]; distance += 2) {
        driveSamples += 1;
        const sample = map.sampleLane(branchRoute.id, distance, lane, 1);
        const point = sample.position.clone();
        point.y = sample.center.y + 0.4;
        if (map.resolveWallCollision(point, 1).hit) {
          fail(id, `source lane ${lane} wall at ${distance.toFixed(1)}`);
          laneFailed = true;
          break;
        }
      }
      if (laneFailed) continue;
    }

    // Markings: one transition owner, no route-local branch paint in the
    // claimed interval, exact solid/dash path alignment and intentional dash gaps only.
    const progressivePieces = map._markingLog.filter((piece) => piece.kind === 'strip'
      && piece.owner === `progressive:${id}`);
    const outerPieces = progressivePieces.filter((piece) => piece.tag === 'progressiveOuterEdge');
    const dashPieces = progressivePieces.filter((piece) => piece.tag === 'progressiveAuxBoundary')
      .sort((left, right) => left.sFrom - right.sFrom);
    if (!outerPieces.length) fail(id, 'missing progressive exterior edge line');
    if (!dashPieces.length) fail(id, 'missing progressive auxiliary dashes');
    if (Math.abs(transition.boundaryLateralAt(transition.openingStart)
      - transition.outerMarkingLateralAt(transition.openingStart)) > 0.01) fail(id, 'solid-to-dash lateral step');
    if (Math.abs(transition.boundaryLateralAt(transition.transitionEnd)
      - transition.outerMarkingLateralAt(transition.transitionEnd)) > 0.01) fail(id, 'dash-to-solid lateral step');
    for (let index = 1; index < dashPieces.length; index += 1) {
      const gap = dashPieces[index].sFrom - dashPieces[index - 1].sTo;
      if (gap > 6.2) fail(id, `unexplained dash gap ${gap.toFixed(2)} m`);
    }
    const branchRoutePaint = map._markingLog.filter((piece) => piece.kind === 'strip'
      && piece.routeId === transition.branchRouteId && piece.classification === 'route-local');
    for (const piece of branchRoutePaint) {
      const middle = (piece.sFrom + piece.sTo) * 0.5;
      const phase = transition.phaseAtBranch(middle);
      const claimed = transition.type === 'merge' ? phase && phase !== 'approach' : !!phase;
      if (claimed) fail(id, `branch route paint survives ${phase} at ${middle.toFixed(1)}`);
    }

    // Guardrail: host rail follows the true progressive exterior; branch rail
    // is suppressed while combined, and no coincident double rail survives.
    const emittedRailSamples = (transition.sourceZone.host._progressiveRailSamples || [])
      .filter((sample) => sample.transitionId === id && sample.side === transition.sideSign);
    if (!emittedRailSamples.length) fail(id, 'missing emitted progressive rail geometry samples');
    let visiblyRelocated = false;
    for (const sample of emittedRailSamples) {
      const envelope = transition.envelopeAt(sample.distance);
      const squeeze = 0.36 * (1 - sample.terminalFactor);
      const expectedBase = envelope.outerLateral - transition.sideSign * (0.42 - squeeze);
      if (Math.abs(sample.actualOuterLateral - envelope.outerLateral) > 0.03
        || Math.abs(sample.actualBaseLateral - expectedBase) > 0.03) {
        fail(id, `emitted rail is interior at ${sample.distance.toFixed(1)}`);
        break;
      }
      const exteriorAdvance = transition.sideSign * sample.actualOuterLateral - envelope.baseHalf;
      if (exteriorAdvance > transition.auxiliaryWidth * 0.75) visiblyRelocated = true;
    }
    if (!visiblyRelocated) fail(id, 'progressive rail never relocates beyond the stable host edge');
    for (let index = 0; index < transition.guardrailEnvelope.length; index += sampleStride) {
      const row = transition.guardrailEnvelope[index];
      if (map._railZoneMode(transition.sourceZone.host, transition.sideSign, row.hostS) !== 'on') {
        fail(id, `outer guardrail absent at ${row.hostS.toFixed(1)}`);
      }
      const envelope = transition.envelopeAt(row.hostS);
      if (Math.abs(row.lateral - envelope.outerLateral) > 0.02) fail(id, 'guardrail lateral envelope step');
    }
    for (const row of transition.sourceZone.samples) {
      const phase = transition.phaseAtBranch(row.bS);
      if (!phase) continue;
      const shouldBeOpen = transition.type === 'merge'
        ? phase !== 'approach'
        : (phase === 'approach' || phase === 'opening' || phase === 'parallel');
      if (!shouldBeOpen) continue;
      for (const side of [1, -1]) {
        if (map._railZoneMode(transition.sourceZone.branch, side, row.bS) !== 'off') {
          fail(id, `branch rail crosses ${phase} at ${row.bS.toFixed(1)}`);
        }
      }
    }

    console.log(`${id} PASS-CANDIDATE length=${transition.length.toFixed(1)}m laneStep=${worstLaneStep.toFixed(2)}m tangent=${worstTangentDelta.toFixed(2)}deg widthStep=${worstWidthStep.toFixed(2)}m height=${worstHeightError.toFixed(3)}m handoffs=${progressiveHandOffs} drive=${driveSamples}`);
  }

  if (failures.length) {
    for (const message of failures) console.error(`FAIL ${message}`);
    console.error(`PROGRESSIVE MERGE PROBE: FAIL (${failures.length})`);
    process.exitCode = 1;
  } else {
    console.log('PROGRESSIVE MERGE PROBE: PASS');
  }
}
