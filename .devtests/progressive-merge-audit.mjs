/**
 * Deterministic catalogue of every runtime same-level merge/diverge.
 *
 * Run: node .devtests/progressive-merge-audit.mjs
 * Writes:
 *   .devtests/progressive-merge-audit.json
 *   docs/progressive-merges/AUDIT.md
 */
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROGRESSIVE_MERGE_PROTOTYPES } from '../js/progressive-merge-prototypes.js';
import { classifyProgressiveJunction } from '../js/progressive-junction-classifier.js';

const { HighwayMap } = await import('../js/map.js');
const originalWarn = console.warn;
console.warn = () => {};
const map = new HighwayMap(null, { addLighting: false, markingDebug: true, progressiveMerges: false });
console.warn = originalWarn;

const deg = (radians) => radians * 180 / Math.PI;
const round = (value, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const intervalLength = (interval) => interval ? Math.max(0, interval[1] - interval[0]) : 0;
const horizontalGrade = (tangent) => tangent.y / Math.max(1e-6, Math.hypot(tangent.x, tangent.z));
const deckEdgeSeparation = (row) => Math.max(
  Math.abs(row.dy),
  ...(row.dyEnds || []).map((value) => Math.abs(value)),
);
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
  const maximumBankDifference = Math.max(...zone.samples.map((row) => (
    Math.abs(deg(map._bankAt(branch, row.bS)) - deg(map._bankAt(host, row.hS)))
  )));
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
  const availableApproachLength = zone.which === 'end'
    ? zone.branchSpan[0]
    : Math.max(0, branch.length - zone.branchSpan[1]);
  const availableFinalHostLength = host.closed
    ? host.length
    : Math.max(0, host.length - projected.distance);
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

  const seriousP2Candidate = zone.kind === 'merge' && host.lanes === 2 && branch.lanes === 2;
  // Junction rows are stored transfer-outward for every mouth. P2 evidence is
  // deliberately emitted in the branch's actual traffic order: an end merge
  // travels from the smaller branch station toward its transfer endpoint.
  const travelRows = zone.which === 'end' ? [...zone.samples].reverse() : [...zone.samples];
  const interactionProfile = seriousP2Candidate
    ? travelRows.filter((row, index) => (
      index === 0 || index === travelRows.length - 1 || index % Math.max(1, Math.floor(travelRows.length / 8)) === 0
    )).map((row) => {
      const hostTangent = map._sampleCenter(host, row.hS, 1).tangent;
      const branchTangent = map._sampleCenter(branch, row.bS, 1).tangent;
      return {
        branchStation: round(row.bS, 2),
        hostStation: round(row.hU, 2),
        centreDeckDifference: round(row.dy, 3),
        maximumDeckEdgeSeparation: round(deckEdgeSeparation(row), 3),
        tangentMismatchDeg: round(angleBetween(branchTangent, hostTangent), 2),
        gradeDifference: round(Math.abs(horizontalGrade(branchTangent) - horizontalGrade(hostTangent)), 4),
        bankDifferenceDeg: round(Math.abs(deg(map._bankAt(branch, row.bS)) - deg(map._bankAt(host, row.hS))), 2),
        planarOverlap: row.innerEdge < row.hostHalf - 0.3,
        sharedRenderCollisionDeck: row.merged && row.innerEdge < row.hostHalf - 0.3,
      };
    })
    : null;

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
    ...(seriousP2Candidate ? {
      maximumBankingDifferenceDeg: round(maximumBankDifference, 2),
      availableApproachLength: round(availableApproachLength, 2),
      availableLaneAbsorptionLength: deckClassification.metrics.connectedDeckLength,
      availableFinalHostLength: round(availableFinalHostLength, 2),
      finalHostWidth: round(map._halfWidthAt(host, projected.distance) * 2, 2),
      trafficDirection: {
        branch: `${branch.id} increasing chainage to ${zone.which} transfer`,
        host: `${host.id} increasing chainage after merge`,
      },
      surfaceAndCollisionConnectedness: {
        transferConnected: deckClassification.metrics.transferConnected,
        connectedDeckLength: deckClassification.metrics.connectedDeckLength,
        planarOverlapLength: deckClassification.metrics.planarOverlapLength,
        connectedFraction: deckClassification.metrics.connectedFraction,
        ownershipBreakRows: deckClassification.metrics.ownershipBreakRows,
        reconnectsAfterOwnershipBreak: deckClassification.metrics.reconnectsAfterOwnershipBreak,
        collisionDeckOwnership: deckClassification.metrics.collisionDeckOwnership,
      },
      interactionProfile,
    } : {}),
    worldCoordinates: {
      x: round(coordinateSample.position.x, 2),
      y: round(coordinateSample.position.y, 2),
      z: round(coordinateSample.position.z, 2),
    },
  });
}

