/**
 * A-B MERGE-MARKING CLIPPING PROBE
 *
 * Contract for every same-level merge/diverge opening:
 *   - the authoritative opening has exact (geometry-refined) A/B limits;
 *   - branch route-local host-facing edges and absorbed lane dividers do not
 *     paint inside it;
 *   - a marking quad never bridges across a removed interval;
 *   - every retained boundary has one explicit owner;
 *   - unrelated host lane dividers are not suppressed.
 *
 * Run: node .devtests/ab-marking-clipping-probe.mjs [--verbose]
 */
const VERBOSE = process.argv.includes('--verbose');
const originalWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false, markingDebug: true });
console.warn = originalWarn;

let failures = 0;
const failureSamples = [];
const fail = (label, detail) => {
  failures += 1;
  if (failureSamples.length < 30) failureSamples.push(`FAIL  ${label}: ${detail}`);
};
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const strips = map._markingLog.filter((piece) => piece.kind === 'strip');
const suppressed = map._markingLog.filter((piece) => piece.kind === 'suppressedStrip');
const zones = (map.junctionZones || []).filter((zone) => zone.crossable);

const summary = {
  zones: zones.length,
  strips: strips.length,
  authoritativeOpenings: 0,
  instrumentationMissing: 0,
  routeLocalOpeningPieces: 0,
  solidEdgePenetrations: 0,
  oneLaneInternalDividers: 0,
  bridgingQuads: 0,
  duplicateBoundaries: 0,
  hostDividerWrongfulSuppressions: 0,
  maxCutError: 0,
  longestIllegalPenetration: 0,
  shortestAccidentalFragment: Infinity,
};

// Instrumentation is itself part of the regression contract: a failure must
// say who painted a boundary and why another candidate was suppressed.
for (const piece of strips) {
  if (piece.owner && piece.classification && piece.markingType
    && piece.tangentFrom && piece.tangentTo
    && Array.isArray(piece.junctionMemberships)
    && Object.hasOwn(piece, 'suppressionReason')) continue;
  summary.instrumentationMissing += 1;
}
if (summary.instrumentationMissing) {
  fail('marking-instrumentation', `${summary.instrumentationMissing} painted pieces lack owner/type/tangent/junction/suppression metadata`);
}

const openingOf = (zone) => zone.markingOpening?.branch || zone.crossable.branch;

