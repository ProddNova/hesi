/**
 * Shared progressive same-level transition model.
 *
 * This module owns phase order, paved/crossable envelopes, temporary lane
 * topology, marking ownership and the guardrail envelope. Rendering, physics,
 * developer diagnostics and probes consume the records; none re-derive phase
 * boundaries independently.
 */

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

function laneMappings(zone) {
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
      final: 'branch:0',
      outcome: 'separates-to-branch',
    });
    for (let lane = 1; lane < branch.lanes; lane += 1) {
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
    Math.max(openingStart + 24, approachStart + length * 0.32),
    openingStart + 20,
    transitionEnd - 48,
  );
  const absorptionStart = clamp(
    Math.min(approachStart + length * 0.68, compatibleEnd - 8),
    parallelStart + 24,
    transitionEnd - 24,
  );
  const hostLaneEdge = zone.host.lanes * zone.host.laneWidth * 0.5;
  const auxiliaryWidth = zone.host.laneWidth;
  const targetExtraWidth = auxiliaryWidth + Math.max(0.8, zone.host.shoulder || 1.0);

  const record = {
    id: zone.id,
    label: prototype.label,
    hostRouteId: zone.host.id,
    branchRouteId: zone.branch.id,
    type: zone.kind,
    side: zone.side > 0 ? 'left' : 'right',
    sideSign: zone.side,
    which: zone.which,
    approachStart,
    openingStart,
    parallelStart,
    absorptionStart,
    transitionEnd,
    length,
    phaseOrder: [...PROGRESSIVE_PHASES],
    hostLaneCount: zone.host.lanes,
    branchLaneCount: zone.branch.lanes,
    temporaryLaneCount: zone.host.lanes + 1,
    finalLaneCount: zone.host.lanes,
    auxiliaryLaneCount: 1,
    auxiliaryWidth,
    targetExtraWidth,
    branchInterval: [...zone.branchSpan],
    hostInterval: [approachStart, transitionEnd],
    crossableInterval: [openingStart, transitionEnd],
    laneMappings: laneMappings(zone),
    survivingLanes: Array.from({ length: zone.host.lanes }, (_, lane) => `host:${lane}`),
    absorbedLanes: zone.kind === 'merge' ? ['aux:0'] : [],
    separatedLanes: zone.kind === 'diverge' ? ['aux:0'] : [],
    laneCentres: [],
    laneBoundaries: [],
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
      role: 'superseded-branch-divider',
      lateral,
      owner: 'none',
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
    const parallelAuxLateral = zone.side * (hostLaneEdge + auxiliaryWidth * 0.5);
    let auxLateral = outerHostLateral + (parallelAuxLateral - outerHostLateral) * factor;
    if (zone.kind === 'merge' && hostS > absorptionStart) {
      const convergence = quintic((hostS - absorptionStart) / (transitionEnd - absorptionStart));
      auxLateral += (outerHostLateral - auxLateral) * convergence;
    }
    lanePaths[lanePaths.length - 1].points.push({
      hostS,
      lateral: auxLateral,
      position: pointRecord(map._deckPoint(frame, auxLateral, 0.035)),
    });
    for (const boundary of boundaryPaths) {
      const lateral = boundary.id === 'outer-edge' ? envelope.outerLateral : boundary.lateral;
      boundary.points.push({ hostS, lateral, position: pointRecord(map._deckPoint(frame, lateral, 0.04)) });
    }
  }
  record.laneCentres = lanePaths;
  record.laneBoundaries = boundaryPaths;
  return record;
}

export function buildProgressiveTransitions(map, prototypes) {
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
    const record = buildRecord(map, zone, prototype);
    zone.progressive = record;
    if (!zone.host._progressiveTransitionsAsHost) zone.host._progressiveTransitionsAsHost = [];
    if (!zone.branch._progressiveTransitionsAsBranch) zone.branch._progressiveTransitionsAsBranch = [];
    zone.host._progressiveTransitionsAsHost.push(record);
    zone.branch._progressiveTransitionsAsBranch.push(record);
    records.push(record);
  }
  return records;
}