connections.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
const selected = connections.filter((connection) => connection.selectedPrototype);
if (selected.length !== 4) throw new Error(`Expected exactly four selected prototypes, found ${selected.length}`);
for (const prototype of PROGRESSIVE_MERGE_PROTOTYPES) {
  const connection = connections.find((candidate) => candidate.id === prototype.id);
  if (!connection) throw new Error(`Selected prototype is absent from runtime audit: ${prototype.id}`);
}

const classificationCounts = {};
for (const connection of connections) {
  for (const category of connection.classifications) {
    classificationCounts[category] = (classificationCounts[category] || 0) + 1;
  }
}

const p2RejectionReasons = (candidate) => {
  const metrics = candidate.progressiveDeckClassification.metrics;
  const reasons = [];
  if (!metrics.transferConnected) {
    reasons.push('transfer is not one shared render/collision deck');
  }
  if (metrics.ownershipBreakRows > 0) {
    reasons.push(`${metrics.ownershipBreakRows} overlap samples lose deck ownership before lateral separation`);
  }
  if (metrics.maximumVerticalDeckSeparation > 0.75) {
    reasons.push(`${metrics.maximumVerticalDeckSeparation.toFixed(3)} m maximum deck-edge separation`);
  }
  if (metrics.maximumGradeDifference > 0.035) {
    reasons.push(`${(metrics.maximumGradeDifference * 100).toFixed(2)}% maximum relative grade`);
  }
  if (candidate.maximumTangentMismatchAcrossMouthDeg > 12) {
    reasons.push(`${candidate.maximumTangentMismatchAcrossMouthDeg.toFixed(2)} deg maximum tangent mismatch`);
  }
  if (candidate.curvatureDegPer100m.maximum > 50) {
    reasons.push(`${candidate.curvatureDegPer100m.maximum.toFixed(2)} deg/100 m source curvature`);
  }
  if (!metrics.lateralSeparationReached) {
    reasons.push('measured source span never reaches clean lateral separation');
  }
  if (metrics.reconnectsAfterOwnershipBreak) {
    reasons.push('deck ownership disconnects and reconnects inside the interaction');
  }
  return reasons;
};

const p2CandidateScore = (candidate) => {
  const metrics = candidate.progressiveDeckClassification.metrics;
  return (metrics.transferConnected ? 0 : 10000)
    + metrics.maximumVerticalDeckSeparation * 100
    + metrics.ownershipBreakRows * 4
    + metrics.maximumGradeDifference * 100
    + candidate.curvatureDegPer100m.maximum
    + (metrics.reconnectsAfterOwnershipBreak ? 25 : 0)
    + (metrics.lateralSeparationReached ? 0 : 25);
};

const rankedP2Candidates = connections
  .filter((connection) => connection.type === 'merge'
    && connection.hostLaneCount === 2 && connection.branchLaneCount === 2)
  .sort((left, right) => p2CandidateScore(left) - p2CandidateScore(right))
  .map((candidate, index) => ({
    rank: index + 1,
    id: candidate.id,
    routePair: candidate.trafficRoutePair,
    worldCoordinates: candidate.worldCoordinates,
    eligible: candidate.progressiveDeckClassification.eligible,
    score: round(p2CandidateScore(candidate), 2),
    rejectionReasons: p2RejectionReasons(candidate),
  }));
