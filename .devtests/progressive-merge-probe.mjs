/** Focused geometry/topology/paint/rail/physics gate for active prototypes. */
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
const P2_ID = 'J48:merge:wangan_1:ramp_41:end';

if (LEGACY && map.progressiveTransitions.length === 0) {
  console.log('PROGRESSIVE MERGE PROBE: PASS (legacy mode has no progressive transition records)');
} else {
  if (map.progressiveTransitions.length !== 2) fail('global', `record count ${map.progressiveTransitions.length}`);
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
    let previousAuthoritativeOuter = null;
    let previousSourceOuter = null;
    let worstSourceOuterStep = 0;
    let lastOpening = -Infinity;
    let lastAbsorption = Infinity;
    const sourceRows = [...transition.sourceZone.samples].sort((left, right) => left.hU - right.hU);
    const sourceOuterAt = (hostS) => {
      let upper = 1;
      while (upper < sourceRows.length && sourceRows[upper].hU < hostS) upper += 1;
      if (upper >= sourceRows.length) return sourceRows.at(-1).unionOuter;
      const left = sourceRows[upper - 1];
      const right = sourceRows[upper];
      const t = (hostS - left.hU) / Math.max(1e-6, right.hU - left.hU);
      return left.unionOuter + (right.unionOuter - left.unionOuter) * t;
    };
    for (let index = 0; index < transition.pavedEnvelope.length; index += 1) {
      const row = transition.pavedEnvelope[index];
      const authoritativeOuter = transition.type === 'diverge'
        ? Math.max(row.extraWidth + row.baseHalf, sourceOuterAt(row.hostS))
        : row.extraWidth;
      if (previousAuthoritativeOuter !== null) {
        worstWidthStep = Math.max(worstWidthStep, Math.abs(authoritativeOuter - previousAuthoritativeOuter));
      }
      if (transition.type === 'diverge') {
        const sourceOuter = sourceOuterAt(row.hostS);
        if (previousSourceOuter !== null) {
          worstSourceOuterStep = Math.max(worstSourceOuterStep, Math.abs(sourceOuter - previousSourceOuter));
        }
        previousSourceOuter = sourceOuter;
      }
      previousAuthoritativeOuter = authoritativeOuter;
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
    const allowedWidthStep = transition.type === 'diverge' ? Math.max(0.7, worstSourceOuterStep + 0.05) : 0.7;
    if (worstWidthStep > allowedWidthStep) {
      fail(id, `width step ${worstWidthStep.toFixed(2)} m (source ${worstSourceOuterStep.toFixed(2)} m)`);
    }
    const first = transition.pavedEnvelope[0];
    const last = transition.pavedEnvelope.at(-1);
    if (first.extraWidth > 0.002) fail(id, 'transition does not begin at stable host width');
    if (transition.type === 'diverge') {
      if (last.extraWidth < transition.auxiliaryTotalWidth) {
        fail(id, 'host envelope closes before branch ownership');
      }
    } else if (last.extraWidth > 0.002) fail(id, 'merge does not finalize at stable host width');

    // Lane topology and pavement/physics agreement.
    if (transition.temporaryLaneCount !== transition.hostLaneCount + transition.auxiliaryLaneCount) {
      fail(id, 'temporary lane count');
    }
    if (id === 'J2:diverge:c1_0:r1_0:start'
      && (transition.topology !== '2+2-diverge'
        || transition.temporaryLaneCount !== 4
        || transition.auxiliaryLaneCount !== 2)) {
      fail(id, 'P4 is not an explicit temporary 2+2 diverge');
    }
    if (id === P2_ID
      && (transition.topology !== '2+3-merge'
        || transition.temporaryLaneCount !== 5
        || transition.auxiliaryLaneCount !== 2
        || transition.finalLaneCount !== 3
        || transition.absorptionSteps.length !== 2)) {
      fail(id, 'P2 is not an explicit 5 -> 4 -> 3 merge');
    }
    const expectedFinalLanes = transition.type === 'diverge'
      ? transition.hostLaneCount + transition.branchLaneCount
      : transition.hostLaneCount;
    if (transition.finalLaneCount !== expectedFinalLanes) fail(id, 'final lane count');
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
    let worstHeightStation = null;
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
      if (row.hostS < (transition.laneHandoffStart ?? Infinity)
        && (aux.lateral < row.lateralMin + 0.3 || aux.lateral > row.lateralMax - 0.3)) {
        fail(id, `aux lane outside pavement at ${row.hostS.toFixed(1)}`);
      }
      const point = worldPoint(aux.position, 0.05);
      if (!map.isPointDrivable(point, 0.05)) fail(id, `aux lane has no drivable surface at ${row.hostS.toFixed(1)}`);
      const info = map.getRoadInfo(point, transition.hostRouteId);
      if (routeSequence.at(-1) !== (info?.routeId || 'none')) routeSequence.push(info?.routeId || 'none');
      const allowedRouteIds = transition.type === 'diverge'
        ? [transition.hostRouteId, transition.branchRouteId]
        : [transition.hostRouteId];
      if (!info || !allowedRouteIds.includes(info.routeId)) {
        fail(id, `route ownership ${info?.routeId || 'none'} at ${row.hostS.toFixed(1)}`);
      }
      if (info) {
        const heightError = Math.abs(info.height - aux.position.y + 0.035);
        if (heightError > worstHeightError) {
          worstHeightError = heightError;
          worstHeightStation = {
            hostS: row.hostS,
            routeId: info.routeId,
            roadHeight: info.height,
            pathHeight: aux.position.y - 0.035,
          };
        }
      }
      const collision = map.resolveWallCollision(point, 1.1);
      if (collision.hit) fail(id, `wall in auxiliary lane at ${row.hostS.toFixed(1)}`);
    }
    const expectedOwnership = transition.type === 'diverge'
      ? [transition.hostRouteId, transition.branchRouteId]
      : [transition.hostRouteId];
    if (routeSequence.join(',') !== expectedOwnership.join(',')) {
      fail(id, `route ownership sequence ${routeSequence.join(',')}`);
    }
    if (worstHeightError > 0.08) fail(id, `height switch ${worstHeightError.toFixed(3)} m at host ${worstHeightStation?.hostS.toFixed(1)} (${worstHeightStation?.routeId}; road ${worstHeightStation?.roadHeight.toFixed(3)}, path ${worstHeightStation?.pathHeight.toFixed(3)})`);

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
    const firstAbsorptionPieces = progressivePieces
      .filter((piece) => piece.tag === 'progressiveMergeDivider')
      .sort((left, right) => left.sFrom - right.sFrom);
    if (!outerPieces.length) fail(id, 'missing progressive exterior edge line');
    if (!dashPieces.length) fail(id, 'missing progressive auxiliary dashes');
    if (transition.type === 'diverge') {
      if (Math.abs(transition.auxInnerMarkingLateralAt(transition.openingStart)
        - transition.auxOuterMarkingLateralAt(transition.openingStart)) > 0.01) {
        fail(id, 'solid-to-dash lateral step');
      }
      const branchFrame = map._frameAt(transition.sourceZone.branch, transition.transferCompleteBranch);
      const feedLaneBoundary = map._deckPoint(
        branchFrame,
        map._laneOffset(transition.sourceZone.branch, transition.branchFeedLane, 1)
          + transition.sourceZone.hostwardSign * (
            transition.sourceZone.branch.laneWidth * 0.5
            + transition.auxiliaryMarkingShoulder
          ),
        0.055,
      );
      const innerMarkingEnd = transition.markingPaths
        .find((path) => path.id === 'aux-inner-marking')?.points.at(-1)?.position;
      if (!innerMarkingEnd || worldPoint(innerMarkingEnd).distanceTo(feedLaneBoundary) > 0.1) {
        fail(id, 'inner marking misses the real branch edge-line target');
      }
      const standardSettledEdge = transition.sourceZone.hostwardSign
        * (map._halfWidthAt(transition.sourceZone.branch, transition.markingSettleEnd) - 0.75);
      if (Math.abs(transition.settledBranchInnerMarkingLateralAt(transition.markingSettleEnd)
        - standardSettledEdge) > 0.01) {
        fail(id, 'dash-to-solid branch-edge settle step');
      }
      const branchDivider = map._deckPoint(branchFrame, 0, 0.055);
      const dividerMarkingEnd = transition.markingPaths
        .find((path) => path.id === 'aux-divider-marking')?.points.at(-1)?.position;
      if (!dividerMarkingEnd || worldPoint(dividerMarkingEnd).distanceTo(branchDivider) > 0.1) {
        fail(id, 'transition divider misses the real branch divider target');
      }
      const branchOuterEdge = map._deckPoint(
        branchFrame,
        -transition.sourceZone.hostwardSign * (branchFrame.half - 0.75),
        0.055,
      );
      const outerMarkingEnd = transition.markingPaths
        .find((path) => path.id === 'aux-outer-marking')?.points.at(-1)?.position;
      if (!outerMarkingEnd || worldPoint(outerMarkingEnd).distanceTo(branchOuterEdge) > 0.1) {
        fail(id, 'outer solid does not remain on the branch outer edge');
      }
    } else {
      if (Math.abs(transition.boundaryLateralAt(transition.openingStart)
        - transition.outerMarkingLateralAt(transition.openingStart)) > 0.01) fail(id, 'solid-to-dash lateral step');
      if (Math.abs(transition.boundaryLateralAt(transition.transitionEnd)
        - transition.outerMarkingLateralAt(transition.transitionEnd)) > 0.01) fail(id, 'dash-to-solid lateral step');
      if (transition.auxiliaryLaneCount > 1) {
        if (!firstAbsorptionPieces.length) fail(id, 'missing first absorption divider dashes');
        const firstDropEnd = transition.absorptionSteps[0]?.to;
        if (firstAbsorptionPieces.some((piece) => piece.sTo > firstDropEnd + 0.01)) {
          fail(id, 'first absorption divider survives into the four-lane section');
        }
        const stations = [
          transition.parallelStart,
          transition.absorptionStart,
          transition.secondAbsorptionStart,
        ];
        for (const station of stations) {
          const outer = transition.outerMarkingLateralAt(station) * transition.sideSign;
          const divider = transition.auxDividerLateralAt(station) * transition.sideSign;
          const inner = transition.boundaryLateralAt(station) * transition.sideSign;
          if (outer < divider + 0.5 || divider < inner + transition.auxiliaryWidth - 0.7) {
            fail(id, `crossed/pinched progressive markings at ${station.toFixed(1)}`);
          }
        }
      }
    }
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

    // Guardrail ownership follows the authoritative paved exterior. The host
    // owns it before the source-derived exterior handoff, then the branch
    // exterior owns it; the hostward/gore rail remains absent until the full
    // auxiliary corridor has transferred.
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
      const expectedMode = transition.hostRailModeAt(row.hostS);
      if (map._railZoneMode(transition.sourceZone.host, transition.sideSign, row.hostS) !== expectedMode) {
        fail(id, `host rail ownership mismatch at ${row.hostS.toFixed(1)}`);
      }
      const envelope = transition.envelopeAt(row.hostS);
      if (Math.abs(row.lateral - envelope.outerLateral) > 0.02) fail(id, 'guardrail lateral envelope step');
    }
    for (const row of transition.sourceZone.samples) {
      for (const side of [1, -1]) {
        const expectedMode = transition.branchRailModeAt?.(row.bS, side);
        if (expectedMode
          && map._railZoneMode(transition.sourceZone.branch, side, row.bS) !== expectedMode) {
          fail(id, `branch rail ownership mismatch at ${row.bS.toFixed(1)} side ${side}`);
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
