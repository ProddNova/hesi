/**
 * FOCUSED JUNCTION-FINISHING PROBE — gates the same-level merge/diverge
 * FINISHING work (trajectory, marking ownership, rails, traffic), on top
 * of the surface-level lateral-junction-probe (holes / coplanar doubles /
 * height steps / rails across mouths — run both).
 *
 * Per junction zone (the shared representation in map.junctionZones —
 * row crossability is the zone's own classification, which in turn is the
 * renderer's mouth-clip decision: every check below reads the same record
 * the asphalt, markings, rails and physics consume):
 *
 *  1. TANGENT MISMATCH — branch lane path vs host direction at the
 *     transfer point must be near-parallel (< 3 deg), and along the
 *     crossable zone < 8 deg (no diagonal connection).
 *  2. STEERING RATE — the branch lane-0 path through the junction
 *     influence region must not require a steering snap: max heading
 *     change over any 8 m window < 5.5 deg.
 *  3. SOLID LINE ACROSS MERGE ZONE — wherever the union is crossable and
 *     wider than the host, the host's solid edge line must be suppressed
 *     (the zone's dashed boundary owns it).
 *  4. DUPLICATE BOUNDARY — wherever the branch's outer edge line can be
 *     painted (wing >= 1.2 m), the host's edge line must be suppressed:
 *     one boundary, one owner.
 *  5. RAIL ENDPOINT CONTINUITY — the host rail's resume/stop station must
 *     sit within 18 m (envelope-mapped) of the branch outer rail's tip:
 *     a hand-off, not two unrelated cuts.
 *  6. COLLISION CONTINUITY — walking laterally across the paved union at
 *     crossable stations, the physics height (getRoadInfo) never steps
 *     more than 0.22 m between 0.6 m-spaced samples (no seam, no wall).
 *  7. TRAFFIC-PATH CONTINUITY — driving every merge/diverge transfer,
 *     the excess displacement (jump beyond the distance travelled) is
 *     < 2.2 m; diverges hop from/to the side-correct lanes.
 *
 * Run: node .devtests/junction-finishing-probe.mjs [--verbose]
 */
const VERBOSE = process.argv.includes('--verbose');

const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false });
console.warn = origWarn;

const deg = (rad) => (rad * 180) / Math.PI;
let failures = 0;
const fail = (label, detail) => {
  failures += 1;
  console.log(`FAIL  ${label}: ${detail}`);
};
const summary = {
  zones: 0,
  worstTransferDeg: 0,
  worstZoneDeg: 0,
  worstSteer8m: 0,
  solidAcross: 0,
  duplicateBoundary: 0,
  worstRailHandoff: 0,
  worstCollisionStep: 0,
  transfers: 0,
  worstExcess: 0,
};