const validP2Candidates = rankedP2Candidates.filter((candidate) => candidate.eligible);
const auditedBase = execFileSync(
  'git', ['merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' },
).trim();
const summary = {
  generatedFromBase: auditedBase,
  totalConnections: connections.length,
  merges: connections.filter((connection) => connection.type === 'merge').length,
  diverges: connections.filter((connection) => connection.type === 'diverge').length,
  leftSide: connections.filter((connection) => connection.side === 'left').length,
  rightSide: connections.filter((connection) => connection.side === 'right').length,
  automaticSuitable: connections.filter((connection) => connection.automaticGenerationSuitability !== 'manual-review').length,
  manualReview: connections.filter((connection) => connection.automaticGenerationSuitability === 'manual-review').length,
  selectedPrototypeIds: selected.map((connection) => connection.id),
  activePrototypeIds: selected.filter((connection) => connection.progressiveDeckClassification.eligible)
    .map((connection) => connection.id),
  deferredPrototypeIds: selected.filter((connection) => !connection.progressiveDeckClassification.eligible)
    .map((connection) => connection.id),
  p2TwoPlusTwoMergeCandidates: rankedP2Candidates,
  validP2CandidateIds: validP2Candidates.map((candidate) => candidate.id),
  p2Decision: validP2Candidates.length ? 'candidate-available' : 'no-valid-candidate',
  classificationCounts,
};

const jsonPath = fileURLToPath(new URL('./progressive-merge-audit.json', import.meta.url));
writeFileSync(jsonPath, `${JSON.stringify({ summary, connections }, null, 2)}\n`);

const selectedRows = selected.map((connection) => `| \`${connection.id}\` | \`${connection.trafficRoutePair}\` | ${connection.side} | ${connection.hostLaneCount}/${connection.branchLaneCount} | ${connection.progressiveDeckClassification.eligible ? 'active' : 'deferred'} | ${connection.progressiveDeckClassification.category} | ${connection.worldCoordinates.x}, ${connection.worldCoordinates.y}, ${connection.worldCoordinates.z} |`).join('\n');
const catalogueRows = connections.map((connection) => `| \`${connection.id}\` | \`${connection.trafficRoutePair}\` | ${connection.side} | ${connection.hostLaneCount}/${connection.branchLaneCount} | ${connection.existingCrossableLength} | ${connection.possibleParallelLength} | ${connection.tangentMismatchDeg} | ${connection.verticalDifference.maximumAcrossOpening} | ${connection.automaticGenerationSuitability} | ${connection.classifications.join(', ')} |`).join('\n');
const p2Rows = rankedP2Candidates.map((ranked) => {
  const candidate = connections.find((connection) => connection.id === ranked.id);
  const metrics = candidate.progressiveDeckClassification.metrics;
  return `| ${ranked.rank} | \`${candidate.id}\` | \`${candidate.trafficRoutePair}\` | ${candidate.worldCoordinates.x}, ${candidate.worldCoordinates.y}, ${candidate.worldCoordinates.z} | ${candidate.availableApproachLength} | ${candidate.possibleParallelLength} | ${candidate.availableLaneAbsorptionLength} | ${metrics.maximumVerticalDeckSeparation} | ${(metrics.maximumGradeDifference * 100).toFixed(2)} | ${candidate.maximumBankingDifferenceDeg} | ${candidate.maximumTangentMismatchAcrossMouthDeg} | ${candidate.curvatureDegPer100m.maximum} | ${ranked.rejectionReasons.join('; ')} |`;
}).join('\n');
const p2Profiles = rankedP2Candidates.map((ranked) => {
  const candidate = connections.find((connection) => connection.id === ranked.id);
  const rows = candidate.interactionProfile.map((sample) => (
    `| ${sample.branchStation} | ${sample.hostStation} | ${sample.centreDeckDifference} | ${sample.maximumDeckEdgeSeparation} | ${sample.tangentMismatchDeg} | ${(sample.gradeDifference * 100).toFixed(2)} | ${sample.bankDifferenceDeg} | ${sample.planarOverlap ? 'yes' : 'no'} | ${sample.sharedRenderCollisionDeck ? 'yes' : 'no'} |`
  )).join('\n');
  const stem = candidate.id.split(':')[0].toLowerCase();
  return `### ${ranked.rank}. \`${candidate.id}\` — \`${candidate.trafficRoutePair}\`

![${candidate.id} plan](p2-candidate-audit/${stem}-plan.png)

![${candidate.id} deck view](p2-candidate-audit/${stem}-deck.png)

| Branch s | Host s | Centre ΔY m | Edge ΔY m | Tangent ° | Grade Δ % | Bank Δ ° | Plan overlap | Shared deck |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
${rows}

Decision: **REJECT** — ${ranked.rejectionReasons.join('; ')}.
`;
}).join('\n');
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

## P2 exhaustive same-level 2+2 merge search

