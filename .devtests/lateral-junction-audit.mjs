/**
 * SAME-LEVEL LATERAL JUNCTION AUDIT (Phase 1 of the junction rebuild).
 *
 * Catalogues every real merge/diverge connection in the runtime network
 * (connection metadata only — a road visually crossing another without an
 * edge is NOT a junction). For each connection it measures, from the same
 * primitives the engine drives on:
 *
 *  - host / branch routes, merge|diverge, left|right side of the host;
 *  - connection station on the host, transfer gap + height step;
 *  - tangent mismatch between branch mouth and host at the connection;
 *  - width / lane configuration of both roads;
 *  - elevation difference across the whole blend span (same-level check);
 *  - whether a guardrail is still drawn across the open mouth (host edge
 *    stations on the branch side that overlap the branch corridor but are
 *    not barrier-suppressed, and vice versa on the branch);
 *  - asphalt continuity through the mouth: overlap depth, vertical
 *    separation inside the overlap (z-fight risk when ~coplanar), and the
 *    first gap (hole) between the two paved edges before they split.
 *
 * Run:  node .devtests/lateral-junction-audit.mjs [--json]
 * Writes .devtests/lateral-junction-audit.json for the status doc.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { HighwayMap } = await import('../js/map.js');
const origWarn = console.warn;
console.warn = () => {};
const map = new HighwayMap(null, { addLighting: false });
console.warn = origWarn;

const deg = (rad) => rad * 180 / Math.PI;

/** Deck-edge barrier probe point, mirroring _buildRouteGeometry's parapet base. */
function edgeProbe(route, distance, side) {
  const frame = map._frameAt(route, distance);
  return map._deckPoint(frame, side * (frame.half - 0.42), 0.02);
}

/** Does `other`'s paved deck cover `point` (same level)? */
function coveredBy(point, other) {
  const projection = map._projectToRoute(other, point);
  if (projection.endOvershoot > 2) return false;
  const half = map._halfWidthAt(other, projection.distance);
  const bank = map._bankAt(other, projection.distance);
  const deckY = projection.point.y + Math.tan(bank) * projection.signedLateral;
  return Math.abs(projection.signedLateral) < half - 0.2 && Math.abs(point.y - deckY) < 4;
}

