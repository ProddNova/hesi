/**
 * Shared progressive same-level transition model.
 *
 * This module owns phase order, paved/crossable envelopes, temporary lane
 * topology, marking ownership and the guardrail envelope. Rendering, physics,
 * developer diagnostics and probes consume the records; none re-derive phase
 * boundaries independently.
 */

import { classifyProgressiveJunction } from './progressive-junction-classifier.js';

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

function unwrappedHostDistance(zone, distance) {
  if (!zone.host.closed) return distance;
  let delta = distance - zone.hostRef;
  delta -= Math.round(delta / zone.host.length) * zone.host.length;
  return zone.hostRef + delta;
}

function laneMappings(zone, branchFeedLane = 0) {
  const { host, branch, kind, side } = zone;
  const outerHostLane = side > 0 ? 0 : host.lanes - 1;
  const mappings = Array.from({ length: host.lanes }, (_, lane) => ({
    source: `host:${lane}`,
    temporary: `host:${lane}`,
    final: `host:${lane}`,
    outcome: 'survives',
  }));
  if (kind === 'merge') {
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
  } else {
    mappings.push({
      source: `host:${outerHostLane}`,
      temporary: 'aux:0',
      final: `branch:${branchFeedLane}`,
      outcome: 'splits-to-branch',
    });
    for (let lane = 0; lane < branch.lanes; lane += 1) {
      if (lane === branchFeedLane) continue;
      mappings.push({
        source: 'aux:0',
        temporary: 'aux:0',
        final: `branch:${lane}`,
        outcome: 'opens-progressively',
      });
    }
  }
  return mappings;
}

