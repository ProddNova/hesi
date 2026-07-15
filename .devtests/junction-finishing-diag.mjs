/**
 * JUNCTION-FINISHING DIAGNOSTIC — plan-view visualisation + measurements
 * for representative same-level lateral junctions (one right merge, one
 * left merge, one diverge), answering the questions the finishing pass
 * needs before touching code:
 *
 *  1. TRAJECTORY — where does the branch DRIVING path (route curve = what
 *     physics corridors and traffic lanes follow) sit relative to the
 *     host's outer lane centre through the merge zone, and how big is the
 *     lateral snap at the traffic transfer?
 *  2. MARKINGS — which solid lines cross the mergeable boundary (host edge
 *     line through the union), where branch paint starts/stops.
 *  3. RAILS — the actual rail suppression intervals per route/side and the
 *     size of the gap/step at each rail terminal.
 *
 * Writes .devtests/diag/J-<case>[-suffix].svg + a console report.
 * Run: node .devtests/junction-finishing-diag.mjs [suffix]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, '.devtests', 'diag');
await mkdir(OUT, { recursive: true });
const suffixArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const SUFFIX = suffixArg ? `-${suffixArg}` : '';

const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false });
console.warn = origWarn;

const CASES = [
  { name: 'right-merge-r1_3-ramp_12', branch: 'ramp_12', host: 'r1_3', which: 'end' },
  { name: 'left-merge-k1_0-ramp_42', branch: 'ramp_42', host: 'k1_0', which: 'end' },
  { name: 'right-diverge-c1_0-ramp_22', branch: 'ramp_22', host: 'c1_0', which: 'start' },
];

/** Host outer lane centre lateral (signed, base normal) on `side`. */
function outerLaneCentreLat(host, side) {
  return side * (host.lanes - 1) * 0.5 * host.laneWidth;
}

function frameOf(route, s) { return map._frameAt(route, s); }