const rows = [];
for (const edge of map.edges) {
  if (edge.kind !== 'diverge' && edge.kind !== 'merge') continue;
  const isDiverge = edge.kind === 'diverge';
  const branch = map.routes.get(isDiverge ? edge.to.routeId : edge.from.routeId);
  const host = map.routes.get(isDiverge ? edge.from.routeId : edge.to.routeId);
  if (!branch || !host || branch === host) continue;
  const hostDistance = isDiverge ? edge.from.distance : edge.to.distance;

  // Side of the host the branch sits on: sample the branch a little away
  // from its mouth and project onto the host. Base normal +1 = driver's
  // LEFT (left-hand traffic; see _defineServiceAreas).
  const probeAt = isDiverge ? Math.min(60, branch.length * 0.4) : Math.max(branch.length - 60, branch.length * 0.6);
  const branchProbe = map._sampleCenter(branch, probeAt, 1);
  const hostProjection = map._projectToRoute(host, branchProbe.position);
  const side = hostProjection.signedLateral >= 0 ? 1 : -1;
  const sideName = side > 0 ? 'left' : 'right';

  // Transfer step: the exact points the ramp-drive validator compares.
  const exitLane = edge.side !== undefined ? (edge.side > 0 ? 0 : host.lanes - 1) : host.lanes - 1;
  const hostAt = map.sampleLane(host.id, hostDistance, isDiverge ? exitLane : (edge.mergeLane ?? host.lanes - 1), 1);
  const branchAt = map.sampleLane(branch.id, isDiverge ? 0 : branch.length, 0, 1);
  const transferJump = hostAt.position.distanceTo(branchAt.position);
  const transferDrop = branchAt.position.y - hostAt.position.y;

  // Tangent mismatch at the mouth (plan angle).
  const hostTangent = map._sampleCenter(host, hostDistance, 1).tangent;
  const branchTangent = map._sampleCenter(branch, isDiverge ? 0 : branch.length, 1).tangent;
  const cross = hostTangent.z * branchTangent.x - hostTangent.x * branchTangent.z;
  const dot = hostTangent.x * branchTangent.x + hostTangent.z * branchTangent.z;
  const tangentMismatch = deg(Math.abs(Math.atan2(cross, dot)));

  // Walk the branch away from the mouth: paved continuity + level check.
  // Records overlap of the two paved surfaces, vertical separation inside
  // the overlap, the station where the edges finally split, and any hole
  // (gap while still inside the junction mouth).
  let maxOverlap = 0;          // how deep the paved surfaces interpenetrate (m)
  let minVerticalInOverlap = Infinity; // z-fight risk when ~0 and quads are coplanar
  let maxVerticalInOverlap = 0;
  let splitStation = null;     // branch station where paved edges separate
  let firstGap = null;         // {s, gap} first hole before the split
  let maxLevelDelta = 0;       // same-level check across the blend span
  const walkSpan = Math.min(300, branch.length - 4);
  for (let s = 2; s <= walkSpan; s += 4) {
    const branchStation = isDiverge ? s : branch.length - s;
    const sample = map._sampleCenter(branch, branchStation, 1);
    const projection = map._projectToRoute(host, sample.position);
    if (projection.endOvershoot > 2) break;
    const hostHalf = map._halfWidthAt(host, projection.distance);
    const branchHalf = map._halfWidthAt(branch, branchStation);
    const separation = Math.abs(projection.signedLateral) - (hostHalf + branchHalf);
    const hostBank = map._bankAt(host, projection.distance);
    const hostDeckY = projection.point.y + Math.tan(hostBank) * projection.signedLateral;
    const dy = Math.abs(sample.position.y - hostDeckY);
    if (dy < 6) maxLevelDelta = Math.max(maxLevelDelta, dy);
    if (separation < 0) {
      maxOverlap = Math.max(maxOverlap, -separation);
      minVerticalInOverlap = Math.min(minVerticalInOverlap, dy);
      maxVerticalInOverlap = Math.max(maxVerticalInOverlap, dy);
      if (splitStation === null && firstGap !== null) firstGap = null; // rejoined — not a hole
    } else if (splitStation === null) {
      if (separation > 1.0) splitStation = s;
      else if (firstGap === null && separation > 0.15) firstGap = { s, gap: +separation.toFixed(2) };
    }
    if (splitStation !== null && dy > 6) break;
  }

  // Guardrail across the opening: host-edge stations (branch side) whose
  // probe point is covered by the branch's paved deck but NOT suppressed —
  // i.e. a parapet drawn through the junction mouth. Same probe for the
  // branch's host-side rail where the host covers it.
  const anchorSpan = 95; // widest blend the anchoring uses
  let hostRailAcross = 0;
  let hostRailStations = 0;
  for (let d = hostDistance - anchorSpan * 2; d <= hostDistance + anchorSpan * 2; d += 6) {
    const distance = map._normalizeDistance(host, d);
    const probe = edgeProbe(host, distance, side);
    if (!coveredBy(probe, branch)) continue;
    hostRailStations += 1;
    if (!map._barrierSuppressed(probe, host)) hostRailAcross += 1;
  }
  let branchRailAcross = 0;
  let branchRailStations = 0;
  for (let s = 2; s <= Math.min(anchorSpan * 2, branch.length - 2); s += 6) {
    const branchStation = isDiverge ? s : branch.length - s;
    for (const branchSide of [1, -1]) {
      const probe = edgeProbe(branch, branchStation, branchSide);
      if (!coveredBy(probe, host)) continue;
      branchRailStations += 1;
      if (!map._barrierSuppressed(probe, branch)) branchRailAcross += 1;
    }
  }

  rows.push({
    edge: `${edge.from.routeId}@${edge.from.distance.toFixed(0)} -> ${edge.to.routeId}@${edge.to.distance.toFixed(0)}`,
    kind: edge.kind,
    host: host.id,
    branch: branch.id,
    branchKind: branch.kind,
    paAccess: branch.kind === 'service' || host.kind === 'service',
    side: sideName,
    anchored: edge.side !== undefined,
    hostDistance: +hostDistance.toFixed(0),
    hostLanes: host.lanes,
    branchLanes: branch.lanes,
    hostHalfWidth: +map._halfWidthAt(host, hostDistance).toFixed(2),
    branchHalfWidth: +branch.halfWidth.toFixed(2),
    transferJump: +transferJump.toFixed(2),
    transferDrop: +transferDrop.toFixed(2),
    tangentMismatchDeg: +tangentMismatch.toFixed(1),
    maxLevelDelta: +maxLevelDelta.toFixed(2),
    sameLevel: maxLevelDelta < 3.0,
    pavedOverlapDepth: +maxOverlap.toFixed(2),
    overlapVerticalMin: minVerticalInOverlap === Infinity ? null : +minVerticalInOverlap.toFixed(3),
    overlapVerticalMax: +maxVerticalInOverlap.toFixed(3),
    zFightRisk: minVerticalInOverlap !== Infinity && minVerticalInOverlap < 0.02,
    splitStation,
    gapBeforeSplit: firstGap,
    hostRailAcrossOpening: `${hostRailAcross}/${hostRailStations}`,
    branchRailAcrossOpening: `${branchRailAcross}/${branchRailStations}`,
  });
}