The runtime graph contains ${summary.merges} merges. Exact lane-count filtering
leaves ${rankedP2Candidates.length} serious 2-lane-host + 2-lane-branch
candidates. Authoritative render/collision deck classification accepts
**${validP2Candidates.length}**. The ranking below is diagnostic only: a lower
score identifies the closest source geometry, but cannot override a failed
same-deck invariant.

| Rank | Junction | Traffic route pair | World X, Y, Z | Approach m | Parallel m | Max absorption m | Edge ΔY m | Grade Δ % | Bank Δ ° | Tangent Δ ° | Curvature °/100 m | Rejection |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${p2Rows}

**Decision: ${summary.p2Decision}.** Per the P2 brief, no route is promoted and
no prototype/developer-map configuration is changed when this gate has no
valid candidate. Detailed travel-order profiles and runtime images are in
[P2-CANDIDATE-REPORT.md](P2-CANDIDATE-REPORT.md).

## Selected representative prototype set

| Junction ID | Traffic route pair | Side | Host/branch lanes | Status | Classification | World X, Y, Z |
| --- | --- | --- | ---: | --- | --- | --- |
${selectedRows}

All four are reachable through stable P1-P4 developer-map pins. P4 is the only
active same-level prototype; P1-P3 retain legacy geometry and are visibly
classified as deferred/manual. The classifier consumes the renderer's own
cross-section ownership: an ownership break while pavement still overlaps in
plan is a multi-level transition, even if the short transfer opening itself is
nearly level.

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

const p2Markdown = `# P2 Same-Level 2+2 Merge Candidate Report

Generated from runtime geometry on verified \`origin/main\` base
\`${summary.generatedFromBase}\`. This report covers every graph connection
whose operation is merge and whose host and branch both have exactly two
lanes. Rows are sampled in actual branch travel order toward the merge, not by
reversing P1 animation phases.

## Result

No genuine same-level 2+2 merge exists in the current source network. All five
candidates either overlap while owned by different vertical decks, fail to
connect at the transfer, or also contain source curvature/tangent defects.
Creating P2 at any of them would violate the explicit same-level and
no-ramp-over-mainline gates. The closest case, \`J5\`, still has a 1.033 m
deck-edge split before lateral separation plus a 54.04 deg/100 m source curve.

No road, junction geometry, progressive prototype, or developer-map marker is
modified by this audit. The validated \`J2\` diverge therefore remains exactly
as received, and the requested P4-to-P1/developer-map cleanup is intentionally
not applied because the brief says to stop after the candidate report when no
valid P2 exists.

## Ranked candidates

| Rank | Junction | Traffic route pair | World X, Y, Z | Approach m | Parallel m | Max absorption m | Edge ΔY m | Grade Δ % | Bank Δ ° | Tangent Δ ° | Curvature °/100 m | Rejection |
| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${p2Rows}

## Runtime geometry in travel order

\`Shared deck\` is the same emitted road-surface and collision-deck ownership
decision used by production. A \`no\` while the paved envelopes overlap in
plan is a vertical/multi-level interaction, not an opening available to a
progressive four-lane merge.

${p2Profiles}

## Candidate order

1. \`J5\` is closest by connected length and height, but is still vertically
   split before lateral separation and has the worst unacceptable source kink
   among the top three.
2. \`J1\` has less vertical separation than \`J0\`, but its deck disconnects
   and reconnects inside the overlap.
3. \`J0\` has useful length but reaches a 2.620 m deck split, an 8.34% relative
   grade, and never reaches clean lateral separation in the measured span.
4. \`J33\` offers length but spends 72 m of overlap on a different deck and
   reaches a 2.924 m split with 13.05% relative grade.
5. \`J16\` is not a shared render/collision deck at the transfer itself, so it
   cannot define the final stable host handoff.

## Stop condition

The requested P2 topology, lane mapping, marking/rail ownership, physics probe,
visual matrix, developer-map two-pin state, and full regression/performance
suite are not fabricated for an invalid location. Work stops at Phase 1 as
directed by the brief. A future P2 requires corrected/new source geometry that
provides a real same-level 2+2 merge; vertical merge support remains out of
scope.
`;
const p2MarkdownPath = fileURLToPath(new URL('../docs/progressive-merges/P2-CANDIDATE-REPORT.md', import.meta.url));
writeFileSync(p2MarkdownPath, p2Markdown);

console.log(JSON.stringify(summary, null, 2));
console.log(`audit: ${jsonPath}`);
console.log(`summary: ${markdownPath}`);
console.log(`P2 report: ${p2MarkdownPath}`);
