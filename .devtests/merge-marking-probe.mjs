/**
 * MERGE-MARKING PROBE — merge-local marking ownership, gating the
 * "merge-markings-guardrails-final" pass. Complements
 * marking-orientation-probe.mjs (which already catches diagonal/zig-zag
 * paint globally) with checks specific to same-level merge/diverge zones:
 *
 *  1. NO EARLY/LATE INCOMING EDGE LINE — inside a zone's crossable.branch
 *     span, the branch must never paint its own edge line on the
 *     host-ward side (hostwardSign). That boundary belongs to the zone's
 *     host-side suppress/dash marking; the branch's own per-frame
 *     coplanar clip lags the zone by tens of metres on a shallow taper,
 *     which is exactly the reported "line belonging to the incoming road
 *     appears too early / cuts across the host road" bug.
 *  2. ONE OWNER PER BOUNDARY — at any host station inside hostEdgeSuppress,
 *     no host edgeLine piece may be painted on the suppressed side (it
 *     must be fully handed to the zone's dash), and vice versa outside it.
 *  3. HOST DASH ONLY INSIDE THE TRUE OVERLAP — every zoneDash piece must
 *     fall within its zone's crossable.host span (never painted where the
 *     union isn't actually one drivable surface).
 *  4. NO SLASH/BACKSLASH ON A BRANCH EDGE — for one-lane branches
 *     specifically (no interior lane divider to hide a boundary swap
 *     behind), consecutive branch edgeLine pieces on the outer side must
 *     not reverse lateral sign — that reversal is exactly the diagonal
 *     "/ \" zig-zag pattern.
 *
 * Run: node .devtests/merge-marking-probe.mjs [--verbose]
 */
const VERBOSE = process.argv.includes('--verbose');
const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false, markingDebug: true });
console.warn = origWarn;

let failures = 0;
const fail = (label, detail) => {
  failures += 1;
  console.log(`FAIL  ${label}: ${detail}`);
};

const strips = map._markingLog.filter((p) => p.kind === 'strip');
const summary = { zonesChecked: 0, earlyEdge: 0, dashOutsideOverlap: 0, hostDup: 0, oneLaneReversal: 0 };

const zones = (map.junctionZones || []).filter((z) => z.markingOpening || z.crossable);

// 1. no branch edge line on the host-ward side inside crossable.branch
for (const zone of zones) {
  summary.zonesChecked += 1;
  const opening = zone.markingOpening?.branch || zone.crossable.branch;
  const branchPieces = strips.filter((p) => p.tag === 'edgeLine' && p.routeId === zone.branch.id);
  for (const piece of branchPieces) {
    const mid = (piece.sFrom + piece.sTo) * 0.5;
    if (mid < opening[0] || mid > opening[1]) continue;
    const side = Math.sign(piece.latFrom);
    if (side !== zone.hostwardSign) continue;
    summary.earlyEdge += 1;
    fail('early-incoming-edge', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: branch host-ward edge painted at s=${piece.sFrom.toFixed(0)}..${piece.sTo.toFixed(0)} (inside A-B ${opening[0].toFixed(2)}..${opening[1].toFixed(2)})`);
  }
}

// 2. host edge line never painted inside its own suppress interval, and
// the dash never painted outside the true crossable overlap
for (const zone of zones) {
  if (zone.hostEdgeSuppress) {
    const hostPieces = strips.filter((p) => p.tag === 'edgeLine' && p.routeId === zone.host.id);
    for (const piece of hostPieces) {
      const mid = (piece.sFrom + piece.sTo) * 0.5;
      if (!zone.hostContains(zone.hostEdgeSuppress, mid)) continue;
      const side = Math.sign(piece.latFrom);
      if (side !== zone.side) continue;
      summary.hostDup += 1;
      fail('host-edge-inside-suppress', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: host's own edge line painted at s=${piece.sFrom.toFixed(0)}..${piece.sTo.toFixed(0)} inside its suppress window`);
    }
  }
  if (zone.dash) {
    const opening = zone.markingOpening?.host || zone.crossable.host;
    const dashPieces = strips.filter((p) => p.tag === 'zoneDash' && p.routeId === zone.host.id
      && (p.owner === `junction:${zone.id}`
        || ((p.sFrom + p.sTo) * 0.5 >= zone.dash.from - 1 && (p.sFrom + p.sTo) * 0.5 <= zone.dash.to + 1)));
    for (const piece of dashPieces) {
      const mid = (piece.sFrom + piece.sTo) * 0.5;
      if (zone.hostContains(opening, mid)) continue;
      summary.dashOutsideOverlap += 1;
      fail('dash-outside-overlap', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: zoneDash at s=${piece.sFrom.toFixed(0)} outside A-B ${opening[0].toFixed(2)}..${opening[1].toFixed(2)}`);
    }
  }
}

// 4. one-lane branches: outer edge line must not reverse lateral sign
// (the slash/backslash zig-zag) across the merge/diverge span
for (const zone of zones) {
  if (zone.branch.lanes !== 1) continue;
  const outerSide = -zone.hostwardSign;
  const pieces = strips
    .filter((p) => p.tag === 'edgeLine' && p.routeId === zone.branch.id && Math.sign(p.latFrom) === outerSide)
    .filter((p) => p.sFrom >= zone.branchSpan[0] - 5 && p.sTo <= zone.branchSpan[1] + 5)
    .sort((a, b) => a.sFrom - b.sFrom);
  for (let i = 1; i < pieces.length; i += 1) {
    if (Math.sign(pieces[i].latFrom) !== Math.sign(pieces[i - 1].latFrom)) {
      summary.oneLaneReversal += 1;
      fail('one-lane-zigzag', `${zone.kind} ${zone.branch.id} on ${zone.host.id}: outer edge lateral sign flips at s=${pieces[i].sFrom.toFixed(0)}`);
    }
  }
}

console.log(`\nzones checked=${summary.zonesChecked} strips=${strips.length}`);
console.log(`early-incoming-edge=${summary.earlyEdge} host-edge-inside-suppress=${summary.hostDup} dash-outside-overlap=${summary.dashOutsideOverlap} one-lane-zigzag=${summary.oneLaneReversal}`);
if (failures) { console.log(`MERGE MARKING PROBE: FAIL (${failures})`); process.exit(1); }
console.log('MERGE MARKING PROBE: PASS');