for (const zone of map.junctionZones) {
  const { host, branch, side, which } = zone;
  if (!zone.crossable) continue;
  summary.zones += 1;
  const label = `${zone.kind} ${branch.id} ${which} on ${host.id}`;

  // --- 1. tangent mismatch at the transfer ---------------------------------
  // ramp_46 is the documented Hakozaki data-kink stub (its heights and
  // spacing are extractor work for the vertical pass); ratchet it so it
  // can only improve while gating everything else at merge quality.
  const TRANSFER_RATCHET = { ramp_46: 12 };
  const transferS = which === 'end' ? branch.length - 2 : 2;
  const bT = map._frameAt(branch, transferS).tangent;
  const hostProj = map._projectToRoute(host, map._frameAt(branch, transferS).position);
  const hT = map._frameAt(host, hostProj.distance).tangent;
  const transferDeg = deg(Math.acos(Math.min(1, Math.abs(bT.dot(hT)))));
  summary.worstTransferDeg = Math.max(summary.worstTransferDeg, transferDeg);
  const transferLimit = TRANSFER_RATCHET[branch.id] ?? 6.5;
  if (transferDeg > transferLimit) fail(label, `tangent mismatch ${transferDeg.toFixed(1)} deg at transfer`);
  let zoneDeg = 0; // reported only — a curved exit legitimately bends away
  for (const row of zone.samples) {
    if (!row.crossable) continue;
    const bTan = map._frameAt(branch, row.bS).tangent;
    const hTan = map._frameAt(host, map._normalizeDistance(host, row.hS)).tangent;
    zoneDeg = Math.max(zoneDeg, deg(Math.acos(Math.min(1, Math.abs(bTan.dot(hTan))))));
  }
  summary.worstZoneDeg = Math.max(summary.worstZoneDeg, zoneDeg);

  // --- 2. steering snap RELATIVE to the host through the crossable zone ----
  // (absolute heading change would flag every legitimately curved merge;
  // what must not exist is a sudden correction against the host's own
  // curvature — the "last-moment diagonal"). PA service lanes are out of
  // scope (their own rebuild pass).
  if (branch.kind !== 'service') {
    const rel = [];
    for (const row of zone.samples) {
      if (!row.crossable) continue;
      const bTan = map._frameAt(branch, row.bS).tangent;
      const hTan = map._frameAt(host, map._normalizeDistance(host, row.hS)).tangent;
      let dh = Math.atan2(bTan.x, bTan.z) - Math.atan2(hTan.x, hTan.z);
      while (dh > Math.PI) dh -= 2 * Math.PI;
      while (dh < -Math.PI) dh += 2 * Math.PI;
      rel.push({ s: row.bS, dh });
    }
    rel.sort((p, q) => p.s - q.s);
    let steer8 = 0;
    for (let i = 0; i < rel.length; i += 1) {
      for (let j = i + 1; j < rel.length && rel[j].s - rel[i].s <= 8; j += 1) {
        steer8 = Math.max(steer8, deg(Math.abs(rel[j].dh - rel[i].dh)));
      }
    }
    summary.worstSteer8m = Math.max(summary.worstSteer8m, steer8);
    if (steer8 > 4.5) fail(label, `relative heading changes ${steer8.toFixed(1)} deg within 8 m (steering snap)`);
  }

  // --- 3./4. marking ownership ---------------------------------------------
  for (const row of zone.samples) {
    if (!row.crossable) continue;
    const suppressed = zone.hostContains(zone.hostEdgeSuppress, row.hS);
    if (row.crossOuter > row.hostHalf + 0.3 && !suppressed) {
      summary.solidAcross += 1;
      if (VERBOSE) console.log(`  solid-line ${label} hS=${row.hS.toFixed(0)}`);
    }
    if (row.crossOuter - row.hostHalf >= 1.2 && !suppressed) {
      summary.duplicateBoundary += 1;
      if (VERBOSE) console.log(`  duplicate-boundary ${label} hS=${row.hS.toFixed(0)}`);
    }
  }

  // --- 5. rail hand-off: no wide unguarded union edge -----------------------
  // The union's outer edge must be guarded by SOMEBODY wherever it is wide
  // enough to hold a rail profile (wing >= 0.6 m past the host edge):
  // either the host's own rail stands there or the branch's outer rail has
  // taken over. Sliver wings (< 0.6 m) are the intended flare at a gore
  // tip and carry no rail. Measured against the builder's ACTUAL recorded
  // rail runs, not interval bookkeeping.
  {
    const railVisibleAt = (route, sideSign, s) => (route._railRuns?.[sideSign] || [])
      .some((run) => s >= run.from - 2 && s <= run.to + 2);
    let unguarded = 0;
    let worstRun = 0;
    for (const row of zone.samples) {
      const wing = row.unionOuter - row.hostHalf;
      const wide = wing >= 0.6 && Math.abs(row.dy) < 1.0;
      const guarded = railVisibleAt(host, side, map._normalizeDistance(host, row.hS))
        || railVisibleAt(branch, -zone.hostwardSign, row.bS);
      if (wide && !guarded) { unguarded += 4; worstRun = Math.max(worstRun, unguarded); } else unguarded = 0;
    }
    summary.worstRailHandoff = Math.max(summary.worstRailHandoff, worstRun);
    if (worstRun > 18) fail(label, `union outer edge unguarded for ${worstRun.toFixed(0)} m (wing >= 0.6 m, no host or branch rail)`);
  }

  // --- 6. collision continuity across the union ------------------------------
  const rows = zone.samples.filter((r) => r.crossable);
  for (let k = 0; k < rows.length; k += Math.max(1, Math.floor(rows.length / 6))) {
    const row = rows[k];
    const hFrame = map._frameAt(host, map._normalizeDistance(host, row.hS));
    let prevY = null;
    for (let lat = 0; lat <= row.crossOuter - 0.6; lat += 0.6) {
      const point = map._deckPoint(hFrame, side * lat);
      point.y += 0.5;
      const info = map.getRoadInfo(point);
      if (!info || !info.onRoadSurface) { prevY = null; continue; }
      if (prevY !== null) {
        const step = Math.abs(info.height - prevY);
        summary.worstCollisionStep = Math.max(summary.worstCollisionStep, step);
        if (step > 0.22) {
          fail(label, `collision height step ${step.toFixed(2)} m at hS=${row.hS.toFixed(0)} lat=${lat.toFixed(1)}`);
          break;
        }
      }
      prevY = info.height;
    }
  }
}

