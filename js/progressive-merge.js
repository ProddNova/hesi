/**
 * Shared progressive same-level transition model.
 *
 * This module owns phase order, paved/crossable envelopes, temporary lane
 * topology, marking ownership and the guardrail envelope. Rendering, physics,
 * developer diagnostics and probes consume the records; none re-derive phase
 * boundaries independently.
 */

import { classifyProgressiveJunction } from './progressive-junction-classifier.js?v=48d2ded68c0c';

export const PROGRESSIVE_PHASES = Object.freeze([
  'approach',
  'opening',
  'parallel',
  'absorption',
  'finalized',
]);

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const quintic = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};
const pointRecord = (point) => ({ x: point.x, y: point.y, z: point.z });
const distanceBetween = (left, right) => Math.hypot(
  left.x - right.x,
  left.y - right.y,
  left.z - right.z,
);

function unwrappedHostDistance(zone, distance) {
  if (!zone.host.closed) return distance;
  let delta = distance - zone.hostRef;
  delta -= Math.round(delta / zone.host.length) * zone.host.length;
  return zone.hostRef + delta;
}

const P1_TWO_PLUS_TWO_DIVERGE_ID = 'J2:diverge:c1_0:r1_0:start';

/**
 * Merge topologies that append the branch's two lanes outside the host's paved
 * edge and close them one at a time: topology tag -> the host lane count it
 * contracts for.
 */
export const APPENDED_PAIR_MERGE_HOST_LANES = Object.freeze({
  '2+3-merge': 3,
  '2+2-merge': 2,
});

/** TRUE for a built transition running the appended-pair merge model. */
export function isAppendedPairMerge(transition) {
  return APPENDED_PAIR_MERGE_HOST_LANES[transition?.topology] !== undefined;
}

function laneMappings(zone, branchExitLanes = [0], auxiliaryLaneCount = 1, stagedOpening = false) {
  const { host, branch, kind, side } = zone;
  const outerHostLane = side > 0 ? 0 : host.lanes - 1;
  const mappings = Array.from({ length: host.lanes }, (_, lane) => ({
    source: `host:${lane}`,
    temporary: `host:${lane}`,
    final: `host:${lane}`,
    outcome: 'survives',
  }));
  if (kind === 'merge') {
    if (auxiliaryLaneCount === 2 && branchExitLanes.length >= 2) {
      branchExitLanes.slice(0, 2).forEach((lane, auxiliaryLane) => {
        mappings.push({
          source: `branch:${lane}`,
          temporary: `aux:${auxiliaryLane}`,
          final: `host:${outerHostLane}`,
          outcome: auxiliaryLane === 0
            ? 'absorbed-second-into-outer-host-lane'
            : 'absorbed-first-into-aux:0',
        });
      });
      return mappings;
    }
    for (let lane = 0; lane < branch.lanes; lane += 1) {
      mappings.push({
        source: `branch:${lane}`,
        temporary: lane === 0 ? `host:${outerHostLane}` : 'aux:0',
        final: `host:${outerHostLane}`,
        outcome: lane === 0 ? 'continues-into-outer-host-lane' : 'absorbed',
      });
    }
    if (branch.lanes === 1) {
      mappings[mappings.length - 1].temporary = 'aux:0';
      mappings[mappings.length - 1].outcome = 'absorbed-into-outer-host-lane';
    }
  } else if (stagedOpening && auxiliaryLaneCount === 2 && branchExitLanes.length >= 2) {
    // The exact reverse of the staged 2+3 absorption: aux:0 opens out of the
    // outer host lane first, then aux:1 opens out of aux:0.
    branchExitLanes.slice(0, 2).forEach((lane, auxiliaryLane) => {
      mappings.push({
        source: auxiliaryLane === 0 ? `host:${outerHostLane}` : 'aux:0',
        temporary: `aux:${auxiliaryLane}`,
        final: `branch:${lane}`,
        outcome: auxiliaryLane === 0
          ? 'opens-first-from-outer-host-lane'
          : 'opens-second-from-aux:0',
      });
    });
  } else {
    branchExitLanes.forEach((lane, index) => {
      mappings.push({
        source: index === 0 ? `host:${outerHostLane}` : `aux:${index}`,
        temporary: `aux:${index}`,
        final: `branch:${lane}`,
        outcome: index === 0 ? 'splits-to-branch' : 'opens-progressively',
      });
    });
  }
  return mappings;
}

