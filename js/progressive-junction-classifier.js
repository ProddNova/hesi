/**
 * Geometry-owned progressive-junction eligibility.
 *
 * A graph connection is not enough: a simple lateral merge/diverge must remain
 * one collision/render deck until the two paved envelopes have actually
 * separated in plan. If deck ownership breaks while the pavements still
 * overlap laterally, the source is a multi-level/vertical transition and is
 * deferred from the progressive same-level model.
 */

const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const horizontalGrade = (tangent) => tangent.y / Math.max(1e-6, Math.hypot(tangent.x, tangent.z));
const deckEdgeSeparation = (row) => Math.max(
  Math.abs(row.dy),
  ...(row.dyEnds || []).map((value) => Math.abs(value)),
);

function measuredLength(rows, predicate) {
  let length = 0;
  for (let index = 1; index < rows.length; index += 1) {
    if (!predicate(rows[index - 1]) || !predicate(rows[index])) continue;
    length += Math.abs(rows[index].bS - rows[index - 1].bS);
  }
  return length;
}

export function classifyProgressiveJunction(map, zone) {
  const rows = zone?.samples || [];
  if (rows.length < 2) {
    return {
      category: 'manual-review',
      eligible: false,
      reason: 'insufficient authoritative deck samples',
      metrics: {},
    };
  }

  // This is the same physical overlap predicate used to create the renderer's
  // mouth-connected crossable component. `row.merged` is also the authoritative
  // render/collision deck ownership decision for that cross-section.
  const planarOverlap = (row) => row.innerEdge < row.hostHalf - 0.3;
  const connectedDeck = (row) => planarOverlap(row) && row.merged;
  const overlapRows = rows.filter(planarOverlap);
  const connectedRows = rows.filter(connectedDeck);
  const transferConnected = connectedDeck(rows[0]);

  let connectedSeen = false;
  let ownershipBreakSeen = false;
  let lateralSeparationReached = false;
  let reconnectsAfterOwnershipBreak = false;
  const ownershipBreakRows = [];
  for (const row of rows) {
    if (connectedDeck(row)) {
      if (ownershipBreakSeen) reconnectsAfterOwnershipBreak = true;
      connectedSeen = true;
      continue;
    }
    if (!connectedSeen) continue;
    if (planarOverlap(row)) {
      ownershipBreakSeen = true;
      ownershipBreakRows.push(row);
    } else {
      lateralSeparationReached = true;
    }
  }

  let maxGradeDifference = 0;
  for (const row of overlapRows) {
    const hostTangent = map._sampleCenter(zone.host, row.hS, 1).tangent;
    maxGradeDifference = Math.max(
      maxGradeDifference,
      Math.abs(horizontalGrade(row.frame.tangent) - horizontalGrade(hostTangent)),
    );
  }
  const maximumVerticalDeckSeparation = overlapRows.length
    ? Math.max(...overlapRows.map(deckEdgeSeparation))
    : Infinity;
  const minimumPlanarDy = overlapRows.length ? Math.min(...overlapRows.map((row) => row.dy)) : Infinity;
  const maximumPlanarDy = overlapRows.length ? Math.max(...overlapRows.map((row) => row.dy)) : -Infinity;
  const verticalPassThrough = minimumPlanarDy < -0.75 && maximumPlanarDy > 0.35;
  const verticalOwnershipBreak = ownershipBreakRows.some((row) => deckEdgeSeparation(row) > 0.35);
  const requiresVerticalRamp = maximumVerticalDeckSeparation > 1.25
    || (maximumVerticalDeckSeparation > 0.75 && maxGradeDifference > 0.035);
  const planarOverlapLength = measuredLength(rows, planarOverlap);
  const connectedLength = measuredLength(rows, connectedDeck);
  const connectedFraction = planarOverlapLength > 0 ? connectedLength / planarOverlapLength : 0;

  let category = 'same-level-simple';
  let reason = null;
  if (!transferConnected || !zone.crossable) {
    category = 'manual-review';
    reason = 'transfer is not a mouth-connected shared render/collision deck';
  } else if (verticalOwnershipBreak) {
    category = requiresVerticalRamp || verticalPassThrough || reconnectsAfterOwnershipBreak
      ? 'vertical-ramp-complex'
      : 'multi-level-transition';
    reason = `deck ownership breaks for ${round(measuredLength(rows, (row) => ownershipBreakRows.includes(row)), 1)} m while pavements still overlap in plan`;
  } else if (!lateralSeparationReached) {
    category = 'manual-review';
    reason = 'source span ends before a measured lateral deck separation';
  }

  return {
    category,
    eligible: category === 'same-level-simple',
    reason,
    metrics: {
      transferConnected,
      lateralSeparationReached,
      reconnectsAfterOwnershipBreak,
      planarOverlapLength: round(planarOverlapLength, 2),
      connectedDeckLength: round(connectedLength, 2),
      connectedFraction: round(connectedFraction, 3),
      ownershipBreakRows: ownershipBreakRows.length,
      maximumVerticalDeckSeparation: round(maximumVerticalDeckSeparation, 3),
      maximumGradeDifference: round(maxGradeDifference, 4),
      minimumPlanarDy: round(minimumPlanarDy, 3),
      maximumPlanarDy: round(maximumPlanarDy, 3),
      verticalPassThrough,
      requiresVerticalRamp,
      collisionDeckOwnership: verticalOwnershipBreak ? 'breaks-before-lateral-separation' : 'continuous-to-lateral-separation',
    },
  };
}

export default classifyProgressiveJunction;
