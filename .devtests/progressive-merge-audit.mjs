/**
 * Deterministic catalogue of every runtime same-level merge/diverge.
 *
 * Run: node .devtests/progressive-merge-audit.mjs
 * Writes:
 *   .devtests/progressive-merge-audit.json
 *   docs/progressive-merges/AUDIT.md
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROGRESSIVE_MERGE_PROTOTYPES } from '../js/progressive-merge-prototypes.js';
import { classifyProgressiveJunction } from '../js/progressive-junction-classifier.js';

const { HighwayMap } = await import('../js/map.js');
const originalWarn = console.warn;
console.warn = () => {};
const map = new HighwayMap(null, { addLighting: false, legacyFlow: true, markingDebug: true, progressiveMerges: false });
console.warn = originalWarn;

const deg = (radians) => radians * 180 / Math.PI;
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const intervalLength = (interval) => interval ? Math.max(0, interval[1] - interval[0]) : 0;
const angleBetween = (a, b) => {
  const cross = a.z * b.x - a.x * b.z;
  const dot = a.x * b.x + a.z * b.z;
  return Math.abs(deg(Math.atan2(cross, dot)));
};
const hostValue = (zone, distance) => {
  if (!zone.host.closed) return distance;
  let delta = distance - zone.hostRef;
  delta -= Math.round(delta / zone.host.length) * zone.host.length;
  return zone.hostRef + delta;
};

function maxCurvatureDegPer100(route, from, to) {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(route.length, Math.max(from, to));
  let worst = 0;
  const window = 10;
  for (let distance = lo; distance <= hi + 0.001; distance += 8) {
    const a = map._sampleCenter(route, Math.max(0, distance - window), 1).tangent;
    const b = map._sampleCenter(route, Math.min(route.length, distance + window), 1).tangent;
    const span = Math.max(1, Math.min(route.length, distance + window) - Math.max(0, distance - window));
    worst = Math.max(worst, angleBetween(a, b) * 100 / span);
  }
  return worst;
}

function longestParallelRun(zone) {
  let current = 0;
  let longest = 0;
  let previous = null;
  for (const row of zone.samples) {
    const hostTangent = map._sampleCenter(zone.host, row.hS, 1).tangent;
    const mismatch = angleBetween(row.frame.tangent, hostTangent);
    const qualifies = mismatch <= 6 && Math.abs(row.dy) <= 0.45
      && row.innerEdge <= row.hostHalf + 0.75;
    if (qualifies) {
      if (previous) current += Math.abs(row.bS - previous.bS);
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
    previous = row;
  }
  return longest;
}

const selectedById = new Map(PROGRESSIVE_MERGE_PROTOTYPES.map((item) => [item.id, item]));
const connections = [];
for (const zone of map.junctionZones) {
  const { host, branch } = zone;
  const mouthDistance = zone.which === 'start' ? 0 : branch.length;
  const mouth = map._sampleCenter(branch, mouthDistance, 1);
  const projected = map._projectToRoute(host, mouth.position);
  const hostMouth = map._sampleCenter(host, projected.distance, 1);
  const tangentMismatch = angleBetween(mouth.tangent, hostMouth.tangent);
  const hostBank = deg(map._bankAt(host, projected.distance));
  const branchBank = deg(map._bankAt(branch, mouthDistance));
  const bankDifference = Math.abs(hostBank - branchBank);
  const maximumTangentMismatchAcrossMouth = Math.max(...zone.samples.map((row) => (
    angleBetween(row.frame.tangent, map._sampleCenter(host, row.hS, 1).tangent)
  )));
  const transferVerticalDifference = Math.abs(mouth.position.y - projected.point.y);
  const transferPlanDifference = Math.hypot(mouth.position.x - projected.point.x, mouth.position.z - projected.point.z);
  const maxVerticalDifference = Math.max(...zone.samples.map((row) => Math.abs(row.dy)));
  const minVerticalDifference = Math.min(...zone.samples.map((row) => Math.abs(row.dy)));
  const openingRows = zone.markingOpening
    ? zone.samples.filter((row) => row.bS >= zone.markingOpening.branch[0] - 0.01
      && row.bS <= zone.markingOpening.branch[1] + 0.01)
    : [];
  const maxOpeningVerticalDifference = openingRows.length
    ? Math.max(...openingRows.map((row) => Math.abs(row.dy)))
    : Infinity;
  const maxCombinedHalfWidth = Math.max(...zone.samples.map((row) => row.unionOuter));
  const minHostHalfWidth = Math.min(...zone.samples.map((row) => row.hostHalf));
  const availableExtraWidth = Math.max(0, maxCombinedHalfWidth - minHostHalfWidth);
  const existingCrossableLength = intervalLength(zone.crossable?.branch);
  const possibleParallelLength = longestParallelRun(zone);
  const possibleTaperLength = intervalLength(zone.branchSpan);
  const currentMarkingOpeningLength = intervalLength(zone.markingOpening?.branch);
  const currentRailOpeningLength = intervalLength(zone.hostRailOpen);
  const hostCurvature = maxCurvatureDegPer100(
    host,
    zone.crossable?.host?.[0] ?? projected.distance - 60,
    zone.crossable?.host?.[1] ?? projected.distance + 60,
  );
  const branchCurvature = maxCurvatureDegPer100(branch, zone.branchSpan[0], zone.branchSpan[1]);
  const curvature = Math.max(hostCurvature, branchCurvature);
  const openingMid = zone.markingOpening
    ? (zone.markingOpening.host[0] + zone.markingOpening.host[1]) * 0.5
    : hostValue(zone, projected.distance);
  const coordinateSample = map._sampleCenter(host, map._normalizeDistance(host, openingMid), 1);
  const deckClassification = classifyProgressiveJunction(map, zone);

  const categories = [];
  const oneLane = branch.lanes === 1;
  categories.push(oneLane
    ? `simple 1-lane ${zone.kind}`
    : `multi-lane ${zone.kind}`);
  const issues = [];
  const duplicateSuspicion = currentMarkingOpeningLength > branch.length * 0.82
    || (transferPlanDifference < 0.25 && possibleParallelLength > branch.length * 0.7);
  if (possibleTaperLength < 80) {
    categories.push('transition too short');
    issues.push(`only ${round(possibleTaperLength, 1)} m of measured mouth span`);
  }
  if (tangentMismatch > 12 || maximumTangentMismatchAcrossMouth > 55 || curvature > 80) {
    categories.push('tangent mismatch too severe');
    issues.push(curvature > 80
      ? `${round(curvature, 1)}°/100 m local curvature`
      : `${round(maximumTangentMismatchAcrossMouth, 1)}° maximum relative tangent across the mouth`);
  }
  // A same-level progressive transition must retain the same render/collision
  // deck owner until the paved envelopes have separated laterally. The old
  // audit only sampled vertical difference inside the short mouth opening and
  // produced false positives when a branch became a ramp farther downstream.
  categories.push(deckClassification.category);
  if (!deckClassification.eligible) {
    categories.push('deck-ownership incompatibility');
    issues.push(deckClassification.reason);
  }
  if (duplicateSuspicion) {
    categories.push('duplicate/suspicious route');
    issues.push('branch shadows the host for most of its available length');
  }
  if (!zone.markingOpening || transferPlanDifference > 9) {
    categories.push('malformed source data');
    issues.push(!zone.markingOpening ? 'no authoritative crossable opening' : `${round(transferPlanDifference, 2)} m transfer gap`);
  }
  let automationStatus = 'suitable';
  if (categories.some((category) => [
    'transition too short',
    'tangent mismatch too severe',
    'vertical incompatibility',
    'duplicate/suspicious route',
    'malformed source data',
    'deck-ownership incompatibility',
  ].includes(category))) {
    automationStatus = 'manual-review';
    categories.push('manual review required');
  } else if (curvature > 25) {
    automationStatus = 'curved-suitable';
    categories.push('curved but suitable');
  }

  connections.push({
    id: zone.id,
    hostRouteId: host.id,
    branchRouteId: branch.id,
    trafficRoutePair: zone.kind === 'merge' ? `${branch.id} -> ${host.id}` : `${host.id} -> ${branch.id}`,
    type: zone.kind,
    side: zone.side > 0 ? 'right' : 'left',
    hostLaneCount: host.lanes,
    branchLaneCount: branch.lanes,
    hostWidth: round(map._halfWidthAt(host, projected.distance) * 2, 2),
    branchWidth: round(map._halfWidthAt(branch, mouthDistance) * 2, 2),
    availableExtraWidth: round(availableExtraWidth, 2),
    tangentMismatchDeg: round(tangentMismatch, 2),
    maximumTangentMismatchAcrossMouthDeg: round(maximumTangentMismatchAcrossMouth, 2),
    curvatureDegPer100m: {
      host: round(hostCurvature, 2),
      branch: round(branchCurvature, 2),
      maximum: round(curvature, 2),
    },
    bankingDifferenceDeg: round(bankDifference, 2),
    verticalDifference: {
      atTransfer: round(transferVerticalDifference, 3),
      minimumAcrossMouth: round(minVerticalDifference, 3),
      maximumAcrossMouth: round(maxVerticalDifference, 3),
      maximumAcrossOpening: round(maxOpeningVerticalDifference, 3),
    },
    transferPlanDifference: round(transferPlanDifference, 3),
    existingCrossableLength: round(existingCrossableLength, 2),
    possibleParallelLength: round(possibleParallelLength, 2),
    possibleTaperLength: round(possibleTaperLength, 2),
    currentMarkingOpening: zone.markingOpening ? {
      branch: zone.markingOpening.branch.map((value) => round(value, 3)),
      host: zone.markingOpening.host.map((value) => round(value, 3)),
      length: round(currentMarkingOpeningLength, 2),
    } : null,
    currentRailOpening: zone.hostRailOpen ? {
      host: zone.hostRailOpen.map((value) => round(value, 3)),
      length: round(currentRailOpeningLength, 2),
    } : null,
    sourceDataQuality: issues.length ? 'requires-review' : 'measured-clean',
    automaticGenerationSuitability: automationStatus,
    progressiveDeckClassification: deckClassification,
    classifications: categories,
    manualReviewReason: issues.length ? issues.join('; ') : null,
    selectedPrototype: selectedById.has(zone.id),
    prototypeLabel: selectedById.get(zone.id)?.label ?? null,
    worldCoordinates: {
      x: round(coordinateSample.position.x, 2),
      y: round(coordinateSample.position.y, 2),
      z: round(coordinateSample.position.z, 2),
    },
  });
}

connections.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const selected = connections.filter((connection) => connection.selectedPrototype);
if (selected.length !== PROGRESSIVE_MERGE_PROTOTYPES.length) {
  throw new Error(`Expected exactly ${PROGRESSIVE_MERGE_PROTOTYPES.length} selected prototypes, found ${selected.length}`);
}
for (const prototype of PROGRESSIVE_MERGE_PROTOTYPES) {
  const connection = connections.find((candidate) => candidate.id === prototype.id);
  if (!connection) throw new Error(`Selected prototype is absent from runtime audit: ${prototype.id}`);
}
const effectivePrototypeClassification = (connection) => {
  const prototype = selectedById.get(connection.id);
  if (prototype?.approvedSameLevel && !connection.progressiveDeckClassification.eligible) {
    return {
      category: 'same-level-approved',
      eligible: true,
      measuredCategory: connection.progressiveDeckClassification.category,
      approvalReason: prototype.approvalReason,
    };
  }
  return connection.progressiveDeckClassification;
};

const classificationCounts = {};
for (const connection of connections) {
  for (const category of connection.classifications) {
    classificationCounts[category] = (classificationCounts[category] || 0) + 1;
  }
}
const summary = {
  generatedFromBase: '1a80b1b2be8f7e4e25b923de3a79413c302b7e91',
  totalConnections: connections.length,
  merges: connections.filter((connection) => connection.type === 'merge').length,
  diverges: connections.filter((connection) => connection.type === 'diverge').length,
  leftSide: connections.filter((connection) => connection.side === 'left').length,
  rightSide: connections.filter((connection) => connection.side === 'right').length,
  automaticSuitable: connections.filter((connection) => connection.automaticGenerationSuitability !== 'manual-review').length,
  manualReview: connections.filter((connection) => connection.automaticGenerationSuitability === 'manual-review').length,
  selectedPrototypeIds: selected.map((connection) => connection.id),
  activePrototypeIds: selected.filter((connection) => effectivePrototypeClassification(connection).eligible)
    .map((connection) => connection.id),
  deferredPrototypeIds: selected.filter((connection) => !effectivePrototypeClassification(connection).eligible)
    .map((connection) => connection.id),
  classificationCounts,
};

const jsonPath = fileURLToPath(new URL('./progressive-merge-audit.json', import.meta.url));
writeFileSync(jsonPath, `${JSON.stringify({ summary, connections }, null, 2)}\n`);

const selectedRows = selected.map((connection) => {
  const classification = effectivePrototypeClassification(connection);
  const pin = selectedById.get(connection.id).pin;
  return `| \`${connection.id}\` | \`${connection.trafficRoutePair}\` | ${connection.side} | ${connection.hostLaneCount}/${connection.branchLaneCount} | ${classification.eligible ? 'active' : 'deferred'} | ${classification.category} | ${pin.x}, ${pin.y}, ${pin.z} |`;
}).join('\n');
const catalogueRows = connections.map((connection) => `| \`${connection.id}\` | \`${connection.trafficRoutePair}\` | ${connection.side} | ${connection.hostLaneCount}/${connection.branchLaneCount} | ${connection.existingCrossableLength} | ${connection.possibleParallelLength} | ${connection.tangentMismatchDeg} | ${connection.verticalDifference.maximumAcrossOpening} | ${connection.automaticGenerationSuitability} | ${connection.classifications.join(', ')} |`).join('\n');
const counts = Object.entries(classificationCounts)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([category, count]) => `- ${category}: ${count}`)
  .join('\n');
const markdown = `# Progressive Merge Connection Audit

Generated deterministically from the runtime graph and the authoritative
junction-zone measurements on base \`${summary.generatedFromBase}\`.

## Summary

- Connections: ${summary.totalConnections} (${summary.merges} merges, ${summary.diverges} diverges)
- Side: ${summary.leftSide} left, ${summary.rightSide} right
- Automatic/curved suitable: ${summary.automaticSuitable}
- Manual review: ${summary.manualReview}
- Audited/pinned candidates: exactly ${selected.length}
- Active same-level prototypes: ${summary.activePrototypeIds.length}
- Deferred multi-level/manual candidates: ${summary.deferredPrototypeIds.length}

${counts}

## Selected representative prototype set

| Junction ID | Traffic route pair | Side | Host/branch lanes | Status | Classification | World X, Y, Z |
| --- | --- | --- | ---: | --- | --- | --- |
${selectedRows}

Exactly two pins are exposed by the developer map: P1 is the preserved
\`J2\` progressive diverge, and P2 is the explicitly approved lower-deck
\`J48\` merge. No deferred or obsolete P1/P2/P3/P4 marker remains. J48 retains
its measured classifier result in the JSON while the approved runtime status
is reported transparently as \`same-level-approved\`.

## Complete same-level catalogue

Widths, banking, curvature, exact A–B intervals, rail intervals, source-quality
reasons, and world coordinates are retained in
\`.devtests/progressive-merge-audit.json\`.

| Junction ID | Traffic route pair | Side | H/B lanes | Crossable m | Parallel m | Tangent ° | Opening ΔY m | Suitability | Classifications |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
${catalogueRows}
`;
const markdownPath = fileURLToPath(new URL('../docs/progressive-merges/AUDIT.md', import.meta.url));
writeFileSync(markdownPath, markdown);

console.log(JSON.stringify(summary, null, 2));
console.log(`audit: ${jsonPath}`);
console.log(`summary: ${markdownPath}`);