function buildRecord(map, zone, prototype) {
  const rows = [...zone.samples].sort((left, right) => left.hU - right.hU);
  const branchRows = [...zone.samples].sort((left, right) => left.bS - right.bS);
  let approachStart = rows[0].hU;
  const sourceTransitionStart = rows[0].hU;
  const sourceTransitionEnd = rows[rows.length - 1].hU;
  let transitionEnd = sourceTransitionEnd;
  let length = transitionEnd - approachStart;
  const compatible = rows.filter((row) => Math.abs(row.dy) <= 0.75);
  const compatibleStart = compatible.length ? compatible[0].hU : approachStart + length * 0.14;
  const compatibleEnd = compatible.length ? compatible[compatible.length - 1].hU : transitionEnd - length * 0.14;
  let openingStart = zone.kind === 'merge'
    ? clamp(Math.max(approachStart + length * 0.12, compatibleStart), approachStart + 12, transitionEnd - 72)
    : clamp(approachStart + length * 0.12, approachStart + 12, compatibleEnd - 64);
  let parallelStart = clamp(
    Math.max(openingStart + 30, approachStart + length * 0.32),
    openingStart + 28,
    transitionEnd - 48,
  );
  const hostLaneEdge = zone.host.lanes * zone.host.laneWidth * 0.5;
  const auxiliaryWidth = zone.host.laneWidth;
  // P1 is a 2 -> 2 diverge. Its shared section must contain two continuing
  // host lanes plus both exiting branch lanes; the former 2+1 model made the
  // host exterior line land on the branch divider. Keep this exception scoped
  // to the selected same-level prototype until the remaining candidates are
  // individually reviewed.
  const twoPlusTwo = zone.id === P1_TWO_PLUS_TWO_DIVERGE_ID
    && zone.kind === 'diverge'
    && zone.host.lanes === 2
    && zone.branch.lanes === 2;
  // The 2+3 merge is the approved conceptual inverse: the existing three-lane
  // Wangan mainline remains untouched while both two-lane ramp feeds become
  // real, normal-width temporary lanes. They are absorbed one at a time
  // (5 -> 4 -> 3) instead of being collapsed into the legacy single auxiliary
  // lane. The allow-list carries the topology, so a second approved location
  // (P3, the Tatsumi ramp) shares this model instead of copying its ID test.
  //
  // The model is a function of the branch pair, not of the host's lane count:
  // P5 runs it on a two-lane host (`2+2-merge`, ramp 30 joining ramp 3), where
  // the same two appended lanes are closed 4 -> 3 -> 2.
  const twoPlusThreeMerge = zone.kind === 'merge'
    && zone.branch.lanes === 2
    && APPENDED_PAIR_MERGE_HOST_LANES[prototype.topology] === zone.host.lanes;
  // The 3+2 diverge is that model read backwards on the same carriageway: the
  // three-lane mainline opens two normal-width lanes OUTSIDE its paved edge one
  // at a time (3 -> 4 -> 5), holds them, and the branch leaves as a rigid
  // two-lane carriageway off those appended slots. Every landmark is the merge's
  // own measurement taken on the reversed branch rows.
  const threePlusTwoDiverge = prototype.topology === '3+2-diverge'
    && zone.kind === 'diverge'
    && zone.host.lanes === 3
    && zone.branch.lanes === 2;
  const auxiliaryLaneCount = twoPlusTwo || twoPlusThreeMerge || threePlusTwoDiverge ? 2 : 1;
  const targetExtraWidth = auxiliaryWidth * auxiliaryLaneCount;
  const hostEdgeMarkingShoulder = Math.max(0, (zone.host.shoulder || 0) - 0.75);
  const branchEdgeMarkingShoulder = Math.max(0, (zone.branch.shoulder || 0) - 0.75);
  const auxiliaryMarkingShoulder = Math.min(
    hostEdgeMarkingShoulder,
    branchEdgeMarkingShoulder,
  );
  const auxiliaryMarkedWidth = auxiliaryWidth + auxiliaryMarkingShoulder;
  const auxiliaryTotalWidth = auxiliaryWidth * auxiliaryLaneCount;
  const auxiliaryTotalMarkedWidth = auxiliaryTotalWidth + auxiliaryMarkingShoulder;
  const parallelExitCentreLateral = zone.side * (hostLaneEdge + auxiliaryTotalWidth * 0.5);
  const orderedBranchLanes = zone.kind === 'diverge' || twoPlusThreeMerge
    ? Array.from({ length: zone.branch.lanes }, (_, lane) => lane).sort((left, right) => (
      zone.hostwardSign * map._laneOffset(zone.branch, right, 1)
      - zone.hostwardSign * map._laneOffset(zone.branch, left, 1)
    ))
    : [0];
  const branchExitLanes = twoPlusTwo || twoPlusThreeMerge || threePlusTwoDiverge
    ? orderedBranchLanes
    : [orderedBranchLanes[0]];
  const branchFeedLane = branchExitLanes[0];
  const branchOuterLane = branchExitLanes.at(-1);
  const branchFeedLateral = map._laneOffset(zone.branch, branchFeedLane, 1);
  const branchOuterLateral = map._laneOffset(zone.branch, branchOuterLane, 1);
  const branchFeedHalfWidth = zone.branch.laneWidth * 0.5;
  const branchExitInnerLateral = branchFeedLateral
    + zone.hostwardSign * branchFeedHalfWidth;
  const branchExitOuterLateral = branchOuterLateral
    - zone.hostwardSign * branchFeedHalfWidth;
  const branchExitCentreLateral = (branchExitInnerLateral + branchExitOuterLateral) * 0.5;
  const branchFeedInnerMarkingLateral = branchExitInnerLateral
    + zone.hostwardSign * auxiliaryMarkingShoulder;
  const branchExitOutwardAt = (row) => {
    const target = map._deckPoint(row.frame, branchExitCentreLateral);
    const projection = map._projectToRoute(zone.host, target, map._hostSeedIndex(zone.host, row.hS));
    return zone.side * projection.signedLateral;
  };
  // `rows` defaults to the branch rows in travel order. A diverge measures the
  // same crossings on the REVERSED rows: its branch leaves the appended slots
  // where a merge's arrives on them, so the identical descent exists — it is
  // simply traversed from the separated end backwards.
  const firstCrossing = (valueAt, target, rows = branchRows) => {
    for (let index = 0; index < rows.length; index += 1) {
      const right = rows[index];
      const rightValue = valueAt(right);
      if (rightValue < target) continue;
      if (index === 0) return right;
      const left = rows[index - 1];
      const leftValue = valueAt(left);
      const t = clamp((target - leftValue) / Math.max(1e-6, rightValue - leftValue), 0, 1);
      return {
        ...right,
        bS: left.bS + (right.bS - left.bS) * t,
        hU: left.hU + (right.hU - left.hU) * t,
      };
    }
    return rows.at(-1);
  };
  const firstDescendingCrossing = (valueAt, target, rows = branchRows) => {
    for (let index = 1; index < rows.length; index += 1) {
      const left = rows[index - 1];
      const right = rows[index];
      const leftValue = valueAt(left);
      const rightValue = valueAt(right);
      if (leftValue < target || rightValue > target) continue;
      const t = clamp((leftValue - target) / Math.max(1e-6, leftValue - rightValue), 0, 1);
      return {
        ...right,
        bS: left.bS + (right.bS - left.bS) * t,
        hS: left.hS + (right.hS - left.hS) * t,
        hU: left.hU + (right.hU - left.hU) * t,
        half: left.half + (right.half - left.half) * t,
      };
    }
    return rows.at(-1);
  };
  const branchHostwardPavementOutwardAt = (row) => {
    const target = map._deckPoint(row.frame, zone.hostwardSign * row.half);
    const projection = map._projectToRoute(zone.host, target, map._hostSeedIndex(zone.host, row.hS));
    return zone.side * projection.signedLateral;
  };
  // Reversed rows read the departure of an appended-anchor diverge with the
  // merge's own descending measurements: the branch comes DOWN onto the slot
  // centre as the station walks back from lateral separation.
  const reversedBranchRows = threePlusTwoDiverge ? [...branchRows].reverse() : null;
  // The last station at which the exiting pair still sits exactly on the two
  // appended slots — the mirror of the merge's FULL 5 handoff.
  const divergeHandoffRow = threePlusTwoDiverge
    ? firstDescendingCrossing(
      branchExitOutwardAt,
      Math.abs(parallelExitCentreLateral),
      reversedBranchRows,
    )
    : null;
  // Where the branch's hostward pavement edge leaves the host's outer lane
  // line: plan/paint ownership is fully back with the branch here.
  const divergeOpeningRow = threePlusTwoDiverge
    ? firstDescendingCrossing(branchHostwardPavementOutwardAt, hostLaneEdge, reversedBranchRows)
    : null;
  const alignmentRow = zone.kind === 'diverge'
    ? (divergeHandoffRow ?? firstCrossing(branchExitOutwardAt, Math.abs(parallelExitCentreLateral)))
    : null;
  const physicalSplitRow = zone.kind === 'diverge'
    ? firstCrossing((row) => row.innerEdge - row.hostHalf, -0.3)
    : null;
  // Exterior ownership passes to the branch where it leaves the slots; for a
  // host-lane-anchored diverge that is still the width-based measurement.
  const exteriorHandoffRow = zone.kind === 'diverge'
    ? (divergeHandoffRow ?? firstCrossing((row) => row.unionOuter - row.hostHalf, targetExtraWidth))
    : null;
  // Rail quads are emitted only when both neighbouring surface frames are
  // visible. For P4's two-lane exit, keeping the first host frame *after* the
  // analytic handoff puts that terminal inside the turning outer exit lane.
  // Release on the final emitted host frame at/before handoff; the first branch
  // exterior frame is then 1.45 m away on the same authoritative paved edge.
  let resolvedHostRailRelease = null;
  const resolveHostRailRelease = () => {
    if (zone.kind !== 'diverge') return null;
    if (resolvedHostRailRelease !== null) return resolvedHostRailRelease;
    // Surface frames are populated after the progressive record itself, so
    // resolve lazily on the first rail-visibility query.
    const candidates = (zone.host.surfaceFrames || [])
      .map((frame) => unwrappedHostDistance(zone, frame.distance))
      .filter((hostS) => (
        hostS >= openingStart - 1e-4 && hostS <= exteriorHandoffRow.hU + 1e-4
      ));
    resolvedHostRailRelease = candidates.length
      ? Math.max(...candidates)
      : exteriorHandoffRow.hU;
    return resolvedHostRailRelease;
  };
  // Rail quads are emitted only between two visible neighbouring frames, so the
  // exterior parapet changes owner on a frame, not on the analytic station. The
  // host releases on its last emitted frame at or before the handoff and the
  // branch picks the same edge up on its first frame beyond that, which is the
  // only pairing that neither doubles the wall nor loses a whole frame of it.
  let resolvedDivergeRailHold = null;
  const resolveDivergeRailHold = () => {
    if (resolvedDivergeRailHold !== null) return resolvedDivergeRailHold;
    const candidates = (zone.host.surfaceFrames || [])
      .map((frame) => unwrappedHostDistance(zone, frame.distance))
      .filter((hostS) => (
        hostS >= parallelStart - 1e-4 && hostS <= divergeHandoffStart + 1e-4
      ));
    resolvedDivergeRailHold = candidates.length
      ? Math.max(...candidates)
      : divergeHandoffStart;
    return resolvedDivergeRailHold;
  };
  const sourceGoreClearanceRow = zone.kind === 'diverge'
    ? firstCrossing((row) => row.innerEdge - row.hostHalf, 1.5)
    : null;
  // For J48, topology is determined from the real three-lane host edge, not
  // from the old two-lane prototype's marking-opening station. OPENING is the
  // first physical contact between the ramp pavement and the exterior lane
  // boundary. FULL 5 begins only where the unmodified ramp pair midpoint has
  // naturally reached the midpoint of the two appended normal-width slots.
  const mergeOpeningRow = twoPlusThreeMerge
    ? firstDescendingCrossing(branchHostwardPavementOutwardAt, hostLaneEdge)
    : null;
  const mergeOpeningStart = mergeOpeningRow?.hU ?? null;
  const mergeHandoffRow = twoPlusThreeMerge
    ? firstDescendingCrossing(branchExitOutwardAt, Math.abs(parallelExitCentreLateral))
    : null;
  const mergeHandoffComplete = mergeHandoffRow?.hU ?? null;
  const mergeDeckHandoffComplete = mergeHandoffComplete;
  let mergeOpeningLateralShift = null;
  let mergeHandoffLateralShift = null;
  let mergeStageLength = null;
  // A branch anchored ALONGSIDE the host runs adjacent to it for the whole
  // approach, so the two exterior parapets meet long before the paint opening.
  // The separating rails must release at that measured clearance instead, or
  // the two routes emit doubled walls 0.08 m apart on the same edge.
  const appendedBranch = prototype.branchAnchor === 'appended';
  let railOpeningStart = openingStart;
  if (twoPlusThreeMerge) {
    // The ramp owns its unchanged cross-section through the geometric
    // approach. At parallelStart its two lane centres exactly match the two
    // appended host slots; downstream pavement/collision ownership transfers
    // completely to the progressive host envelope.
    openingStart = mergeOpeningStart;
    parallelStart = mergeHandoffComplete;
    mergeOpeningLateralShift = Math.abs(
      (hostLaneEdge + mergeOpeningRow.half) - Math.abs(parallelExitCentreLateral)
    );
    const sourceTerminalRow = zone.which === 'end' ? branchRows.at(-1) : branchRows[0];
    mergeHandoffLateralShift = Math.abs(
      Math.abs(parallelExitCentreLateral) - branchExitOutwardAt(sourceTerminalRow)
    );
    const measuredPostHandoffSpan = Math.abs(sourceTerminalRow.hU - mergeHandoffComplete);
    // Preserve the ramp's measured drift rate for every plateau and
    // absorption. One stage is exactly the longitudinal run in which the
    // source geometry moves one normal lane width; the resulting taper is
    // geometry-derived and never falls back to a location metre constant.
    //
    // A branch anchored onto APPENDED lanes reaches its slots and then runs
    // parallel, so it has no post-handoff drift to measure. Its own
    // convergence onto those slots is the same kind of measurement and is the
    // rate that branch actually uses, so read the stage from the approach
    // instead of inventing a constant.
    const approachRow = zone.which === 'end' ? branchRows[0] : branchRows.at(-1);
    const approachShift = Math.abs(
      branchExitOutwardAt(approachRow) - Math.abs(parallelExitCentreLateral)
    );
    const approachSpan = Math.abs(mergeHandoffComplete - approachRow.hU);
    const driftedAfterHandoff = mergeHandoffLateralShift > 0.5 && measuredPostHandoffSpan > 1;
    mergeStageLength = driftedAfterHandoff
      ? measuredPostHandoffSpan * auxiliaryWidth / Math.max(1e-6, mergeHandoffLateralShift)
      : approachSpan * auxiliaryWidth / Math.max(1e-6, approachShift);
    if (appendedBranch) {
      // 0.90 m is the width two 0.42 m-inset parapets need between the two
      // paved edges. Inside it there is no room for a separating wall, so both
      // owners release and the gap between the carriageways becomes the
      // painted gore it is in reality.
      const railClearanceRow = firstDescendingCrossing(
        (row) => branchHostwardPavementOutwardAt(row) - row.hostHalf,
        0.9,
      );
      railOpeningStart = Math.min(railClearanceRow.hU, openingStart);
    } else {
      railOpeningStart = openingStart;
    }
  }
  // ---- 3+2 diverge: the same four stages, walked the other way -------------
  const divergeHandoffStart = threePlusTwoDiverge ? divergeHandoffRow.hU : null;
  const divergeHandoffComplete = threePlusTwoDiverge ? divergeOpeningRow.hU : null;
  let divergeStageLength = null;
  let divergeDepartureShift = null;
  let firstOpeningEnd = null;      // 3 -> 4 complete
  let secondOpeningStart = null;   // 4 -> 5 begins
  let railOpeningEnd = null;       // separating parapets may resume
  if (threePlusTwoDiverge) {
    const sourceTerminalRow = zone.which === 'start' ? branchRows.at(-1) : branchRows[0];
    // One stage is the run in which the branch's own geometry moves one normal
    // lane width — measured on its departure, exactly as the merge measures it
    // on its approach. Every plateau and taper upstream inherits that rate, so
    // the widening reads at the same pace as the exit it feeds.
    divergeDepartureShift = Math.abs(
      branchExitOutwardAt(sourceTerminalRow) - Math.abs(parallelExitCentreLateral)
    );
    const departureSpan = Math.abs(sourceTerminalRow.hU - divergeHandoffStart);
    divergeStageLength = departureSpan * auxiliaryWidth / Math.max(1e-6, divergeDepartureShift);
    transitionEnd = sourceTerminalRow.hU;
    parallelStart = divergeHandoffStart - divergeStageLength;   // FULL 5 established
    secondOpeningStart = parallelStart - divergeStageLength;    // 4 -> 5 taper start
    firstOpeningEnd = secondOpeningStart - divergeStageLength;  // 4-lane plateau start
    openingStart = firstOpeningEnd - divergeStageLength;        // 3 -> 4 taper start
    approachStart = openingStart - divergeStageLength;
    length = transitionEnd - approachStart;
    if (appendedBranch) {
      // Mirror of the merge's rail release: the two paved edges are closer than
      // the 0.90 m two 0.42 m-inset parapets need until this station, so both
      // owners stay released and the gap is the painted gore it is in reality.
      const railClearanceRow = firstDescendingCrossing(
        (row) => branchHostwardPavementOutwardAt(row) - row.hostHalf,
        0.9,
        reversedBranchRows,
      );
      railOpeningEnd = Math.max(railClearanceRow.hU, divergeHandoffComplete);
    } else {
      railOpeningEnd = divergeHandoffComplete;
    }
  }
  // The generic A-B rule refuses to paint the branch's hostward edge and its own
  // divider anywhere inside the junction's marking opening. The transition
  // therefore keeps both of those boundaries until the opening actually ends,
  // instead of handing back at its own handoff and leaving the gore blank.
  const branchOpeningEnd = threePlusTwoDiverge
    ? clamp(
      zone.markingOpening?.branch?.[1] ?? divergeOpeningRow.bS,
      divergeOpeningRow.bS,
      branchRows.at(-1).bS,
    )
    : null;
  const hostStationAtBranch = (distance) => {
    let upper = 1;
    while (upper < branchRows.length && branchRows[upper].bS < distance) upper += 1;
    if (upper >= branchRows.length) return branchRows.at(-1).hU;
    const left = branchRows[upper - 1];
    const right = branchRows[upper];
    const span = Math.max(1e-6, right.bS - left.bS);
    return left.hU + (right.hU - left.hU) * ((distance - left.bS) / span);
  };
  const branchOpeningEndHost = threePlusTwoDiverge
    ? hostStationAtBranch(branchOpeningEnd)
    : null;
  let absorptionStart = clamp(
    Math.min(approachStart + length * 0.68, compatibleEnd - 8),
    parallelStart + 24,
    transitionEnd - 24,
  );
  if (zone.kind === 'diverge' && !twoPlusTwo && !threePlusTwoDiverge) {
    absorptionStart = clamp(alignmentRow.hU, parallelStart + 4, transitionEnd - 4);
  }
  // The departure IS this model's absorption phase, read the other way.
  if (threePlusTwoDiverge) absorptionStart = divergeHandoffStart;
  let firstAbsorptionEnd = null;
  let secondAbsorptionStart = null;
  if (twoPlusThreeMerge) {
    absorptionStart = parallelStart + mergeStageLength;
    firstAbsorptionEnd = absorptionStart + mergeStageLength;
    secondAbsorptionStart = firstAbsorptionEnd + mergeStageLength;
    transitionEnd = secondAbsorptionStart + mergeStageLength;
    length = transitionEnd - approachStart;
  }
  // The full P4 exit carriageway begins steering during the model's measured
  // absorption phase while it is still supported by the widened host deck.
  // Paint/rail ownership remains at the later source-envelope handoff. This
  // gives both exiting lane paths enough source-derived length to rotate as a
  // rigid 7.10 m cross-section instead of forcing a sharp last-18 m turn.
  const divergePathStart = twoPlusTwo ? absorptionStart : exteriorHandoffRow?.hU;
  const divergeHandoffPoint = (
    hostS,
    startLateral,
    branchLateral,
    lift = 0.035,
    endHostS = transitionEnd,
    endBranchS = branchRows.at(-1).bS,
  ) => {
    const startS = divergePathStart;
    const endS = endHostS;
    const startFrame = map._frameAt(zone.host, startS);
    const endFrame = map._frameAt(zone.branch, endBranchS);
    const start = map._deckPoint(startFrame, startLateral, lift);
    const end = map._deckPoint(endFrame, branchLateral, lift);
    const controlLength = start.distanceTo(end) * 0.4;
    const control0 = start.clone().addScaledVector(startFrame.tangent, controlLength);
    const control1 = end.clone().addScaledVector(endFrame.tangent, -controlLength);
    const t = clamp((hostS - startS) / Math.max(1e-6, endS - startS), 0, 1);
    const u = 1 - t;
    return start.clone().multiplyScalar(u * u * u)
      .add(control0.clone().multiplyScalar(3 * u * u * t))
      .add(control1.clone().multiplyScalar(3 * u * t * t))
      .add(end.clone().multiplyScalar(t * t * t));
  };
  const branchDistanceAtHost = (distance) => {
    const hostS = unwrappedHostDistance(zone, distance);
    if (hostS <= rows[0].hU) return rows[0].bS;
    if (hostS >= sourceTransitionEnd) return rows.at(-1).bS;
    let upper = 1;
    while (upper < rows.length && rows[upper].hU < hostS) upper += 1;
    const left = rows[upper - 1];
    const right = rows[upper];
    const factor = (hostS - left.hU) / Math.max(1e-6, right.hU - left.hU);
    return left.bS + (right.bS - left.bS) * factor;
  };
  const mergeHandoffGeometryAt = (distance, lift = 0.035) => {
    if (!twoPlusThreeMerge) return null;
    const hostS = clamp(
      unwrappedHostDistance(zone, distance),
      approachStart,
      mergeHandoffComplete,
    );
    const branchS = branchDistanceAtHost(hostS);
    const hostFrame = map._frameAt(zone.host, map._normalizeDistance(zone.host, hostS));
    const branchFrame = map._frameAt(zone.branch, branchS);
    const sourceCentre = map._deckPoint(branchFrame, branchExitCentreLateral, lift);
    const temporaryCentre = map._deckPoint(hostFrame, parallelExitCentreLateral, lift);
    const sourceOutwardPoint = map._deckPoint(
      branchFrame,
      branchExitCentreLateral - zone.hostwardSign,
      lift,
    );
    const temporaryOutwardPoint = map._deckPoint(
      hostFrame,
      parallelExitCentreLateral + zone.side,
      lift,
    );
    const sourceOutward = sourceOutwardPoint.sub(sourceCentre).normalize();
    const temporaryOutward = temporaryOutwardPoint.sub(temporaryCentre).normalize();
    const factor = hostS <= mergeOpeningStart
      ? 0
      : quintic((hostS - mergeOpeningStart) / (mergeHandoffComplete - mergeOpeningStart));
    // The real ramp midpoint reaches the appended-pair midpoint here. Across
    // the short physical opening, rotate the still-rigid 7.10 m cross-section
    // by the measured tangent mismatch so both source lane centres terminate
    // exactly on their host slots; no host lane index participates.
    const centre = sourceCentre.clone().multiplyScalar(1 - factor)
      .add(temporaryCentre.clone().multiplyScalar(factor));
    const outward = sourceOutward.multiplyScalar(1 - factor)
      .add(temporaryOutward.multiplyScalar(factor))
      .normalize();
    return {
      hostS,
      branchS,
      factor,
      centre,
      outward,
      pointAt(outwardOffset) {
        const point = centre.clone().addScaledVector(outward, outwardOffset);
        if (hostS >= mergeOpeningStart) {
          const hostProjection = map._projectToRoute(
            zone.host,
            point,
            map._hostSeedIndex(zone.host, hostS),
          );
          const hostDeckY = hostProjection.point.y
            + Math.tan(map._bankAt(zone.host, hostProjection.distance))
              * hostProjection.signedLateral;
          const branchProjection = map._projectToRoute(
            zone.branch,
            point,
            map._hostSeedIndex(zone.branch, branchS),
          );
          const sourceFrame = map._frameAt(zone.branch, branchProjection.distance);
          const branchDeckY = sourceFrame.position.y
            + Math.tan(sourceFrame.bank) * branchProjection.signedLateral;
          // Height ownership transfers continuously with the same geometric
          // handoff factor as plan ownership. A footprint-boundary predicate
          // here previously flipped individual lane samples between decks and
          // created a false vertical kink inside the opening.
          point.y = branchDeckY + (hostDeckY - branchDeckY) * factor + lift;
        }
        return point;
      },
    };
  };
  const mergeFullFiveAlignmentAt = (distance, outwardOffset, lift = 0.035) => {
    const hostS = clamp(unwrappedHostDistance(zone, distance), parallelStart, absorptionStart);
    const startHostFrame = map._frameAt(zone.host, map._normalizeDistance(zone.host, parallelStart));
    const endHostFrame = map._frameAt(zone.host, map._normalizeDistance(zone.host, absorptionStart));
    const start = map._deckPoint(
      startHostFrame,
      parallelExitCentreLateral + zone.side * outwardOffset,
      lift,
    );
    const end = map._deckPoint(
      endHostFrame,
      parallelExitCentreLateral + zone.side * outwardOffset,
      lift,
    );
    // One complete appended carriageway width supplies the tangent-control
    // run. The opening path arrives with the host tangent after its measured
    // source-to-slot rotation; this full-five curve keeps that tangent and the
    // rigid two-lane cross-section settled on the host before absorption.
    const controlLength = Math.min(start.distanceTo(end) / 3, auxiliaryTotalWidth);
    const control0 = start.clone().addScaledVector(startHostFrame.tangent, controlLength);
    const control1 = end.clone().addScaledVector(endHostFrame.tangent, -controlLength);
    const t = clamp((hostS - parallelStart) / Math.max(1e-6, absorptionStart - parallelStart), 0, 1);
    const u = 1 - t;
    const point = start.clone().multiplyScalar(u * u * u)
      .add(control0.clone().multiplyScalar(3 * u * u * t))
      .add(control1.clone().multiplyScalar(3 * u * t * t))
      .add(end.clone().multiplyScalar(t * t * t));
    const projection = map._projectToRoute(
      zone.host,
      point,
      map._hostSeedIndex(zone.host, hostS),
    );
    point.y = projection.point.y
      + Math.tan(map._bankAt(zone.host, projection.distance)) * projection.signedLateral
      + lift;
    return point;
  };
  const mergeEnvelopeExtraAt = (distance) => {
    if (!twoPlusThreeMerge || distance < mergeOpeningStart) return 0;
    if (distance >= mergeHandoffComplete) return targetExtraWidth;
    const geometry = mergeHandoffGeometryAt(distance, 0);
    // The source ramp already supplies its side of the crossable union. The
    // host-owned addition grows only by the measured ownership-transfer
    // factor, so it cannot jump or narrow while the rigid ramp pair hands off.
    return targetExtraWidth * geometry.factor;
  };
  /**
   * The 3+2 diverge's departure, which is `mergeHandoffGeometryAt` reversed:
   * the rigid two-lane cross-section starts ON the two appended host slots and
   * rotates onto the branch's own alignment as the branch geometry leaves them.
   * Plan and height ownership move together with one factor, so no lane sample
   * can flip decks on its own.
   */
  const divergeHandoffGeometryAt = (distance, lift = 0.035) => {
    if (!threePlusTwoDiverge) return null;
    const hostS = clamp(
      unwrappedHostDistance(zone, distance),
      divergeHandoffStart,
      transitionEnd,
    );
    const branchS = branchDistanceAtHost(hostS);
    const hostFrame = map._frameAt(zone.host, map._normalizeDistance(zone.host, hostS));
    const branchFrame = map._frameAt(zone.branch, branchS);
    const sourceCentre = map._deckPoint(branchFrame, branchExitCentreLateral, lift);
    const temporaryCentre = map._deckPoint(hostFrame, parallelExitCentreLateral, lift);
    const sourceOutwardPoint = map._deckPoint(
      branchFrame,
      branchExitCentreLateral - zone.hostwardSign,
      lift,
    );
    const temporaryOutwardPoint = map._deckPoint(
      hostFrame,
      parallelExitCentreLateral + zone.side,
      lift,
    );
    const sourceOutward = sourceOutwardPoint.sub(sourceCentre).normalize();
    const temporaryOutward = temporaryOutwardPoint.sub(temporaryCentre).normalize();
    const factor = quintic((hostS - divergeHandoffStart)
      / Math.max(1e-6, divergeHandoffComplete - divergeHandoffStart));
    const centre = temporaryCentre.clone().multiplyScalar(1 - factor)
      .add(sourceCentre.clone().multiplyScalar(factor));
    const outward = temporaryOutward.multiplyScalar(1 - factor)
      .add(sourceOutward.multiplyScalar(factor))
      .normalize();
    return {
      hostS,
      branchS,
      factor,
      centre,
      outward,
      pointAt(outwardOffset) {
        const point = centre.clone().addScaledVector(outward, outwardOffset);
        const hostProjection = map._projectToRoute(
          zone.host,
          point,
          map._hostSeedIndex(zone.host, hostS),
        );
        const hostDeckY = hostProjection.point.y
          + Math.tan(map._bankAt(zone.host, hostProjection.distance))
            * hostProjection.signedLateral;
        const branchProjection = map._projectToRoute(
          zone.branch,
          point,
          map._hostSeedIndex(zone.branch, branchS),
        );
        const sourceFrame = map._frameAt(zone.branch, branchProjection.distance);
        const branchDeckY = sourceFrame.position.y
          + Math.tan(sourceFrame.bank) * branchProjection.signedLateral;
        point.y = hostDeckY + (branchDeckY - hostDeckY) * factor + lift;
        return point;
      },
    };
  };
  /**
   * Staged host-owned width for the 3+2 diverge. Two normal lanes appear one at
   * a time with a full plateau between them, hold for one stage, then hand the
   * corridor back to the branch across the measured departure.
   */
  const divergeEnvelopeFactorAt = (distance) => {
    if (distance <= openingStart) return 0;
    if (distance < firstOpeningEnd) {
      return quintic((distance - openingStart) / (firstOpeningEnd - openingStart)) * 0.5;
    }
    if (distance <= secondOpeningStart) return 0.5;
    if (distance < parallelStart) {
      return 0.5 + quintic((distance - secondOpeningStart)
        / (parallelStart - secondOpeningStart)) * 0.5;
    }
    if (distance <= divergeHandoffStart) return 1;
    if (distance >= divergeHandoffComplete) return 0;
    // The branch's own deck already supplies the rest of the crossable union
    // here, so the host-owned addition retreats by exactly the same measured
    // transfer factor that carries the exiting pair off the slots.
    return 1 - divergeHandoffGeometryAt(distance, 0).factor;
  };

  const record = {
    id: zone.id,
    label: prototype.label,
    pin: { ...prototype.pin },
    hostRouteId: zone.host.id,
    branchRouteId: zone.branch.id,
    type: zone.kind,
    // horizontalNormal() is the driver's right, so negative lateral is left.
    side: zone.side > 0 ? 'right' : 'left',
    sideSign: zone.side,
    which: zone.which,
    approachStart,
    openingStart,
    parallelStart,
    mergeOpeningStart,
    mergeHandoffComplete,
    branchAnchor: appendedBranch ? 'appended' : 'host-lanes',
    railOpeningStart,
    mergeDeckHandoffComplete,
    mergeOpeningLateralShift,
    mergeHandoffLateralShift,
    mergeStageLength,
    divergeStageLength,
    divergeHandoffStart,
    divergeHandoffComplete,
    divergeDepartureShift,
    firstOpeningEnd,
    secondOpeningStart,
    railOpeningEnd,
    // FULL 5 is one interval in both senses: the merge reaches it and starts
    // giving lanes back, the diverge holds it and starts handing the pair over.
    fiveLaneStart: twoPlusThreeMerge || threePlusTwoDiverge ? parallelStart : null,
    fiveLaneEnd: twoPlusThreeMerge || threePlusTwoDiverge ? absorptionStart : null,
    absorptionStart,
    firstAbsorptionEnd,
    secondAbsorptionStart,
    transitionEnd,
    sourceTransitionEnd,
    alignmentStart: zone.kind === 'diverge' ? absorptionStart : null,
    exitPathStart: zone.kind === 'diverge' ? divergePathStart : null,
    laneHandoffStart: exteriorHandoffRow?.hU ?? (twoPlusThreeMerge ? openingStart : null),
    physicalSplitStart: physicalSplitRow?.hU ?? null,
    exteriorHandoffStart: exteriorHandoffRow?.hU ?? (twoPlusThreeMerge ? mergeHandoffComplete : null),
    get hostRailRelease() { return resolveHostRailRelease(); },
    // A diverge gore is not allowed to begin merely because the source decks
    // have opened a narrow gap. It begins only after both auxiliary centres
    // and all exit boundaries have landed on the real branch-lane geometry.
    transferComplete: zone.kind === 'diverge'
      ? transitionEnd
      : (twoPlusThreeMerge ? mergeHandoffComplete : null),
    goreStart: zone.kind === 'diverge'
      ? (threePlusTwoDiverge ? divergeHandoffComplete : transitionEnd)
      : null,
    sourceGoreClearanceStart: sourceGoreClearanceRow?.hU ?? null,
    alignmentBranchStart: alignmentRow?.bS ?? null,
    physicalSplitBranchStart: physicalSplitRow?.bS ?? null,
    exteriorHandoffBranchStart: exteriorHandoffRow?.bS ?? null,
    // A 3+2 diverge finishes its transfer where the branch's hostward pavement
    // leaves the host's outer lane line, not at the end of the sampled span:
    // downstream of that the ramp is an ordinary separate carriageway and paints
    // its own lines.
    transferCompleteBranch: zone.kind === 'diverge'
      ? (threePlusTwoDiverge ? divergeOpeningRow.bS : branchRows.at(-1).bS)
      : null,
    markingSettleEnd: zone.kind === 'diverge'
      ? (threePlusTwoDiverge
        ? branchOpeningEnd
        : Math.min(zone.branch.length, branchRows.at(-1).bS + 12))
      : null,
    branchSettleEnd: zone.kind === 'diverge'
      ? (threePlusTwoDiverge
        ? branchOpeningEnd
        : Math.min(zone.branch.length, branchRows.at(-1).bS + 32))
      : null,
    goreBranchStart: zone.kind === 'diverge'
      ? (threePlusTwoDiverge ? divergeHandoffRow.bS : branchRows.at(-1).bS)
      : null,
    sourceGoreClearanceBranchStart: sourceGoreClearanceRow?.bS ?? null,
    length,
    phaseOrder: [...PROGRESSIVE_PHASES],
    hostLaneCount: zone.host.lanes,
    branchLaneCount: zone.branch.lanes,
    temporaryLaneCount: zone.host.lanes + auxiliaryLaneCount,
    finalLaneCount: zone.kind === 'diverge' ? zone.host.lanes + zone.branch.lanes : zone.host.lanes,
    finalHostLaneCount: zone.host.lanes,
    finalBranchLaneCount: zone.kind === 'diverge' ? zone.branch.lanes : 0,
    auxiliaryLaneCount,
    auxiliaryWidth,
    auxiliaryMarkedWidth,
    auxiliaryTotalWidth,
    auxiliaryTotalMarkedWidth,
    auxiliaryMarkingShoulder,
    targetExtraWidth,
    topology: twoPlusTwo
      ? '2+2-diverge'
      : (twoPlusThreeMerge
        ? prototype.topology
        : (threePlusTwoDiverge ? '3+2-diverge' : `${zone.host.lanes}+1-transition`)),
    branchInterval: [...zone.branchSpan],
    hostInterval: [approachStart, transitionEnd],
    crossableInterval: [openingStart, transitionEnd],
    // Paint spans. The exterior solid owns the whole host interval (it is the
    // host's own edge line outside the widening); the two temporary boundaries
    // exist only while they are distinct lines.
    outerMarkingInterval: [
      approachStart,
      threePlusTwoDiverge ? divergeHandoffComplete : transitionEnd,
    ],
    // The host's own edge line is only replaced while the transition actually
    // owns that boundary. Past the departure the ramp is a separate carriageway
    // and the mainline's normal edge line must come back, or the last 60 m of
    // the record would have no exterior line at all.
    hostEdgeSuppressInterval: threePlusTwoDiverge
      ? [approachStart, divergeHandoffComplete]
      : [approachStart, transitionEnd],
    innerMarkingInterval: [
      openingStart,
      threePlusTwoDiverge ? divergeHandoffComplete : transitionEnd,
    ],
    dividerMarkingInterval: [
      threePlusTwoDiverge ? secondOpeningStart : openingStart,
      threePlusTwoDiverge ? branchOpeningEndHost : transitionEnd,
    ],
    laneMappings: laneMappings(zone, branchExitLanes, auxiliaryLaneCount, threePlusTwoDiverge),
    branchFeedLane,
    branchExitLanes: [...branchExitLanes],
    survivingLanes: Array.from({ length: zone.host.lanes }, (_, lane) => `host:${lane}`),
    absorbedLanes: zone.kind === 'merge'
      ? (twoPlusThreeMerge ? ['aux:1', 'aux:0'] : ['aux:0'])
      : [],
    absorptionSteps: twoPlusThreeMerge ? [
      {
        fromLaneCount: 5,
        toLaneCount: 4,
        lane: 'aux:1',
        from: absorptionStart,
        to: firstAbsorptionEnd,
      },
      {
        fromLaneCount: 4,
        toLaneCount: 3,
        lane: 'aux:0',
        from: secondAbsorptionStart,
        to: transitionEnd,
      },
    ] : [],
    openingSteps: threePlusTwoDiverge ? [
      {
        fromLaneCount: 3,
        toLaneCount: 4,
        lane: 'aux:0',
        from: openingStart,
        to: firstOpeningEnd,
      },
      {
        fromLaneCount: 4,
        toLaneCount: 5,
        lane: 'aux:1',
        from: secondOpeningStart,
        to: parallelStart,
      },
    ] : [],
    separatedLanes: zone.kind === 'diverge'
      ? Array.from({ length: auxiliaryLaneCount }, (_, lane) => `aux:${lane}`)
      : [],
    laneCentres: [],
    laneBoundaries: [],
    markingPaths: [],
    branchLaneCentres: [],
    auxiliaryCorridor: [],
    auxiliaryLaneCorridors: [],
    pavedEnvelope: [],
    crossableEnvelope: [],
    markingOwnership: [],
    guardrailEnvelope: [],
    branchGuardrailEnvelope: [],
    automationStatus: 'prototype-enabled',
    manualReviewReason: null,
    sourceZone: zone,
    unwrapHost(distance) {
      return unwrappedHostDistance(zone, distance);
    },
    containsHost(distance, padding = 0) {
      const value = unwrappedHostDistance(zone, distance);
      return value >= approachStart - padding && value <= transitionEnd + padding;
    },
    hostRailModeAt(distance) {
      const hostS = unwrappedHostDistance(zone, distance);
      if (twoPlusThreeMerge) {
        if (hostS < railOpeningStart || hostS >= parallelStart) return 'on';
        // During the physical opening, the branch exterior owns the outside
        // rail. Removing the host-side wall here prevents a parapet from
        // spanning the drivable throat while the paved envelope widens.
        return 'off';
      }
      if (threePlusTwoDiverge) {
        // Mirror of the merge: the host parapet rides the widened envelope up
        // to the handoff, then releases for the gore and comes back on its own
        // edge as soon as the two paved edges are 0.90 m apart again.
        if (hostS <= resolveDivergeRailHold() + 1e-4 || hostS >= railOpeningEnd) return 'on';
        return 'off';
      }
      if (zone.kind !== 'diverge') return 'on';
      if (hostS <= resolveHostRailRelease() + 1e-4) return 'on';
      if (hostS < transitionEnd) return 'off';
      return 'on';
    },
    branchRailModeAt(distance, sideSign) {
      if (threePlusTwoDiverge) {
        if (distance < branchRows[0].bS - 0.01 || distance > branchRows.at(-1).bS + 0.01) return null;
        const hostS = this.hostAtBranch(distance);
        if (hostS === null) return null;
        if (sideSign === zone.hostwardSign) return hostS >= railOpeningEnd ? 'on' : 'off';
        // The exterior parapet has exactly one owner: the branch picks it up on
        // its first frame beyond the host's terminal, so the two never double.
        if (sideSign === -zone.hostwardSign) {
          return hostS > resolveDivergeRailHold() + 1e-4 ? 'on' : 'off';
        }
        return null;
      }
      if (twoPlusThreeMerge) {
        if (distance < branchRows[0].bS - 0.01 || distance > branchRows.at(-1).bS + 0.01) return null;
        const hostS = this.hostAtBranch(distance);
        if (hostS === null) return null;
        if (sideSign === zone.hostwardSign) return hostS < railOpeningStart ? 'on' : 'off';
        if (sideSign === -zone.hostwardSign) return hostS < parallelStart ? 'on' : 'off';
        return null;
      }
      if (zone.kind !== 'diverge') return null;
      if (distance < branchRows[0].bS - 0.01 || distance > branchRows.at(-1).bS + 0.01) return null;
      if (sideSign === zone.hostwardSign) return distance < branchRows.at(-1).bS ? 'off' : 'on';
      if (sideSign === -zone.hostwardSign) return distance < exteriorHandoffRow.bS ? 'off' : 'on';
      return null;
    },
    hostAtBranch(distance) {
      if (distance < branchRows[0].bS - 0.01 || distance > branchRows[branchRows.length - 1].bS + 0.01) return null;
      let upper = 1;
      while (upper < branchRows.length && branchRows[upper].bS < distance) upper += 1;
      if (upper >= branchRows.length) return branchRows[branchRows.length - 1].hU;
      const left = branchRows[upper - 1];
      const right = branchRows[upper];
      const span = Math.max(1e-6, right.bS - left.bS);
      return left.hU + (right.hU - left.hU) * ((distance - left.bS) / span);
    },
    branchAtHost(distance) {
      const hostS = unwrappedHostDistance(zone, distance);
      if (hostS < rows[0].hU - 0.01 || hostS > rows[rows.length - 1].hU + 0.01) return null;
      let upper = 1;
      while (upper < rows.length && rows[upper].hU < hostS) upper += 1;
      if (upper >= rows.length) return rows[rows.length - 1].bS;
      const left = rows[upper - 1];
      const right = rows[upper];
      const span = Math.max(1e-6, right.hU - left.hU);
      return left.bS + (right.bS - left.bS) * ((hostS - left.hU) / span);
    },
    branchDeckHostBlendAt(distance) {
      if (threePlusTwoDiverge) {
        // The exiting pair sits on the host's own banked plane while it is on
        // the appended slots, and is released onto its own deck by the same
        // factor that carries it off them.
        const hostS = this.hostAtBranch(distance);
        if (hostS === null) return 0;
        if (hostS <= divergeHandoffStart) return 1;
        if (hostS >= divergeHandoffComplete) return 0;
        return 1 - quintic((hostS - divergeHandoffStart)
          / (divergeHandoffComplete - divergeHandoffStart));
      }
      if (zone.kind === 'diverge') {
        const branchEnd = branchRows.at(-1).bS;
        if (distance < branchRows[0].bS - 0.01) return 0;
        if (distance <= branchEnd) return 1;
        if (distance >= this.branchSettleEnd) return 0;
        return 1 - quintic((distance - branchEnd) / (this.branchSettleEnd - branchEnd));
      }
      const hostS = this.hostAtBranch(distance);
      if (hostS === null) return 0;
      if (zone.kind === 'merge') {
        if (hostS <= openingStart) return 0;
        if (twoPlusThreeMerge) {
          if (hostS >= mergeDeckHandoffComplete) return 1;
          return quintic((hostS - openingStart)
            / (mergeDeckHandoffComplete - openingStart));
        }
        if (hostS >= parallelStart) return 1;
        return quintic((hostS - openingStart) / (parallelStart - openingStart));
      }
      return 0;
    },
    branchDeckOffsetAt(distance, lateral = 0) {
      const blend = this.branchDeckHostBlendAt(distance);
      if (blend <= 0) return 0;
      if (zone.kind === 'diverge') {
        const branchEnd = branchRows.at(-1).bS;
        if (distance > branchEnd) {
          const last = branchRows.at(-1);
          const ends = last.dyEnds || [last.dy, last.dy];
          const half = Math.max(0.01, last.half || zone.branch.halfWidth);
          const t = clamp((lateral + half) / (half * 2), 0, 1);
          const dy = ends[0] + (ends[1] - ends[0]) * t;
          return -dy * blend;
        }
        if (distance < branchRows[0].bS - 0.01) return 0;
        const branchFrame = map._frameAt(zone.branch, distance);
        const branchPoint = branchFrame.position.clone().addScaledVector(branchFrame.normal, lateral);
        branchPoint.y += Math.tan(branchFrame.bank) * lateral;
        const hostS = this.hostAtBranch(distance);
        const projection = map._projectToRoute(
          zone.host,
          branchPoint,
          map._hostSeedIndex(zone.host, hostS),
        );
        const hostDeckY = projection.point.y
          + Math.tan(map._bankAt(zone.host, projection.distance)) * projection.signedLateral;
        return (hostDeckY - branchPoint.y) * blend;
      }
      if (distance < branchRows[0].bS - 0.01 || distance > branchRows[branchRows.length - 1].bS + 0.01) return 0;
      let upper = 1;
      while (upper < branchRows.length && branchRows[upper].bS < distance) upper += 1;
      const right = branchRows[Math.min(upper, branchRows.length - 1)];
      const left = branchRows[Math.max(0, upper - 1)];
      const rowDy = (row) => {
        const ends = row.dyEnds || [row.dy, row.dy];
        const half = Math.max(0.01, row.half || zone.branch.halfWidth);
        const t = clamp((lateral + half) / (half * 2), 0, 1);
        return ends[0] + (ends[1] - ends[0]) * t;
      };
      const span = Math.max(1e-6, right.bS - left.bS);
      const t = clamp((distance - left.bS) / span, 0, 1);
      const dy = rowDy(left) + (rowDy(right) - rowDy(left)) * t;
      // dy is branch minus host. Moving by -dy lands the source deck on the
      // same banked plane as the widened host surface without a vertical lip.
      return -dy * blend;
    },
    phaseAtBranch(distance) {
      const hostS = this.hostAtBranch(distance);
      return hostS === null ? null : this.phaseAt(hostS);
    },
    phaseAt(distance) {
      const value = unwrappedHostDistance(zone, distance);
      if (value < openingStart) return 'approach';
      if (value < parallelStart) return 'opening';
      if (value < absorptionStart) return 'parallel';
      if (value < transitionEnd) return 'absorption';
      return 'finalized';
    },
    laneCountAt(distance) {
      const value = unwrappedHostDistance(zone, distance);
      if (threePlusTwoDiverge) {
        if (value < firstOpeningEnd) return 3;
        if (value < parallelStart) return 4;
        return 5;
      }
      if (!twoPlusThreeMerge) {
        return value < transitionEnd ? this.temporaryLaneCount : this.finalLaneCount;
      }
      if (value < firstAbsorptionEnd) return 5;
      if (value < transitionEnd) return 4;
      return 3;
    },
    widthFactorAt(distance) {
      const value = unwrappedHostDistance(zone, distance);
      if (value < approachStart || value > transitionEnd) return 0;
      if (threePlusTwoDiverge) return divergeEnvelopeFactorAt(value);
      if (value < openingStart) return 0;
      if (twoPlusThreeMerge && value <= parallelStart) {
        return mergeEnvelopeExtraAt(value) / targetExtraWidth;
      }
      if (value === openingStart) return 0;
      if (value < parallelStart) return quintic((value - openingStart) / (parallelStart - openingStart));
      // Once a diverge reaches full usable width it never closes on the host
      // side. The branch assumes ownership of that same corridor at the final
      // station; only stations beyond the transition return to the base host.
      if (zone.kind === 'diverge') return 1;
      if (value <= absorptionStart) return 1;
      if (twoPlusThreeMerge) {
        if (value < firstAbsorptionEnd) {
          const firstDrop = quintic((value - absorptionStart)
            / (firstAbsorptionEnd - absorptionStart));
          return 1 - firstDrop * 0.5;
        }
        if (value < secondAbsorptionStart) return 0.5;
        const secondDrop = quintic((value - secondAbsorptionStart)
          / (transitionEnd - secondAbsorptionStart));
        return (1 - secondDrop) * 0.5;
      }
      return 1 - quintic((value - absorptionStart) / (transitionEnd - absorptionStart));
    },
    boundaryLateralAt(distance) {
      const value = unwrappedHostDistance(zone, distance);
      const baseHalf = map._halfWidthAt(zone.host, map._normalizeDistance(zone.host, value));
      const baseEdgeLine = zone.side * (baseHalf - 0.75);
      const laneBoundary = zone.side * hostLaneEdge;
      if (value <= openingStart || value >= transitionEnd) return baseEdgeLine;
      if (value < parallelStart) {
        const factor = quintic((value - openingStart) / (parallelStart - openingStart));
        return baseEdgeLine + (laneBoundary - baseEdgeLine) * factor;
      }
      if (zone.kind === 'diverge') return laneBoundary;
      const boundaryCloseStart = twoPlusThreeMerge
        ? secondAbsorptionStart
        : absorptionStart;
      if (value <= boundaryCloseStart) return laneBoundary;
      const factor = quintic((value - boundaryCloseStart) / (transitionEnd - boundaryCloseStart));
      return laneBoundary + (baseEdgeLine - laneBoundary) * factor;
    },
    auxDividerLateralAt(distance) {
      const value = unwrappedHostDistance(zone, distance);
      const frame = map._frameAt(zone.host, map._normalizeDistance(zone.host, value));
      const stableEdgeLine = zone.side * (frame.half - 0.75);
      const divider = zone.side * (hostLaneEdge + auxiliaryWidth);
      if (value <= openingStart) return stableEdgeLine;
      if (value >= parallelStart) return divider;
      const factor = quintic((value - openingStart) / (parallelStart - openingStart));
      return stableEdgeLine + (divider - stableEdgeLine) * factor;
    },
    outerMarkingLateralAt(distance) {
      const envelope = this.envelopeAt(distance);
      return envelope.outerLateral - zone.side * 0.75;
    },
    envelopeAt(distance) {
      const value = unwrappedHostDistance(zone, distance);
      const baseHalf = map._halfWidthAt(zone.host, map._normalizeDistance(zone.host, value));
      const extra = targetExtraWidth * this.widthFactorAt(value);
      return {
        hostS: value,
        baseHalf,
        extra,
        lateralMin: zone.side > 0 ? -baseHalf : -baseHalf - extra,
        lateralMax: zone.side > 0 ? baseHalf + extra : baseHalf,
        outerLateral: zone.side * (baseHalf + extra),
        phase: this.phaseAt(value),
      };
    },
  };

  const hostDividerOffsets = map._laneDividerOffsets(zone.host);
  record.markingOwnership = [
    ...hostDividerOffsets.map((lateral, index) => ({
      id: `${record.id}:host-divider:${index}`,
      role: 'surviving-host-divider',
      lateral,
      owner: `route:${zone.host.id}`,
    })),
    {
      id: `${record.id}:aux-inner-boundary`,
      role: zone.kind === 'merge' ? 'absorbed-lane-boundary' : 'auxiliary-inner-boundary',
      lateral: zone.side * hostLaneEdge,
      owner: `progressive:${record.id}`,
    },
    ...(auxiliaryLaneCount > 1 ? [{
      id: `${record.id}:aux-divider-boundary`,
      role: zone.kind === 'merge'
        ? 'first-absorbed-lane-boundary'
        : 'exiting-carriageway-lane-divider',
      lateral: zone.side * (hostLaneEdge + auxiliaryWidth),
      owner: `progressive:${record.id}`,
    }] : []),
    ...(zone.kind === 'diverge' ? [{
      id: `${record.id}:aux-outer-boundary`,
      role: auxiliaryLaneCount > 1
        ? 'exiting-carriageway-outer-boundary'
        : 'auxiliary-outer-boundary-to-branch-divider',
      lateral: zone.side * (hostLaneEdge + auxiliaryTotalWidth),
      owner: `progressive:${record.id}`,
    }] : []),
    {
      id: `${record.id}:outer-edge`,
      role: 'progressive-outer-edge',
      lateral: 'paved-envelope',
      owner: `progressive:${record.id}`,
    },
    ...map._laneDividerOffsets(zone.branch).map((lateral, index) => ({
      id: `${record.id}:branch-divider:${index}`,
      role: zone.kind === 'diverge' ? 'forming-branch-divider' : 'superseded-branch-divider',
      lateral,
      owner: zone.kind === 'diverge' ? `progressive:${record.id}` : 'none',
    })),
  ];

  const sampleStep = 2;
  const sampleCount = Math.max(2, Math.ceil(length / sampleStep));
  const sampleStations = Array.from(
    { length: sampleCount + 1 },
    (_, index) => approachStart + length * index / sampleCount,
  );
  sampleStations.push(
    openingStart,
    parallelStart,
    absorptionStart,
    firstAbsorptionEnd,
    secondAbsorptionStart,
    twoPlusThreeMerge ? null : sourceTransitionEnd,
    exteriorHandoffRow?.hU,
    physicalSplitRow?.hU,
    transitionEnd,
  );
  if (twoPlusThreeMerge) {
    const openingSamples = Math.max(2, Math.ceil(targetExtraWidth / 0.25));
    for (let index = 1; index < openingSamples; index += 1) {
      sampleStations.push(
        openingStart + (parallelStart - openingStart) * index / openingSamples,
      );
    }
  }
  if (threePlusTwoDiverge) {
    sampleStations.push(
      firstOpeningEnd,
      secondOpeningStart,
      divergeHandoffStart,
      divergeHandoffComplete,
      railOpeningEnd,
    );
    // The whole 7.10 m is handed back over one short measured departure; sample
    // it at the same quarter-metre resolution the merge samples its opening.
    const departureSamples = Math.max(2, Math.ceil(targetExtraWidth / 0.25));
    for (let index = 1; index < departureSamples; index += 1) {
      sampleStations.push(
        divergeHandoffStart
        + (divergeHandoffComplete - divergeHandoffStart) * index / departureSamples,
      );
    }
  }
  sampleStations.sort((left, right) => left - right);
  const stations = sampleStations.filter((station, index) => (
    Number.isFinite(station) && (index === 0 || Math.abs(station - sampleStations[index - 1]) > 1e-4)
  ));
  const lanePaths = Array.from({ length: record.temporaryLaneCount }, (_, lane) => ({
    id: lane < zone.host.lanes ? `host:${lane}` : `aux:${lane - zone.host.lanes}`,
    outcome: lane < zone.host.lanes ? 'survives' : (zone.kind === 'merge' ? 'absorbed' : 'separates'),
    points: [],
  }));
  const boundaryPaths = [
    ...hostDividerOffsets.map((lateral, index) => ({ id: `host-divider:${index}`, lateral, points: [] })),
    { id: 'aux-inner-boundary', lateral: zone.side * hostLaneEdge, points: [] },
    ...(auxiliaryLaneCount > 1
      ? [{ id: 'aux-divider-boundary', lateral: zone.side * (hostLaneEdge + auxiliaryWidth), points: [] }]
      : []),
    ...(zone.kind === 'diverge' || twoPlusThreeMerge
      ? [{ id: 'aux-outer-boundary', lateral: zone.side * (hostLaneEdge + auxiliaryTotalWidth), points: [] }]
      : []),
    { id: 'outer-edge', lateral: null, points: [] },
  ];
  const markingPaths = zone.kind === 'diverge' ? [
    { id: 'aux-inner-marking', points: [] },
    ...(auxiliaryLaneCount > 1 ? [{ id: 'aux-divider-marking', points: [] }] : []),
    { id: 'aux-outer-marking', points: [] },
  ] : [];
  const conformToBranchDeck = (hostS, worldPoint, lift) => {
    const branchS = record.branchAtHost(hostS);
    if (branchS === null) return worldPoint;
    const projection = map._projectToRoute(
      zone.branch,
      worldPoint,
      map._hostSeedIndex(zone.branch, branchS),
    );
    const branchFrame = map._frameAt(zone.branch, projection.distance);
    const branchDeck = map._deckPoint(branchFrame, projection.signedLateral, lift);
    branchDeck.y += record.branchDeckOffsetAt(projection.distance, projection.signedLateral);
    worldPoint.y = branchDeck.y;
    return worldPoint;
  };
  const divergeExitPoint = (hostS, outwardOffset, lift) => {
    const centre = divergeHandoffPoint(
      hostS,
      parallelExitCentreLateral,
      branchExitCentreLateral,
      lift,
    );
    const startFrame = map._frameAt(zone.host, divergePathStart);
    const endFrame = map._frameAt(zone.branch, branchRows.at(-1).bS);
    const startOutward = startFrame.normal.clone().multiplyScalar(zone.side);
    const endOutward = endFrame.normal.clone().multiplyScalar(-zone.hostwardSign);
    startOutward.y = 0;
    endOutward.y = 0;
    startOutward.normalize();
    endOutward.normalize();
    const factor = quintic((hostS - divergePathStart)
      / Math.max(1e-6, transitionEnd - divergePathStart));
    const outward = startOutward.multiplyScalar(1 - factor)
      .add(endOutward.multiplyScalar(factor))
      .normalize();
    centre.addScaledVector(outward, outwardOffset);
    return conformToBranchDeck(hostS, centre, lift);
  };
  for (const hostS of stations) {
    const normalized = map._normalizeDistance(zone.host, hostS);
    const frame = map._frameAt(zone.host, normalized);
    const envelope = record.envelopeAt(hostS);
    const surfaceRow = {
      hostS,
      phase: envelope.phase,
      lateralMin: envelope.lateralMin,
      lateralMax: envelope.lateralMax,
      outerLateral: envelope.outerLateral,
      baseHalf: envelope.baseHalf,
      extraWidth: envelope.extra,
      lower: pointRecord(map._deckPoint(frame, envelope.lateralMin)),
      upper: pointRecord(map._deckPoint(frame, envelope.lateralMax)),
    };
    record.pavedEnvelope.push(surfaceRow);
    record.guardrailEnvelope.push({
      hostS,
      phase: envelope.phase,
      lateral: envelope.outerLateral,
      position: pointRecord(map._deckPoint(frame, envelope.outerLateral - zone.side * 0.42, 0.02)),
    });
    if (hostS >= openingStart && hostS <= transitionEnd) record.crossableEnvelope.push(surfaceRow);

    for (let lane = 0; lane < zone.host.lanes; lane += 1) {
      const lateral = map._laneOffset(zone.host, lane, 1);
      lanePaths[lane].points.push({ hostS, lateral, position: pointRecord(map._deckPoint(frame, lateral, 0.035)) });
    }
    const factor = record.widthFactorAt(hostS);
    const outerHostLane = zone.side > 0 ? 0 : zone.host.lanes - 1;
    const outerHostLateral = map._laneOffset(zone.host, outerHostLane, 1);
    const stableEdgeLine = zone.side * (frame.half - 0.75);
    for (let auxiliaryLane = 0; auxiliaryLane < auxiliaryLaneCount; auxiliaryLane += 1) {
      const fullLateral = zone.side * (
        hostLaneEdge + auxiliaryWidth * (auxiliaryLane + 0.5)
      );
      let lateral;
      let position;
      if (threePlusTwoDiverge) {
        const outwardOffset = -auxiliaryTotalWidth * 0.5
          + auxiliaryWidth * (auxiliaryLane + 0.5);
        if (hostS > divergeHandoffStart) {
          // The rigid pair leaves the slots exactly as the merge's arrives on
          // them; downstream of the measured handoff it IS the ramp's own
          // cross-section, so no separate rotation is invented.
          position = divergeHandoffGeometryAt(hostS, 0.035).pointAt(outwardOffset);
          lateral = position.clone().sub(frame.position).dot(frame.normal);
        } else {
          // Staged emergence: aux:0 grows out of the outer host lane, then
          // aux:1 grows out of aux:0's slot, each over one measured stage with
          // a full four-lane plateau between them.
          const innerAuxiliaryLateral = zone.side * (hostLaneEdge + auxiliaryWidth * 0.5);
          if (auxiliaryLane === 0) {
            const opening = quintic((hostS - openingStart)
              / Math.max(1e-6, firstOpeningEnd - openingStart));
            lateral = outerHostLateral + (innerAuxiliaryLateral - outerHostLateral) * opening;
          } else if (hostS <= secondOpeningStart) {
            const opening = quintic((hostS - openingStart)
              / Math.max(1e-6, firstOpeningEnd - openingStart));
            lateral = outerHostLateral + (innerAuxiliaryLateral - outerHostLateral) * opening;
          } else {
            const opening = quintic((hostS - secondOpeningStart)
              / Math.max(1e-6, parallelStart - secondOpeningStart));
            lateral = innerAuxiliaryLateral + (fullLateral - innerAuxiliaryLateral) * opening;
          }
          position = map._deckPoint(frame, lateral, 0.035);
        }
      } else if (zone.kind === 'diverge') {
        if (hostS > divergePathStart) {
          const outwardOffset = -auxiliaryTotalWidth * 0.5
            + auxiliaryWidth * (auxiliaryLane + 0.5);
          position = divergeExitPoint(hostS, outwardOffset, 0.035);
          lateral = position.clone().sub(frame.position).dot(frame.normal);
        } else {
          lateral = outerHostLateral + (fullLateral - outerHostLateral) * factor;
          position = map._deckPoint(frame, lateral, 0.035);
        }
      } else {
        if (twoPlusThreeMerge && hostS <= parallelStart) {
          // Follow the real ramp cross-section into the shared opening, then
          // transfer the pair as one rigid 7.10 m carriageway onto the two
          // temporary Wangan centres.  The two source lanes never converge.
          const geometry = mergeHandoffGeometryAt(hostS, 0.035);
          const outwardOffset = -auxiliaryTotalWidth * 0.5
            + auxiliaryWidth * (auxiliaryLane + 0.5);
          position = geometry.pointAt(outwardOffset);
          lateral = position.clone().sub(frame.position).dot(frame.normal);
        } else {
          lateral = outerHostLateral + (fullLateral - outerHostLateral) * factor;
        }
        if (twoPlusThreeMerge && hostS > parallelStart) {
          // Once the five-lane section is established, do not derive lane
          // centres from the shrinking outer envelope: doing so pinches both
          // ramp lanes at once. Hold normal 3.55 m centres, merge aux:1 into
          // aux:0, retain a real four-lane plateau, then merge aux:0 into the
          // stable outer Wangan lane.
          lateral = fullLateral;
          if (hostS < absorptionStart) {
            const outwardOffset = -auxiliaryTotalWidth * 0.5
              + auxiliaryWidth * (auxiliaryLane + 0.5);
            position = mergeFullFiveAlignmentAt(hostS, outwardOffset, 0.035);
            lateral = position.clone().sub(frame.position).dot(frame.normal);
          }
          if (auxiliaryLane === 1 && hostS > absorptionStart) {
            const firstConvergence = quintic((hostS - absorptionStart)
              / (firstAbsorptionEnd - absorptionStart));
            const innerAuxiliaryLateral = zone.side * (hostLaneEdge + auxiliaryWidth * 0.5);
            lateral += (innerAuxiliaryLateral - lateral) * firstConvergence;
          }
          if (hostS > secondAbsorptionStart) {
            const secondConvergence = quintic((hostS - secondAbsorptionStart)
              / (transitionEnd - secondAbsorptionStart));
            if (auxiliaryLane === 1) {
              lateral = zone.side * (hostLaneEdge + auxiliaryWidth * 0.5);
            }
            lateral += (outerHostLateral - lateral) * secondConvergence;
          }
        } else if (!twoPlusThreeMerge && hostS > absorptionStart) {
          const convergence = quintic((hostS - absorptionStart) / (transitionEnd - absorptionStart));
          lateral += (outerHostLateral - lateral) * convergence;
        }
        if (!position) position = map._deckPoint(frame, lateral, 0.035);
      }
      lanePaths[zone.host.lanes + auxiliaryLane].points.push({
        hostS,
        lateral,
        position: pointRecord(position),
      });
    }
    for (const boundary of boundaryPaths) {
      const boundaryIndex = boundary.id === 'aux-inner-boundary'
        ? 0
        : (boundary.id === 'aux-divider-boundary'
          ? 1
          : (boundary.id === 'aux-outer-boundary' ? auxiliaryLaneCount : null));
      const fullBoundaryLateral = boundaryIndex === null
        ? null
        : zone.side * (hostLaneEdge + auxiliaryWidth * boundaryIndex);
      let lateral = boundary.id === 'outer-edge'
        ? envelope.outerLateral
        : (boundaryIndex === null
          ? boundary.lateral
          : stableEdgeLine + (fullBoundaryLateral - stableEdgeLine) * factor);
      let boundaryPosition = map._deckPoint(frame, lateral, 0.04);
      const branchS = zone.kind === 'diverge' || twoPlusThreeMerge
        ? record.branchAtHost(hostS)
        : null;
      if (threePlusTwoDiverge && boundaryIndex !== null) {
        const innerLateral = zone.side * hostLaneEdge;
        const dividerLateral = zone.side * (hostLaneEdge + auxiliaryWidth);
        const outerLateral = zone.side * (hostLaneEdge + auxiliaryTotalWidth);
        if (hostS > divergeHandoffStart) {
          const outwardOffset = -auxiliaryTotalWidth * 0.5 + auxiliaryWidth * boundaryIndex;
          boundaryPosition = divergeHandoffGeometryAt(hostS, 0.04).pointAt(outwardOffset);
          lateral = boundaryPosition.clone().sub(frame.position).dot(frame.normal);
        } else {
          // Before the widening every temporary boundary is still the host's
          // own edge line; each becomes a real line only as its lane opens.
          const firstOpening = quintic((hostS - openingStart)
            / Math.max(1e-6, firstOpeningEnd - openingStart));
          const secondOpening = quintic((hostS - secondOpeningStart)
            / Math.max(1e-6, parallelStart - secondOpeningStart));
          if (boundaryIndex === 0) {
            lateral = stableEdgeLine + (innerLateral - stableEdgeLine) * firstOpening;
          } else if (boundaryIndex === 1) {
            lateral = stableEdgeLine + (dividerLateral - stableEdgeLine) * firstOpening;
          } else if (hostS <= secondOpeningStart) {
            lateral = stableEdgeLine + (dividerLateral - stableEdgeLine) * firstOpening;
          } else {
            lateral = dividerLateral + (outerLateral - dividerLateral) * secondOpening;
          }
          boundaryPosition = map._deckPoint(frame, lateral, 0.04);
        }
      } else if (twoPlusThreeMerge && boundaryIndex !== null && hostS <= parallelStart) {
        const geometry = mergeHandoffGeometryAt(hostS, 0.04);
        const outwardOffset = -auxiliaryTotalWidth * 0.5 + auxiliaryWidth * boundaryIndex;
        boundaryPosition = geometry.pointAt(outwardOffset);
        lateral = boundaryPosition.clone().sub(frame.position).dot(frame.normal);
      } else if (twoPlusThreeMerge && boundaryIndex !== null) {
        const innerLateral = zone.side * hostLaneEdge;
        const dividerLateral = zone.side * (hostLaneEdge + auxiliaryWidth);
        const outerLateral = zone.side * (hostLaneEdge + auxiliaryTotalWidth);
        if (hostS < absorptionStart) {
          const outwardOffset = -auxiliaryTotalWidth * 0.5
            + auxiliaryWidth * boundaryIndex;
          boundaryPosition = mergeFullFiveAlignmentAt(hostS, outwardOffset, 0.04);
          lateral = boundaryPosition.clone().sub(frame.position).dot(frame.normal);
        } else if (boundaryIndex === 0) {
          lateral = innerLateral;
        } else if (boundaryIndex === 1) {
          const convergence = quintic((hostS - secondAbsorptionStart)
            / (transitionEnd - secondAbsorptionStart));
          lateral = dividerLateral + (innerLateral - dividerLateral) * convergence;
        } else if (hostS <= absorptionStart) {
          lateral = outerLateral;
        } else if (hostS < firstAbsorptionEnd) {
          const convergence = quintic((hostS - absorptionStart)
            / (firstAbsorptionEnd - absorptionStart));
          lateral = outerLateral + (dividerLateral - outerLateral) * convergence;
        } else if (hostS <= secondAbsorptionStart) {
          lateral = dividerLateral;
        } else {
          const convergence = quintic((hostS - secondAbsorptionStart)
            / (transitionEnd - secondAbsorptionStart));
          lateral = dividerLateral + (innerLateral - dividerLateral) * convergence;
        }
        if (hostS >= absorptionStart) {
          boundaryPosition = map._deckPoint(frame, lateral, 0.04);
        }
      } else if (branchS !== null && boundaryIndex !== null && hostS > divergePathStart) {
        const outwardOffset = -auxiliaryTotalWidth * 0.5 + auxiliaryWidth * boundaryIndex;
        boundaryPosition = divergeExitPoint(hostS, outwardOffset, 0.04);
        lateral = boundaryPosition.clone().sub(frame.position).dot(frame.normal);
      } else if (zone.kind === 'diverge' && !threePlusTwoDiverge
        && branchS !== null && boundary.id === 'outer-edge'
        && hostS >= exteriorHandoffRow.hU) {
        const branchFrame = map._frameAt(zone.branch, branchS);
        const branchHalf = map._halfWidthAt(zone.branch, branchS);
        boundaryPosition = map._deckPoint(branchFrame, -zone.hostwardSign * branchHalf, 0.04);
        lateral = boundaryPosition.clone().sub(frame.position).dot(frame.normal);
      }
      boundary.points.push({ hostS, branchS, lateral, position: pointRecord(boundaryPosition) });
    }
    if (zone.kind === 'diverge') {
      const branchS = record.branchAtHost(hostS);
      const innerMarking = markingPaths.find((path) => path.id === 'aux-inner-marking');
      const dividerMarking = markingPaths.find((path) => path.id === 'aux-divider-marking');
      const outerMarking = markingPaths.find((path) => path.id === 'aux-outer-marking');
      const innerBoundary = boundaryPaths.find((path) => path.id === 'aux-inner-boundary').points.at(-1);
      const dividerBoundary = boundaryPaths.find((path) => path.id === 'aux-divider-boundary')?.points.at(-1);
      const outerBoundary = boundaryPaths.find((path) => path.id === 'aux-outer-boundary').points.at(-1);
      const boundaryDx = outerBoundary.position.x - innerBoundary.position.x;
      const boundaryDz = outerBoundary.position.z - innerBoundary.position.z;
      const boundaryLength = Math.hypot(boundaryDx, boundaryDz);
      const outwardX = boundaryLength > 1e-5
        ? boundaryDx / boundaryLength
        : frame.normal.x * zone.side;
      const outwardZ = boundaryLength > 1e-5
        ? boundaryDz / boundaryLength
        : frame.normal.z * zone.side;
      const handoffFactor = threePlusTwoDiverge
        ? quintic((hostS - divergeHandoffStart)
          / Math.max(1e-6, divergeHandoffComplete - divergeHandoffStart))
        : quintic((hostS - exteriorHandoffRow.hU)
          / Math.max(1e-6, transitionEnd - exteriorHandoffRow.hU));
      const markingShoulder = auxiliaryMarkingShoulder * factor;
      // Both exiting lanes retain their physical 3.55 m width. The exterior
      // solid remains outside the outer lane for the whole transition; it no
      // longer sheds its shoulder offset and cannot become the branch divider.
      // The hostward shoulder appears only as that side becomes a branch edge.
      let innerOffset = markingShoulder * handoffFactor;
      let outerOffset = twoPlusTwo
        ? markingShoulder
        : markingShoulder * (1 - handoffFactor);
      if (threePlusTwoDiverge) {
        // The dashed hostward line lands exactly on the ramp's own edge line at
        // the end of the departure, so the branch's route-local paint takes over
        // without a step. The solid exterior is 0.75 m inside whichever paved
        // edge owns it: the widened host deck's, then the ramp's own.
        innerOffset = auxiliaryMarkingShoulder * handoffFactor;
        const firstOpening = quintic((hostS - openingStart)
          / Math.max(1e-6, firstOpeningEnd - openingStart));
        outerOffset = hostEdgeMarkingShoulder * firstOpening * (1 - handoffFactor)
          + branchEdgeMarkingShoulder * handoffFactor;
      }
      const innerPosition = pointRecord({
        x: innerBoundary.position.x - outwardX * innerOffset,
        y: innerBoundary.position.y + 0.015,
        z: innerBoundary.position.z - outwardZ * innerOffset,
      });
      const outerPosition = pointRecord({
        x: outerBoundary.position.x + outwardX * outerOffset,
        y: outerBoundary.position.y + 0.015,
        z: outerBoundary.position.z + outwardZ * outerOffset,
      });
      const innerLateral = innerPosition.x * frame.normal.x
        + innerPosition.z * frame.normal.z
        - frame.position.x * frame.normal.x
        - frame.position.z * frame.normal.z;
      const outerLateral = outerPosition.x * frame.normal.x
        + outerPosition.z * frame.normal.z
        - frame.position.x * frame.normal.x
        - frame.position.z * frame.normal.z;
      innerMarking.points.push({
        hostS,
        branchS,
        lateral: innerLateral,
        position: innerPosition,
      });
      if (dividerMarking && dividerBoundary) {
        const dividerPosition = pointRecord({
          x: dividerBoundary.position.x,
          y: dividerBoundary.position.y + 0.015,
          z: dividerBoundary.position.z,
        });
        dividerMarking.points.push({
          hostS,
          branchS,
          lateral: dividerPosition.x * frame.normal.x
            + dividerPosition.z * frame.normal.z
            - frame.position.x * frame.normal.x
            - frame.position.z * frame.normal.z,
          position: dividerPosition,
        });
      }
      outerMarking.points.push({
        hostS,
        branchS,
        lateral: outerLateral,
        position: outerPosition,
      });
    }
  }
  record.laneCentres = lanePaths;
  record.laneBoundaries = boundaryPaths;
  record.markingPaths = markingPaths;
  const auxInnerBoundaryPath = boundaryPaths.find((boundary) => boundary.id === 'aux-inner-boundary');
  const auxDividerBoundaryPath = boundaryPaths.find((boundary) => boundary.id === 'aux-divider-boundary');
  const auxOuterBoundaryPath = boundaryPaths.find((boundary) => boundary.id === 'aux-outer-boundary');
  const pathSampleAtHost = (path, distance) => {
    const hostS = unwrappedHostDistance(zone, distance);
    const points = path.points;
    let upper = 1;
    while (upper < points.length && points[upper].hostS < hostS) upper += 1;
    if (upper >= points.length) return { ...points.at(-1), position: { ...points.at(-1).position } };
    const left = points[upper - 1];
    const right = points[upper];
    const t = clamp((hostS - left.hostS) / Math.max(1e-6, right.hostS - left.hostS), 0, 1);
    return {
      hostS,
      branchS: left.branchS === null || right.branchS === null
        ? null
        : left.branchS + (right.branchS - left.branchS) * t,
      lateral: left.lateral + (right.lateral - left.lateral) * t,
      position: {
        x: left.position.x + (right.position.x - left.position.x) * t,
        y: left.position.y + (right.position.y - left.position.y) * t,
        z: left.position.z + (right.position.z - left.position.z) * t,
      },
    };
  };
  const pathLateralAtBranch = (path, distance) => {
    const hostS = record.hostAtBranch(distance);
    if (hostS === null) return null;
    const sample = pathSampleAtHost(path, hostS);
    const world = map._frameAt(zone.branch, distance).position.clone().set(
      sample.position.x,
      sample.position.y,
      sample.position.z,
    );
    const branchFrame = map._frameAt(zone.branch, distance);
    return world.sub(branchFrame.position).dot(branchFrame.normal);
  };
  record.auxInnerBoundaryPointAt = (distance) => pathSampleAtHost(auxInnerBoundaryPath, distance);
  record.auxOuterBoundaryPointAt = (distance) => pathSampleAtHost(
    auxOuterBoundaryPath || auxInnerBoundaryPath,
    distance,
  );
  if (auxDividerBoundaryPath) {
    record.auxDividerBoundaryPointAt = (distance) => pathSampleAtHost(
      auxDividerBoundaryPath,
      distance,
    );
    record.auxDividerBoundaryLateralAt = (distance) => pathSampleAtHost(
      auxDividerBoundaryPath,
      distance,
    ).lateral;
    record.auxDividerBoundaryBranchLateralAt = (distance) => pathLateralAtBranch(
      auxDividerBoundaryPath,
      distance,
    );
  }
  record.auxInnerBoundaryLateralAt = (distance) => pathSampleAtHost(
    auxInnerBoundaryPath,
    distance,
  ).lateral;
  record.auxOuterBoundaryLateralAt = (distance) => pathSampleAtHost(
    auxOuterBoundaryPath || auxInnerBoundaryPath,
    distance,
  ).lateral;
  record.auxInnerBoundaryBranchLateralAt = (distance) => pathLateralAtBranch(
    auxInnerBoundaryPath,
    distance,
  );
  record.auxOuterBoundaryBranchLateralAt = (distance) => pathLateralAtBranch(
    auxOuterBoundaryPath || auxInnerBoundaryPath,
    distance,
  );
  // Compatibility aliases retain the pre-C2 API while making the inner
  // boundary choice explicit for new rendering/probes.
  record.auxBoundaryLateralAt = record.auxInnerBoundaryLateralAt;
  record.auxBoundaryBranchLateralAt = record.auxInnerBoundaryBranchLateralAt;
  if (twoPlusThreeMerge) {
    // Host-owned paint follows the same world-space boundaries as the two
    // ramp-origin lanes.  Before OPENING the normal Wangan edge remains; from
    // OPENING onward the inner/divider/outer paths are the sole owners.
    record.boundaryLateralAt = (distance) => {
      const value = unwrappedHostDistance(zone, distance);
      if (value <= parallelStart) return record.auxInnerBoundaryLateralAt(value);
      const frame = map._frameAt(zone.host, map._normalizeDistance(zone.host, value));
      const laneBoundary = zone.side * hostLaneEdge;
      if (value <= secondAbsorptionStart) return laneBoundary;
      const baseEdgeLine = zone.side * (frame.half - 0.75);
      const factor = quintic((value - secondAbsorptionStart)
        / (transitionEnd - secondAbsorptionStart));
      return laneBoundary + (baseEdgeLine - laneBoundary) * factor;
    };
    record.auxDividerLateralAt = record.auxDividerBoundaryLateralAt;
    record.outerMarkingLateralAt = (distance) => {
      const value = unwrappedHostDistance(zone, distance);
      const frame = map._frameAt(zone.host, map._normalizeDistance(zone.host, value));
      const baseEdgeLine = zone.side * (frame.half - 0.75);
      if (value < openingStart || value >= transitionEnd) return baseEdgeLine;
      const outer = pathSampleAtHost(auxOuterBoundaryPath, value);
      const handoffFactor = value < parallelStart
        ? mergeHandoffGeometryAt(value).factor
        : 1;
      const shoulder = branchEdgeMarkingShoulder
        + (hostEdgeMarkingShoulder - branchEdgeMarkingShoulder) * handoffFactor;
      return outer.lateral + zone.side * shoulder;
    };
  }
  if (zone.kind === 'diverge') {
    const innerMarkingPath = markingPaths.find((path) => path.id === 'aux-inner-marking');
    const dividerMarkingPath = markingPaths.find((path) => path.id === 'aux-divider-marking');
    const outerMarkingPath = markingPaths.find((path) => path.id === 'aux-outer-marking');
    record.auxInnerMarkingLateralAt = (distance) => pathSampleAtHost(
      innerMarkingPath,
      distance,
    ).lateral;
    record.auxOuterMarkingLateralAt = (distance) => pathSampleAtHost(
      outerMarkingPath,
      distance,
    ).lateral;
    record.auxInnerMarkingBranchLateralAt = (distance) => pathLateralAtBranch(
      innerMarkingPath,
      distance,
    );
    record.auxOuterMarkingBranchLateralAt = (distance) => pathLateralAtBranch(
      outerMarkingPath,
      distance,
    );
    if (dividerMarkingPath) {
      record.auxDividerMarkingLateralAt = (distance) => pathSampleAtHost(
        dividerMarkingPath,
        distance,
      ).lateral;
      record.auxDividerMarkingBranchLateralAt = (distance) => pathLateralAtBranch(
        dividerMarkingPath,
        distance,
      );
    }
    record.settledBranchInnerMarkingLateralAt = (distance) => {
      const start = branchFeedInnerMarkingLateral;
      const standard = zone.hostwardSign * (map._halfWidthAt(zone.branch, distance) - 0.75);
      if (distance <= record.transferCompleteBranch) return start;
      if (distance >= record.markingSettleEnd) return standard;
      const factor = quintic((distance - record.transferCompleteBranch)
        / (record.markingSettleEnd - record.transferCompleteBranch));
      return start + (standard - start) * factor;
    };
  }
  if (zone.kind === 'diverge') {
    record.auxiliaryCorridor = stations
      .filter((hostS) => hostS >= parallelStart - 1e-4)
      .map((hostS) => {
        const inner = pathSampleAtHost(auxInnerBoundaryPath, hostS);
        const outer = pathSampleAtHost(auxOuterBoundaryPath, hostS);
        const width = Math.hypot(
          inner.position.x - outer.position.x,
          inner.position.z - outer.position.z,
        );
        return {
          hostS,
          branchS: record.branchAtHost(hostS),
          ownership: hostS >= (threePlusTwoDiverge ? divergeHandoffComplete : transitionEnd) - 1e-4
            ? 'branch'
            : (hostS >= exteriorHandoffRow.hU ? 'shared' : 'host'),
          width,
          inner: inner.position,
          outer: outer.position,
          centre: {
            x: (inner.position.x + outer.position.x) * 0.5,
            y: (inner.position.y + outer.position.y) * 0.5,
            z: (inner.position.z + outer.position.z) * 0.5,
          },
        };
      });
    const exitBoundaryPaths = [
      auxInnerBoundaryPath,
      ...(auxDividerBoundaryPath ? [auxDividerBoundaryPath] : []),
      auxOuterBoundaryPath,
    ];
    record.auxiliaryLaneCorridors = Array.from(
      { length: auxiliaryLaneCount },
      (_, lane) => stations
        .filter((hostS) => hostS >= parallelStart - 1e-4)
        .map((hostS) => {
          const inner = pathSampleAtHost(exitBoundaryPaths[lane], hostS);
          const outer = pathSampleAtHost(exitBoundaryPaths[lane + 1], hostS);
          return {
            id: `aux:${lane}`,
            hostS,
            branchS: record.branchAtHost(hostS),
            ownership: hostS >= (threePlusTwoDiverge ? divergeHandoffComplete : transitionEnd) - 1e-4
              ? `branch:${branchExitLanes[lane]}`
              : (hostS >= exteriorHandoffRow.hU ? 'shared' : 'host'),
            width: Math.hypot(
              inner.position.x - outer.position.x,
              inner.position.z - outer.position.z,
            ),
            inner: inner.position,
            outer: outer.position,
            centre: {
              x: (inner.position.x + outer.position.x) * 0.5,
              y: (inner.position.y + outer.position.y) * 0.5,
              z: (inner.position.z + outer.position.z) * 0.5,
            },
          };
        }),
    );
  }
  if (twoPlusThreeMerge) {
    const mergeBoundaryPaths = [
      auxInnerBoundaryPath,
      auxDividerBoundaryPath,
      auxOuterBoundaryPath,
    ];
    const ownershipAt = (hostS) => {
      if (hostS < parallelStart - 1e-4) return 'branch-to-host-handoff';
      if (hostS < absorptionStart - 1e-4) return 'temporary-five-lane';
      if (hostS < firstAbsorptionEnd - 1e-4) return 'first-absorption-5-to-4';
      if (hostS < secondAbsorptionStart - 1e-4) return 'temporary-four-lane';
      if (hostS < transitionEnd - 1e-4) return 'second-absorption-4-to-3';
      return 'stable-three-lane';
    };
    const corridorStations = stations.filter((hostS) => (
      hostS >= openingStart - 1e-4 && hostS <= transitionEnd + 1e-4
    ));
    record.auxiliaryCorridor = corridorStations.map((hostS) => {
      const inner = pathSampleAtHost(auxInnerBoundaryPath, hostS);
      const outer = pathSampleAtHost(auxOuterBoundaryPath, hostS);
      return {
        hostS,
        branchS: record.branchAtHost(hostS),
        ownership: ownershipAt(hostS),
        width: distanceBetween(inner.position, outer.position),
        inner: inner.position,
        outer: outer.position,
        centre: {
          x: (inner.position.x + outer.position.x) * 0.5,
          y: (inner.position.y + outer.position.y) * 0.5,
          z: (inner.position.z + outer.position.z) * 0.5,
        },
      };
    });
    record.auxiliaryLaneCorridors = Array.from({ length: auxiliaryLaneCount }, (_, lane) => (
      corridorStations.map((hostS) => {
        const inner = pathSampleAtHost(mergeBoundaryPaths[lane], hostS);
        const outer = pathSampleAtHost(mergeBoundaryPaths[lane + 1], hostS);
        return {
          id: `aux:${lane}`,
          hostS,
          branchS: record.branchAtHost(hostS),
          ownership: ownershipAt(hostS),
          width: distanceBetween(inner.position, outer.position),
          inner: inner.position,
          outer: outer.position,
          centre: {
            x: (inner.position.x + outer.position.x) * 0.5,
            y: (inner.position.y + outer.position.y) * 0.5,
            z: (inner.position.z + outer.position.z) * 0.5,
          },
        };
      })
    ));
  }
  record.branchLaneCentres = Array.from({ length: zone.branch.lanes }, (_, lane) => ({
    id: `branch:${lane}`,
    outcome: branchExitLanes.includes(lane) ? 'fed-by-auxiliary' : 'forms-with-branch',
    points: branchRows.map((row) => ({
      branchS: row.bS,
      hostS: row.hU,
      lateral: map._laneOffset(zone.branch, lane, 1),
      position: pointRecord(map._deckPoint(row.frame, map._laneOffset(zone.branch, lane, 1), 0.035)),
    })),
  }));
  record.branchGuardrailEnvelope = branchRows
    .filter((row) => row.bS >= exteriorHandoffRow?.bS)
    .map((row) => {
      const lateral = -zone.hostwardSign * map._halfWidthAt(zone.branch, row.bS);
      return {
        branchS: row.bS,
        hostS: row.hU,
        role: 'branch-exterior',
        lateral,
        position: pointRecord(map._deckPoint(row.frame, lateral + zone.hostwardSign * 0.42, 0.02)),
      };
    });
  record.worldBounds = record.pavedEnvelope.reduce((bounds, row) => ({
    minX: Math.min(bounds.minX, row.lower.x, row.upper.x),
    maxX: Math.max(bounds.maxX, row.lower.x, row.upper.x),
    minZ: Math.min(bounds.minZ, row.lower.z, row.upper.z),
    maxZ: Math.max(bounds.maxZ, row.lower.z, row.upper.z),
  }), { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity });
  return record;
}