for (const spec of CASES) {
  const branch = map.getRoute(spec.branch);
  const host = map.getRoute(spec.host);
  const mouth = (branch.junctionMouths || []).find((m) => m.which === spec.which && m.host === host);
  const edge = map.edges.find((e) => (spec.which === 'end'
    ? e.kind === 'merge' && e.from.routeId === branch.id && e.to.routeId === host.id
    : e.kind === 'diverge' && e.to.routeId === branch.id && e.from.routeId === host.id));
  if (!mouth || !edge) { console.log(`SKIP ${spec.name}: mouth=${!!mouth} edge=${!!edge}`); continue; }
  const side = mouth.side;
  console.log(`\n=== ${spec.name} (${mouth.kind}, side=${side > 0 ? 'left(+)' : 'right(-)'}, span=${mouth.span.toFixed(0)} m) ===`);

  // --- 1. trajectory table over the mouth span (branch tail/head) ------
  const laneCentre = outerLaneCentreLat(host, side);
  const scanLen = Math.min(mouth.span + 80, branch.length);
  const rows = [];
  for (let s = 0; s <= scanLen; s += 8) {
    const station = spec.which === 'start' ? s : branch.length - s;
    const f = frameOf(branch, station);
    const p = map._projectToRoute(host, f.position);
    if (p.endOvershoot > 4) continue;
    const hostF = frameOf(host, p.distance);
    const dLat = p.signedLateral; // branch centre in host frame
    const deckY = p.point.y + Math.tan(hostF.bank) * dLat;
    const tangentDot = Math.abs(f.tangent.dot(hostF.tangent));
    rows.push({
      s, station, hostS: p.distance,
      lat: dLat, latVsLane: dLat - laneCentre,
      outer: dLat + side * branch.halfWidth, hostHalf: hostF.half,
      dy: f.position.y - deckY,
      angDeg: Math.acos(Math.min(1, tangentDot)) * 180 / Math.PI,
    });
  }
  console.log('  s(branch from mouth) | lat(host) | lat-vs-outer-lane-centre | unionOuter-hostHalf | dy | tangent-mismatch-deg');
  for (const r of rows.filter((_, i) => i % 3 === 0)) {
    console.log(`  ${String(r.s).padStart(5)} | ${r.lat.toFixed(2).padStart(7)} | ${r.latVsLane.toFixed(2).padStart(7)} | ${(side * r.outer - r.hostHalf).toFixed(2).padStart(7)} | ${r.dy.toFixed(3).padStart(7)} | ${r.angDeg.toFixed(1).padStart(5)}`);
  }

  // --- 2. traffic transfer snap ----------------------------------------
  if (spec.which === 'end') {
    const travel = 6;
    for (let L = 0; L < branch.lanes; L += 1) {
      const laneRef = { routeId: branch.id, laneIndex: L, direction: 1, length: branch.length, closed: false, laneCount: branch.lanes };
      const s0 = branch.length - 3;
      const before = map.sampleLane(branch.id, s0, L, 1);
      const result = map.advanceTraffic({ laneRef, s: s0, distance: travel, vehicle: { poolIndex: 1 } });
      const excess = Math.abs(before.position.distanceTo(result.position) - travel);
      console.log(`  MERGE TRANSFER lane ${L}: ${branch.id}@${s0.toFixed(0)} -> ${result.routeId}@${result.s.toFixed(0)} lane=${result.laneIndex} excessDisplacement=${excess.toFixed(2)} m (transferred=${result.transferred})`);
    }
    const before = map.sampleLane(branch.id, branch.length - 3, 0, 1);
    const beforeLat = map._projectToRoute(host, before.position).signedLateral;
    console.log(`  branch lane-0 end lateral in host frame: ${beforeLat.toFixed(2)} (outer lane centre ${laneCentre.toFixed(2)})`);
  } else {
    // diverge hop: vehicle crossing edge.from.distance on the exit-side lane
    const d = edge.from.distance;
    const exitLane = (edge.side ?? -1) > 0 ? 0 : host.lanes - 1;
    const laneRef = { routeId: host.id, laneIndex: exitLane, direction: 1, length: host.length, closed: host.closed, laneCount: host.lanes };
    // force the probabilistic hop by checking geometry directly
    const landingLane = (edge.side ?? -1) > 0 ? 0 : branch.lanes - 1;
    const travel = 6;
    const before = map.sampleLane(host.id, d - 2, exitLane, 1);
    const target = map.sampleLane(branch.id, 4, landingLane, 1);
    const excess = Math.abs(before.position.distanceTo(target.position) - travel);
    console.log(`  DIVERGE HOP lane ${exitLane} -> branch lane ${landingLane}: excessDisplacement=${excess.toFixed(2)} m (edge.side=${edge.side})`);
  }
  // zone record summary
  const zone = (branch._zonesAsBranch || []).find((z) => z.host === host && z.which === spec.which);
  if (zone) {
    const fmt = (iv) => (iv ? `${iv[0].toFixed(0)}..${iv[1].toFixed(0)}` : 'none');
    console.log(`  ZONE: crossable(host)=${fmt(zone.crossable?.host)} edgeSuppress=${fmt(zone.hostEdgeSuppress)} dash=${zone.dash ? `${zone.dash.from.toFixed(0)}..${zone.dash.to.toFixed(0)}@lat ${zone.dashLat.toFixed(2)}` : 'none'}`);
    console.log(`  ZONE rails: hostOpen=${fmt(zone.hostRailOpen)} branchOuterOn=${fmt(zone.branchOuterRailOn)} branchOuterOff=${fmt(zone.branchOuterRailOff)} branchInnerOff=${fmt(zone.branchInnerRailOff)}`);
  } else {
    console.log('  ZONE: MISSING');
  }

  // --- 3. markings: solid host edge line across the mergeable zone -----
  // The host's edge line on `side` is painted at side*(half-0.75) for the
  // FULL route (no zone suppression today). Count stations inside the
  // union (branch overlapping) where that solid line lies between the
  // host's outer lane edge and the union's outer edge = a solid line
  // through the crossable zone.
  const zoneForPaint = (branch._zonesAsBranch || []).find((z) => z.host === host && z.which === spec.which);
  let solidAcross = 0;
  let candidates = 0;
  for (const row of zoneForPaint ? zoneForPaint.samples : []) {
    // The zone's own authoritative openings: crossable stations whose
    // one-surface union extends past the host edge. A solid host edge
    // line through one of those is a marking-ownership defect.
    if (!row.crossable || row.crossOuter <= row.hostHalf + 0.25) continue;
    candidates += 1;
    const suppressed = zoneForPaint.hostContains(zoneForPaint.hostEdgeSuppress, row.hS);
    if (!suppressed) solidAcross += 1;
  }
  console.log(`  MARKINGS: host solid edge line crossing the mergeable union at ${solidAcross}/${candidates} crossable-open stations (0 = zone ownership works)`);

  // --- 4. rail suppression intervals + terminal steps ------------------
  const railIntervals = (route, sideSign, from, to) => {
    const intervals = [];
    let run = null;
    for (let s = from; s <= to; s += 3) {
      const f = frameOf(route, s);
      // same resolution the builder uses: zone ownership first, then probe
      const mode = map._railZoneMode(route, sideSign, s);
      let suppressed;
      if (mode === 'off') suppressed = true;
      else if (mode === 'on') suppressed = false;
      else {
        const probe = map._deckPoint(f, sideSign * (f.half - 0.42), 0.02);
        suppressed = map._barrierSuppressed(probe, route);
      }
      if (!suppressed && !run) run = { start: s };
      if (suppressed && run) { run.end = s; intervals.push(run); run = null; }
    }
    if (run) { run.end = to; intervals.push(run); }
    return intervals;
  };
  const bFrom = spec.which === 'start' ? 0 : Math.max(0, branch.length - scanLen);
  const bTo = spec.which === 'start' ? scanLen : branch.length;
  const hs = rows.map((r) => r.hostS);
  const hFrom = Math.min(...hs) - 30;
  const hTo = Math.max(...hs) + 30;
  for (const [route, sideSign, label, lo, hi] of [
    [branch, side * -1, 'branch outer(rail away from host)', bFrom, bTo],
    [branch, side, 'branch hostward', bFrom, bTo],
    [host, side, 'host mergeside', hFrom, hTo],
  ]) {
    // NOTE branch frame: hostward direction in branch frame ~ -side? measure:
    const midS = (lo + hi) / 2;
    const f = frameOf(route, midS);
    const pPlus = map._projectToRoute(route === host ? branch : host, map._deckPoint(f, f.half));
    const pMinus = map._projectToRoute(route === host ? branch : host, map._deckPoint(f, -f.half));
    const hostwardSign = Math.abs(pPlus.signedLateral) < Math.abs(pMinus.signedLateral) ? 1 : -1;
    const s2 = label.includes('hostward') ? hostwardSign : (label.includes('outer') ? -hostwardSign : sideSign);
    const runs = railIntervals(route, s2, Math.max(0, lo), Math.min(route.length, hi));
    console.log(`  RAIL ${label} [${s2 > 0 ? '+' : '-'}]: ${runs.map((r) => `${r.start.toFixed(0)}..${r.end.toFixed(0)}`).join(', ') || 'none drawn'}`);
  }

  // --- 5. SVG plan view -------------------------------------------------
  const pts = [];
  const push = (x, z) => pts.push([x, z]);
  const hostPts = [];
  for (let h = hFrom; h <= hTo; h += 5) {
    const f = frameOf(host, map._normalizeDistance(host, h));
    hostPts.push(f);
    push(f.position.x, f.position.z);
  }
  const branchPts = [];
  for (let s = Math.max(0, bFrom - 60); s <= Math.min(branch.length, bTo + 20); s += 5) {
    const f = frameOf(branch, s);
    branchPts.push(f);
    push(f.position.x, f.position.z);
  }
  const xs = pts.map((p) => p[0]);
  const zs = pts.map((p) => p[1]);
  const minX = Math.min(...xs) - 20;
  const maxX = Math.max(...xs) + 20;
  const minZ = Math.min(...zs) - 20;
  const maxZ = Math.max(...zs) + 20;
  const W = 1100;
  const scale = W / (maxX - minX);
  const H = Math.ceil((maxZ - minZ) * scale);
  const X = (x) => ((x - minX) * scale).toFixed(1);
  const Z = (z) => (H - (z - minZ) * scale).toFixed(1);
  const path = (frames, latFn) => frames
    .map((f, i) => {
      const lat = latFn(f);
      if (lat === null) return null;
      const p = map._deckPoint(f, lat);
      return `${i === 0 ? 'M' : 'L'}${X(p.x)},${Z(p.z)}`;
    })
    .filter(Boolean).join(' ');
  const seg = [];
  seg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#0b0d12">`);
  // paved envelopes
  const ribbon = (frames, color, opacity) => {
    const left = frames.map((f) => { const p = map._deckPoint(f, f.half); return `${X(p.x)},${Z(p.z)}`; });
    const right = frames.map((f) => { const p = map._deckPoint(f, -f.half); return `${X(p.x)},${Z(p.z)}`; }).reverse();
    seg.push(`<polygon points="${[...left, ...right].join(' ')}" fill="${color}" fill-opacity="${opacity}"/>`);
  };
  ribbon(hostPts, '#3b82f6', 0.25);
  ribbon(branchPts, '#22c55e', 0.25);
  // centrelines
  seg.push(`<path d="${path(hostPts, () => 0)}" stroke="#3b82f6" stroke-width="2" fill="none"/>`);
  seg.push(`<path d="${path(branchPts, () => 0)}" stroke="#22c55e" stroke-width="2" fill="none"/>`);
  // host outer lane centre (the target the merge should land on)
  seg.push(`<path d="${path(hostPts, () => laneCentre)}" stroke="#eab308" stroke-width="1.6" stroke-dasharray="8 5" fill="none"/>`);
  // host edge line (solid marking as painted today)
  seg.push(`<path d="${path(hostPts, (f) => side * (f.half - 0.75))}" stroke="#e2e8f0" stroke-width="1.2" fill="none"/>`);
  // rails actually drawn (sampled)
  const railDots = (route, frames, s2, color) => {
    for (const f of frames) {
      const probe = map._deckPoint(f, s2 * (f.half - 0.42), 0.02);
      if (!map._barrierSuppressed(probe, route)) {
        seg.push(`<circle cx="${X(probe.x)}" cy="${Z(probe.z)}" r="1.6" fill="${color}"/>`);
      }
    }
  };
  railDots(host, hostPts, side, '#f97316');
  railDots(host, hostPts, -side, '#f97316');
  railDots(branch, branchPts, 1, '#f43f5e');
  railDots(branch, branchPts, -1, '#f43f5e');
  seg.push(`<text x="12" y="20" fill="#cbd5e1" font-size="14">${spec.name} — blue=host, green=branch, yellow-dash=outer lane centre (merge target), white=host edge line, orange/red=rail present</text>`);
  seg.push('</svg>');
  await writeFile(join(OUT, `J-${spec.name}${SUFFIX}.svg`), seg.join('\n'));
  console.log(`  svg: .devtests/diag/J-${spec.name}${SUFFIX}.svg`);
}
console.log('\nDIAG DONE');