rows.sort((a, b) => (a.host + a.branch).localeCompare(b.host + b.branch));

const summary = {
  total: rows.length,
  diverges: rows.filter((row) => row.kind === 'diverge').length,
  merges: rows.filter((row) => row.kind === 'merge').length,
  left: rows.filter((row) => row.side === 'left').length,
  right: rows.filter((row) => row.side === 'right').length,
  sameLevel: rows.filter((row) => row.sameLevel).length,
  paAccess: rows.filter((row) => row.paAccess).length,
  withHostRailAcross: rows.filter((row) => Number(row.hostRailAcrossOpening.split('/')[0]) > 0).length,
  withBranchRailAcross: rows.filter((row) => Number(row.branchRailAcrossOpening.split('/')[0]) > 0).length,
  withGapBeforeSplit: rows.filter((row) => row.gapBeforeSplit).length,
  zFightRisk: rows.filter((row) => row.zFightRisk).length,
  transferJumpOver6: rows.filter((row) => row.transferJump > 6).length,
  tangentOver25: rows.filter((row) => row.tangentMismatchDeg > 25).length,
};

const out = fileURLToPath(new URL('./lateral-junction-audit.json', import.meta.url));
writeFileSync(out, JSON.stringify({ summary, rows }, null, 1));
console.log('summary:', JSON.stringify(summary, null, 1));
console.log('');
for (const row of rows) {
  console.log(
    `${row.kind.padEnd(7)} ${row.side.padEnd(5)} host=${row.host}@${row.hostDistance} branch=${row.branch}`
    + ` lanes=${row.hostLanes}/${row.branchLanes} jump=${row.transferJump} drop=${row.transferDrop}`
    + ` tan=${row.tangentMismatchDeg}° lvl=${row.maxLevelDelta}`
    + ` ovl=${row.pavedOverlapDepth} vInOvl=${row.overlapVerticalMin}..${row.overlapVerticalMax}`
    + ` split@${row.splitStation} gap=${row.gapBeforeSplit ? row.gapBeforeSplit.gap + '@' + row.gapBeforeSplit.s : '-'}`
    + ` railHost=${row.hostRailAcrossOpening} railBranch=${row.branchRailAcrossOpening}`
    + `${row.sameLevel ? '' : '  [NOT SAME LEVEL]'}${row.paAccess ? '  [PA]' : ''}`,
  );
}
console.log(`\ncatalogue written to ${out}`);