for (const zone of zones) {
  const opening = openingOf(zone);
  if (zone.markingOpening?.exact === true) summary.authoritativeOpenings += 1;
  else fail('authoritative-opening', `${zone.kind} ${zone.branch.id} on ${zone.host.id} has no exact geometry-derived A-B opening`);

  const localPieces = strips.filter((piece) => piece.routeId === zone.branch.id
    && piece.owner === `route:${zone.branch.id}`
    && overlap(piece.sFrom, piece.sTo, opening[0], opening[1]) > 0);

  for (const piece of localPieces) {
    const hostFacingEdge = piece.tag === 'edgeLine' && piece.boundary === `edge:${zone.hostwardSign}`;
    const absorbedDivider = piece.tag === 'laneDivider';
    if (!hostFacingEdge && !absorbedDivider) continue; // branch outer edge remains a physical union edge
    const penetration = overlap(piece.sFrom, piece.sTo, opening[0], opening[1]);
    if (penetration <= 0.01) continue;
    summary.routeLocalOpeningPieces += 1;
    summary.longestIllegalPenetration = Math.max(summary.longestIllegalPenetration, penetration);
    summary.shortestAccidentalFragment = Math.min(summary.shortestAccidentalFragment, penetration);
    if (hostFacingEdge) summary.solidEdgePenetrations += 1;
    fail('route-local-opening-paint', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: ${piece.tag} ${piece.sFrom.toFixed(2)}..${piece.sTo.toFixed(2)} owner=${piece.owner} penetrates A-B by ${penetration.toFixed(2)} m`);
  }

  if (zone.branch.lanes === 1) {
    const invented = strips.filter((piece) => piece.routeId === zone.branch.id
      && piece.tag === 'laneDivider'
      && overlap(piece.sFrom, piece.sTo, zone.branchSpan[0], zone.branchSpan[1]) > 0);
    summary.oneLaneInternalDividers += invented.length;
    if (invented.length) fail('one-lane-internal-divider', `${zone.branch.id} generated ${invented.length} internal divider pieces`);
  }

  for (const piece of strips.filter((candidate) => candidate.routeId === zone.branch.id)) {
    if (piece.sFrom < opening[0] - 0.01 && piece.sTo > opening[1] + 0.01) {
      summary.bridgingQuads += 1;
      fail('quad-bridges-opening', `${zone.branch.id} ${piece.tag} ${piece.sFrom.toFixed(2)}..${piece.sTo.toFixed(2)} bridges ${opening[0].toFixed(2)}..${opening[1].toFixed(2)}`);
    }
  }

  const hostDividerSuppressions = suppressed.filter((piece) => piece.routeId === zone.host.id
    && piece.tag === 'laneDivider'
    && piece.junctionMemberships?.some((membership) => membership.zoneId === zone.id && membership.role === 'host')
    && piece.suppressionReason !== 'outside-route-paved-width');
  summary.hostDividerWrongfulSuppressions += hostDividerSuppressions.length;
  if (hostDividerSuppressions.length) {
    fail('host-divider-wrongful-suppression', `${zone.branch.id} on ${zone.host.id}: ${hostDividerSuppressions.length} host divider spans suppressed without a replacement owner`);
  }

  // The legacy path rejects a whole surface-frame span as soon as either end
  // lands in the sampled interval. That exposes its A/B error directly in the
  // suppression log. The exact implementation records the interpolated cuts.
  const handoff = suppressed.filter((piece) => piece.routeId === zone.branch.id
    && piece.tag === 'edgeLine'
    && piece.boundary === `edge:${zone.hostwardSign}`
    && piece.suppressionZoneId === zone.id
    && (piece.suppressionReason === 'junction-zone-owner-handoff'
      || piece.suppressionReason === 'junction-opening-no-marking'));
  if (handoff.length) {
    const actualA = Math.min(...handoff.map((piece) => piece.sFrom));
    const actualB = Math.max(...handoff.map((piece) => piece.sTo));
    const cutError = Math.max(Math.abs(actualA - opening[0]), Math.abs(actualB - opening[1]));
    summary.maxCutError = Math.max(summary.maxCutError, cutError);
    if (cutError > 0.25) fail('imprecise-a-b-cut', `${zone.branch.id} on ${zone.host.id}: cut ${actualA.toFixed(2)}..${actualB.toFixed(2)}, opening ${opening[0].toFixed(2)}..${opening[1].toFixed(2)} (${cutError.toFixed(2)} m error)`);
  }
}

// Duplicate-owner check at the physical boundary: compare illegal branch
// pieces with junction-owned pieces in the same zone and within one stripe
// width in XZ. This deliberately does not count adjacent tessellation pieces.
const pointSegmentDistance = (point, a, b) => {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const wx = point.x - a.x;
  const wz = point.z - a.z;
  const vv = vx * vx + vz * vz;
  const t = vv > 1e-9 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / vv)) : 0;
  return Math.hypot(point.x - (a.x + vx * t), point.z - (a.z + vz * t));
};
for (const zone of zones) {
  const opening = openingOf(zone);
  const branchPieces = strips.filter((piece) => piece.routeId === zone.branch.id
    && piece.owner === `route:${zone.branch.id}`
    && (piece.tag === 'laneDivider' || (piece.tag === 'edgeLine' && piece.boundary === `edge:${zone.hostwardSign}`))
    && overlap(piece.sFrom, piece.sTo, opening[0], opening[1]) > 0);
  const junctionPieces = strips.filter((piece) => piece.owner === `junction:${zone.id}`);
  for (const branchPiece of branchPieces) {
    const midpoint = {
      x: (branchPiece.start.x + branchPiece.end.x) * 0.5,
      z: (branchPiece.start.z + branchPiece.end.z) * 0.5,
    };
    if (junctionPieces.some((piece) => pointSegmentDistance(midpoint, piece.start, piece.end) < 0.28)) {
      summary.duplicateBoundaries += 1;
    }
  }
}
if (summary.duplicateBoundaries) fail('duplicate-boundary-owner', `${summary.duplicateBoundaries} route/junction boundary pieces overlap`);

// Representative diagnosis is selected by geometry/topology, never by route
// ID. This makes the report stable as the network grows while still covering
// every acceptance family requested for the pass.
const requirements = [
  ['one-lane -> two-lane merge', (zone) => zone.kind === 'merge' && zone.branch.lanes === 1 && zone.host.lanes === 2],
  ['two-lane -> two-lane merge', (zone) => zone.kind === 'merge' && zone.branch.lanes === 2 && zone.host.lanes === 2],
  ['two-lane -> three-lane merge', (zone) => zone.kind === 'merge' && zone.branch.lanes === 2 && zone.host.lanes === 3],
  ['left-side merge', (zone) => zone.kind === 'merge' && zone.side > 0],
  ['right-side merge', (zone) => zone.kind === 'merge' && zone.side < 0],
  ['diverge', (zone) => zone.kind === 'diverge'],
];
const selected = new Set();
console.log('\nRepresentative A-B cases:');
for (const [label, predicate] of requirements) {
  const zone = zones.find((candidate) => predicate(candidate) && !selected.has(candidate))
    || zones.find(predicate);
  if (!zone) { fail('representative-case', `missing ${label}`); continue; }
  selected.add(zone);
  const opening = openingOf(zone);
  const hostward = strips.filter((piece) => piece.routeId === zone.branch.id
    && piece.tag === 'edgeLine' && piece.boundary === `edge:${zone.hostwardSign}`
    && overlap(piece.sFrom, piece.sTo, zone.branchSpan[0], zone.branchSpan[1]) > 0);
  const current = hostward.length
    ? `${Math.min(...hostward.map((piece) => piece.sFrom)).toFixed(1)}..${Math.max(...hostward.map((piece) => piece.sTo)).toFixed(1)}`
    : 'none';
  const owners = [...new Set(strips
    .filter((piece) => piece.junctionZoneIds?.includes(zone.id))
    .map((piece) => piece.owner))].sort();
  console.log(`  ${label}: ${zone.kind} ${zone.side > 0 ? 'left' : 'right'} ${zone.branch.id}(${zone.branch.lanes}) -> ${zone.host.id}(${zone.host.lanes})`
    + ` | A-B branch=${opening.map((value) => value.toFixed(2)).join('..')}`
    + ` host=${zone.markingOpening?.host?.map((value) => value.toFixed(2)).join('..') || zone.crossable.host.map((value) => value.toFixed(2)).join('..')}`
    + ` | current host-facing pieces=${current}`
    + ` | owners=${owners.join(',') || 'none'}`);
}

for (const line of failureSamples) console.log(line);
if (failures > failureSamples.length) console.log(`... ${failures - failureSamples.length} additional failures omitted`);
if (!Number.isFinite(summary.shortestAccidentalFragment)) summary.shortestAccidentalFragment = 0;
console.log('\nA-B metrics:');
console.log(`zones=${summary.zones} exact-openings=${summary.authoritativeOpenings} strips=${summary.strips}`);
console.log(`max A/B cut-position error=${summary.maxCutError.toFixed(3)} m`);
console.log(`shortest accidental fragment=${summary.shortestAccidentalFragment.toFixed(3)} m`);
console.log(`longest illegal opening penetration=${summary.longestIllegalPenetration.toFixed(3)} m`);
console.log(`route-local opening pieces=${summary.routeLocalOpeningPieces} solid-edge penetrations=${summary.solidEdgePenetrations} bridging quads=${summary.bridgingQuads}`);
console.log(`duplicate-boundary count=${summary.duplicateBoundaries} host-divider wrongful-suppression count=${summary.hostDividerWrongfulSuppressions} one-lane internal-divider count=${summary.oneLaneInternalDividers}`);
if (VERBOSE) console.log(`instrumentation-missing=${summary.instrumentationMissing}`);

if (failures) {
  console.log(`A-B MARKING CLIPPING PROBE: FAIL (${failures})`);
  process.exit(1);
}
console.log('A-B MARKING CLIPPING PROBE: PASS');