function buildRecord(map, zone, prototype) {
  const rows = [...zone.samples].sort((left, right) => left.hU - right.hU);
  const branchRows = [...zone.samples].sort((left, right) => left.bS - right.bS);
  const approachStart = rows[0].hU;
  const transitionEnd = rows[rows.length - 1].hU;
  const length = transitionEnd - approachStart;
  const compatible = rows.filter((row) => Math.abs(row.dy) <= 0.75);
  const compatibleStart = compatible.length ? compatible[0].hU : approachStart + length * 0.14;
  const compatibleEnd = compatible.length ? compatible[compatible.length - 1].hU : transitionEnd - length * 0.14;
  const openingStart = zone.kind === 'merge'
    ? clamp(Math.max(approachStart + length * 0.12, compatibleStart), approachStart + 12, transitionEnd - 72)
    : clamp(approachStart + length * 0.12, approachStart + 12, compatibleEnd - 64);
  const parallelStart = clamp(
    Math.max(openingStart + 30, approachStart + length * 0.32),
    openingStart + 28,
    transitionEnd - 48,
  );
  const hostLaneEdge = zone.host.lanes * zone.host.laneWidth * 0.5;
  const auxiliaryWidth = zone.host.laneWidth;
  const targetExtraWidth = auxiliaryWidth + Math.max(0.8, zone.host.shoulder || 1.0);
  const parallelAuxLateral = zone.side * (hostLaneEdge + auxiliaryWidth * 0.5);
  const branchFeedLane = zone.kind === 'diverge'
    ? Array.from({ length: zone.branch.lanes }, (_, lane) => lane).sort((left, right) => (
      zone.hostwardSign * map._laneOffset(zone.branch, right, 1)
      - zone.hostwardSign * map._laneOffset(zone.branch, left, 1)
    ))[0]
    : 0;
  const branchFeedLateral = map._laneOffset(zone.branch, branchFeedLane, 1);
  const branchFeedOutwardAt = (row) => {
    const target = map._deckPoint(row.frame, branchFeedLateral);
    const projection = map._projectToRoute(zone.host, target, map._hostSeedIndex(zone.host, row.hS));
    return zone.side * projection.signedLateral;
  };
  const alignmentRow = zone.kind === 'diverge'
    ? branchRows.find((row) => branchFeedOutwardAt(row) >= Math.abs(parallelAuxLateral) - 0.05) || branchRows.at(-1)
    : null;
  const physicalSplitRow = zone.kind === 'diverge'
    ? branchRows.find((row) => row.innerEdge >= row.hostHalf - 0.3) || branchRows.at(-1)
    : null;
  const exteriorHandoffRow = zone.kind === 'diverge'
    ? branchRows.find((row) => row.unionOuter >= row.hostHalf + targetExtraWidth - 0.1) || physicalSplitRow
    : null;
  const goreStartRow = zone.kind === 'diverge'
    ? branchRows.find((row) => row.innerEdge >= row.hostHalf + 1.5) || branchRows.at(-1)
    : null;
  let absorptionStart = clamp(
    Math.min(approachStart + length * 0.68, compatibleEnd - 8),
    parallelStart + 24,
    transitionEnd - 24,
  );
  if (zone.kind === 'diverge') {
    absorptionStart = clamp(alignmentRow.hU, parallelStart + 4, transitionEnd - 4);
  }
  const divergeHandoffPoint = (hostS, startLateral, branchLateral, lift = 0.035) => {
    const startS = exteriorHandoffRow.hU;
    const endS = transitionEnd;
    const startFrame = map._frameAt(zone.host, startS);
    const endFrame = map._frameAt(zone.branch, branchRows.at(-1).bS);
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
    absorptionStart,
    transitionEnd,
    alignmentStart: zone.kind === 'diverge' ? absorptionStart : null,
    laneHandoffStart: exteriorHandoffRow?.hU ?? null,
    physicalSplitStart: physicalSplitRow?.hU ?? null,
    exteriorHandoffStart: exteriorHandoffRow?.hU ?? null,
    goreStart: goreStartRow?.hU ?? null,
    alignmentBranchStart: alignmentRow?.bS ?? null,
    physicalSplitBranchStart: physicalSplitRow?.bS ?? null,
    exteriorHandoffBranchStart: exteriorHandoffRow?.bS ?? null,
    goreBranchStart: goreStartRow?.bS ?? null,
    length,
    phaseOrder: [...PROGRESSIVE_PHASES],
    hostLaneCount: zone.host.lanes,
    branchLaneCount: zone.branch.lanes,
    temporaryLaneCount: zone.host.lanes + 1,
    finalLaneCount: zone.kind === 'diverge' ? zone.host.lanes + zone.branch.lanes : zone.host.lanes,
    finalHostLaneCount: zone.host.lanes,
    finalBranchLaneCount: zone.kind === 'diverge' ? zone.branch.lanes : 0,
    auxiliaryLaneCount: 1,
    auxiliaryWidth,
    targetExtraWidth,
    branchInterval: [...zone.branchSpan],
    hostInterval: [approachStart, transitionEnd],
    crossableInterval: [openingStart, transitionEnd],
    laneMappings: laneMappings(zone, branchFeedLane),
    branchFeedLane,
    survivingLanes: Array.from({ length: zone.host.lanes }, (_, lane) => `host:${lane}`),
    absorbedLanes: zone.kind === 'merge' ? ['aux:0'] : [],
    separatedLanes: zone.kind === 'diverge' ? ['aux:0'] : [],
    laneCentres: [],
    laneBoundaries: [],
    branchLaneCentres: [],
    pavedEnvelope: [],
    crossableEnvelope: [],
    markingOwnership: [],
    guardrailEnvelope: [],
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
      const hostS = this.hostAtBranch(distance);
      if (hostS === null) return 0;
      if (zone.kind === 'merge') {
        if (hostS <= openingStart) return 0;
        if (hostS >= parallelStart) return 1;
        return quintic((hostS - openingStart) / (parallelStart - openingStart));
      }
      if (hostS <= alignmentRow.hU) return 1;
      if (hostS >= transitionEnd) return 0;
      return 1 - quintic((hostS - alignmentRow.hU) / (transitionEnd - alignmentRow.hU));
    },
    branchDeckOffsetAt(distance, lateral = 0) {
      const blend = this.branchDeckHostBlendAt(distance);
      if (blend <= 0) return 0;
      if (distance < branchRows[0].bS - 0.01 || distance > branchRows[branchRows.length - 1].bS + 0.01) return 0;
      if (zone.kind === 'diverge') {
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
    widthFactorAt(distance) {
      const value = unwrappedHostDistance(zone, distance);
      if (value <= openingStart || value >= transitionEnd) return 0;
      if (value < parallelStart) return quintic((value - openingStart) / (parallelStart - openingStart));
      if (value <= absorptionStart) return 1;
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
      const boundaryCloseStart = zone.kind === 'diverge' ? physicalSplitRow.hU : absorptionStart;
      if (value <= boundaryCloseStart) return laneBoundary;
      const factor = quintic((value - boundaryCloseStart) / (transitionEnd - boundaryCloseStart));
      return laneBoundary + (baseEdgeLine - laneBoundary) * factor;
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
      id: `${record.id}:aux-boundary`,
      role: zone.kind === 'merge' ? 'absorbed-lane-boundary' : 'opening-lane-boundary',
      lateral: zone.side * hostLaneEdge,
      owner: `progressive:${record.id}`,
    },
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
  const lanePaths = Array.from({ length: record.temporaryLaneCount }, (_, lane) => ({
    id: lane < zone.host.lanes ? `host:${lane}` : 'aux:0',
    outcome: lane < zone.host.lanes ? 'survives' : (zone.kind === 'merge' ? 'absorbed' : 'separates'),
    points: [],
  }));
  const boundaryPaths = [
    ...hostDividerOffsets.map((lateral, index) => ({ id: `host-divider:${index}`, lateral, points: [] })),
    { id: 'aux-boundary', lateral: zone.side * hostLaneEdge, points: [] },
    { id: 'outer-edge', lateral: null, points: [] },
  ];
  for (let index = 0; index <= sampleCount; index += 1) {
    const hostS = approachStart + length * index / sampleCount;
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
    let auxLateral = outerHostLateral + (parallelAuxLateral - outerHostLateral) * factor;
    let auxPosition = map._deckPoint(frame, auxLateral, 0.035);
    if (zone.kind === 'merge' && hostS > absorptionStart) {
      const convergence = quintic((hostS - absorptionStart) / (transitionEnd - absorptionStart));
      auxLateral += (outerHostLateral - auxLateral) * convergence;
      auxPosition = map._deckPoint(frame, auxLateral, 0.035);
    } else if (zone.kind === 'diverge' && hostS > exteriorHandoffRow.hU) {
      auxPosition = divergeHandoffPoint(hostS, parallelAuxLateral, branchFeedLateral, 0.035);
      auxLateral = auxPosition.clone().sub(frame.position).dot(frame.normal);
      const branchS = record.branchAtHost(hostS);
      if (branchS !== null) {
        const branchProjection = map._projectToRoute(
          zone.branch,
          auxPosition,
          map._hostSeedIndex(zone.branch, branchS),
        );
        const branchFrame = map._frameAt(zone.branch, branchProjection.distance);
        const branchDeck = map._deckPoint(branchFrame, branchProjection.signedLateral, 0.035);
        branchDeck.y += record.branchDeckOffsetAt(
          branchProjection.distance,
          branchProjection.signedLateral,
        );
        auxPosition.y = branchDeck.y;
      }
    }
    lanePaths[lanePaths.length - 1].points.push({
      hostS,
      lateral: auxLateral,
      position: pointRecord(auxPosition),
    });
    for (const boundary of boundaryPaths) {
      let lateral = boundary.id === 'outer-edge' ? envelope.outerLateral : boundary.lateral;
      let boundaryPosition = map._deckPoint(frame, lateral, 0.04);
      const branchS = zone.kind === 'diverge' ? record.branchAtHost(hostS) : null;
      if (branchS !== null && boundary.id === 'aux-boundary' && hostS > exteriorHandoffRow.hU) {
        const branchLaneEdge = zone.branch.lanes * zone.branch.laneWidth * 0.5;
        boundaryPosition = divergeHandoffPoint(
          hostS,
          zone.side * hostLaneEdge,
          zone.hostwardSign * branchLaneEdge,
          0.04,
        );
        lateral = boundaryPosition.clone().sub(frame.position).dot(frame.normal);
      } else if (branchS !== null && boundary.id === 'outer-edge'
        && hostS >= exteriorHandoffRow.hU) {
        const branchFrame = map._frameAt(zone.branch, branchS);
        const branchHalf = map._halfWidthAt(zone.branch, branchS);
        boundaryPosition = map._deckPoint(branchFrame, -zone.hostwardSign * branchHalf, 0.04);
        lateral = boundaryPosition.clone().sub(frame.position).dot(frame.normal);
      }
      boundary.points.push({ hostS, branchS, lateral, position: pointRecord(boundaryPosition) });
    }
  }
  record.laneCentres = lanePaths;
  record.laneBoundaries = boundaryPaths;
  record.branchLaneCentres = Array.from({ length: zone.branch.lanes }, (_, lane) => ({
    id: `branch:${lane}`,
    outcome: lane === branchFeedLane ? 'fed-by-auxiliary' : 'forms-with-branch',
    points: branchRows.map((row) => ({
      branchS: row.bS,
      hostS: row.hU,
      lateral: map._laneOffset(zone.branch, lane, 1),
      position: pointRecord(map._deckPoint(row.frame, map._laneOffset(zone.branch, lane, 1), 0.035)),
    })),
  }));
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
    const classification = classifyProgressiveJunction(map, zone);
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