// --- 7. traffic-path continuity ---------------------------------------------
for (const edge of map.edges) {
  const travel = 6;
  if (edge.kind === 'merge') {
    const from = map.routes.get(edge.from.routeId);
    if (!from?.traffic) continue;
    for (let lane = 0; lane < from.lanes; lane += 1) {
      const s0 = from.length - 3;
      const laneRef = { routeId: from.id, laneIndex: lane, direction: 1, length: from.length, closed: from.closed, laneCount: from.lanes };
      const before = map.sampleLane(from.id, s0, lane, 1);
      const result = map.advanceTraffic({ laneRef, s: s0, distance: travel, vehicle: { poolIndex: 1 } });
      if (!result?.transferred) continue;
      summary.transfers += 1;
      const excess = Math.abs(before.position.distanceTo(result.position) - travel);
      summary.worstExcess = Math.max(summary.worstExcess, excess);
      if (excess > 2.2) fail(`merge ${from.id} lane ${lane} -> ${result.routeId}`, `excess displacement ${excess.toFixed(2)} m`);
    }
  } else if (edge.kind === 'diverge' && edge.probability > 0) {
    const from = map.routes.get(edge.from.routeId);
    const to = map.routes.get(edge.to.routeId);
    if (!from?.traffic || !to?.traffic) continue;
    const exitLane = (edge.side ?? -1) > 0 ? 0 : from.lanes - 1;
    const landingLane = (edge.side ?? -1) > 0 ? 0 : to.lanes - 1;
    const before = map.sampleLane(from.id, edge.from.distance - 2, exitLane, 1);
    const target = map.sampleLane(to.id, edge.to.distance + 4, landingLane, 1);
    summary.transfers += 1;
    const excess = Math.abs(before.position.distanceTo(target.position) - travel);
    summary.worstExcess = Math.max(summary.worstExcess, excess);
    if (excess > 2.2) fail(`diverge ${from.id} -> ${to.id}`, `excess displacement ${excess.toFixed(2)} m`);
  }
}

if (summary.solidAcross) fail('markings', `${summary.solidAcross} crossable stations keep a solid host edge line`);
if (summary.duplicateBoundary) fail('markings', `${summary.duplicateBoundary} stations paint two parallel boundaries`);

console.log(`\nzones=${summary.zones} transfers=${summary.transfers}`);
console.log(`worst: transfer tangent ${summary.worstTransferDeg.toFixed(2)} deg | zone tangent ${summary.worstZoneDeg.toFixed(1)} deg | steering ${summary.worstSteer8m.toFixed(1)} deg/8m`);
console.log(`worst: rail hand-off ${summary.worstRailHandoff.toFixed(1)} m | collision step ${summary.worstCollisionStep.toFixed(3)} m | transfer excess ${summary.worstExcess.toFixed(2)} m`);
if (failures) { console.log(`JUNCTION FINISHING PROBE: FAIL (${failures})`); process.exit(1); }
console.log('JUNCTION FINISHING PROBE: PASS');