export function buildProgressiveTransitions(map, prototypes) {
  map.progressiveCandidateClassifications = [];
  if (map.options.progressiveMerges === false) return [];
  const records = [];
  for (const prototype of prototypes) {
    const zone = map.junctionZones.find((candidate) => candidate.id === prototype.id);
    if (!zone) throw new Error(`Progressive prototype junction not found: ${prototype.id}`);
    if (zone.host.id !== prototype.hostRouteId
      || zone.branch.id !== prototype.branchRouteId
      || zone.kind !== prototype.type
      || zone.which !== prototype.which) {
      throw new Error(`Progressive prototype identity drift: ${prototype.id}`);
    }
    // A declared topology is a contract, not a hint: silently falling back to
    // the generic single-auxiliary model would hide a lane-count change in the
    // source network behind a still-passing build.
    const appendedPairHostLanes = APPENDED_PAIR_MERGE_HOST_LANES[prototype.topology];
    if (appendedPairHostLanes !== undefined
      && !(zone.kind === 'merge' && zone.host.lanes === appendedPairHostLanes && zone.branch.lanes === 2)) {
      throw new Error(`Progressive prototype topology drift: ${prototype.id}`);
    }
    if (prototype.topology === '3+2-diverge'
      && !(zone.kind === 'diverge' && zone.host.lanes === 3 && zone.branch.lanes === 2)) {
      throw new Error(`Progressive prototype topology drift: ${prototype.id}`);
    }
    const measuredClassification = classifyProgressiveJunction(map, zone);
    const classification = prototype.approvedSameLevel && !measuredClassification.eligible
      ? {
        ...measuredClassification,
        category: 'same-level-approved',
        eligible: true,
        reason: prototype.approvalReason,
        measuredCategory: measuredClassification.category,
        measuredReason: measuredClassification.reason,
      }
      : measuredClassification;
    const candidate = {
      ...prototype,
      pin: { ...prototype.pin },
      classification,
      active: false,
      side: zone.side > 0 ? 'right' : 'left',
      sideSign: zone.side,
      hostLaneCount: zone.host.lanes,
      branchLaneCount: zone.branch.lanes,
      distance: zone.hostRef,
      sourceZone: zone,
      transition: null,
    };
    map.progressiveCandidateClassifications.push(candidate);
    zone.progressiveClassification = classification;
    if (!classification.eligible) continue;
    const record = buildRecord(map, zone, prototype);
    record.classification = classification;
    zone.progressive = record;
    if (!zone.host._progressiveTransitionsAsHost) zone.host._progressiveTransitionsAsHost = [];
    if (!zone.branch._progressiveTransitionsAsBranch) zone.branch._progressiveTransitionsAsBranch = [];
    zone.host._progressiveTransitionsAsHost.push(record);
    zone.branch._progressiveTransitionsAsBranch.push(record);
    candidate.active = true;
    candidate.distance = (record.parallelStart + record.absorptionStart) * 0.5;
    candidate.transition = record;
    records.push(record);
  }
  return records;
}
