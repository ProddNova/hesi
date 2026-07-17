/**
 * TATSUMI PA FLOW PROBE — proves the deck is the live player garage/spawn
 * and that the ramp_8 exit is continuously drivable, without re-enabling
 * anything else:
 *
 *  1. ACTIVE GARAGE — tatsumi_pa owns the only hasGarage flag; the ENTER
 *     trigger sits on the drivable deck, fires getGarageTransition, and the
 *     minimap garage marker follows it. Shibaura keeps its lot but not the
 *     workshop.
 *  2. SPAWN — initialSpawn (used by boot, garage exit, tow and crash
 *     recovery alike — game.js placeAtSpawn) is anchored to tatsumi_pa, on
 *     the drivable deck surface, above the collision height, aligned with
 *     the deck axis toward the exit end, clear of the garage shell, the
 *     parked rows, the lamp line and the perimeter fence, and outside the
 *     ENTER trigger radius (no instant re-prompt).
 *  3. EXIT CONTINUITY — the tatsumi_pa_exit centreline and both wheel
 *     tracks resolve to drivable collision at every 0.5 m station with no
 *     height step, and the rendered lane profile never diverges from the
 *     collision profile.
 *  4. OPEN MOUTH — the perimeter fence/kerb opening covers the lane's deck
 *     edge crossing, no wall segment crosses the lane corridor, the host
 *     ramp_8 rail run is open across the glue window, and no branch rail
 *     sits on the hostward side of the glued section.
 *  5. GRADE SEPARATION — both Wangan carriageways still run >= 7 m under
 *     the deck footprint and never resolve to the lot.
 *  6. LEFT-HAND TRAFFIC — the opposing carriageway sits on the driver's
 *     RIGHT along the Wangan pair, every traffic lane runs direction +1,
 *     lane sampling faces the route tangent, the exit merges downstream
 *     into ramp_8 which merges into wangan_0 with >20 km of mainline ahead
 *     (the main Bayshore continuation), and the opposite carriageway
 *     (wangan_1) terminates in the Tatsumi turnaround back onto wangan_0.
 *  7. NOTHING ELSE ENABLED — tatsumi_pa_exit is the only service route, it
 *     carries no traffic lane, and all four PAs keep valid lots; the
 *     paAccessLanes:true twin still restores the legacy Shibaura garage.
 *
 * Run: node .devtests/tatsumi-pa-flow-probe.mjs
 */
const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false });
const twin = new HighwayMap(null, { addLighting: false, paAccessLanes: true });
console.warn = origWarn;

let failures = 0;
const check = (ok, label) => {
  if (!ok) { failures += 1; console.log(`FAIL  ${label}`); }
};

const area = map.serviceAreas.find((candidate) => candidate.id === 'tatsumi_pa');
check(!!area, 'tatsumi_pa service area missing');
const local = (point) => ({
  u: (point.x - area.center.x) * area.tangent.x + (point.z - area.center.z) * area.tangent.z,
  v: (point.x - area.center.x) * area.normal.x + (point.z - area.center.z) * area.normal.z,
});

// --- 1. active garage --------------------------------------------------------
const garageAreas = map.serviceAreas.filter((candidate) => candidate.hasGarage);
check(garageAreas.length === 1 && garageAreas[0].id === 'tatsumi_pa',
  `active garages: ${garageAreas.map((a) => a.id).join(', ') || '(none)'}`);
const entrance = area.garageEntrance;
const entranceInfo = map.getRoadInfo(entrance.clone());
check(!!entranceInfo?.inServiceArea && !!entranceInfo?.drivable, 'ENTER trigger not on the drivable deck');
check(!!map.getGarageTransition(entrance.clone(), 13)?.triggered, 'garage transition does not fire at the trigger');
check(!map.getGarageTransition(entrance.clone().setY(area.elevation - 9), 13),
  'garage transition fires from the Wangan below the deck');
const minimapData = map.getMinimapData();
check(minimapData.garage
  && Math.hypot(minimapData.garage.x - entrance.x, minimapData.garage.z - entrance.z) < 1,
'minimap garage marker off the deck entrance');
check(map.garagePosition.equals(entrance), 'map.garagePosition detached from the deck entrance');

// --- 2. spawn ------------------------------------------------------------------
const spawn = map.initialSpawn;
check(spawn.serviceAreaId === 'tatsumi_pa', `spawn anchored to ${spawn.serviceAreaId}`);
const spawnInfo = map.getRoadInfo(spawn.position.clone());
check(!!spawnInfo?.inServiceArea && !!spawnInfo?.drivable, 'spawn not on the drivable deck');
check(spawn.position.y > spawnInfo.height && spawn.position.y - spawnInfo.height < 1.5,
  `spawn height ${spawn.position.y.toFixed(2)} vs collision ${spawnInfo?.height?.toFixed(2)}`);
check(spawn.tangent.dot(area.tangent) > 0.99, 'spawn not facing along the deck toward the exit end');
const spawnLocal = local(spawn.position);
check(Math.abs(spawnLocal.u) < area.length * 0.5 - 6 && Math.abs(spawnLocal.v) < area.width * 0.5 - 4,
  `spawn too close to the deck edge (u ${spawnLocal.u.toFixed(1)}, v ${spawnLocal.v.toFixed(1)})`);
// Clear of dressing: parked rows sit at -0.28/+0.18 of the width, the lamp
// line on the axis, the shell behind the shutter face, the konbini on the
// far side. (Mirrors the _buildServiceAreaDressing constants.)
const stallRows = [-area.width * 0.28, area.width * 0.18];
for (const row of stallRows) {
  check(Math.abs(spawnLocal.v - row) > 2.0, `spawn inside the parked row at v=${row.toFixed(1)}`);
}
for (const lampU of [-area.length * 0.33, 0, area.length * 0.33]) {
  const keptOut = (area.dressingKeepouts || []).some((keepout) => keepout.side == null
    && lampU >= keepout.from && lampU <= keepout.to);
  if (keptOut) continue;
  check(Math.hypot(spawnLocal.u - lampU, spawnLocal.v) > 2.5, `spawn against the lamp at u=${lampU.toFixed(0)}`);
}
const shell = area.garageShell;
check(!!shell, 'garage shell definition missing');
if (shell) {
  const shellFront = local(shell.anchor);
  check(spawnLocal.u > shellFront.u + 6, 'spawn inside/behind the garage shell');
  check(entrance.distanceTo(spawn.position) > 13, 'spawn inside the ENTER trigger radius (instant re-prompt)');
  check(shell.size.w <= area.width - 4, 'garage shell wider than the deck');
  check(shellFront.u - shell.size.d - 1 > -area.length * 0.5, 'garage shell overhangs the deck end');
}

// --- 3. exit continuity ----------------------------------------------------------
const exitRoute = map.routes.get(area.exitRouteId);
check(!!exitRoute && exitRoute.kind === 'service' && exitRoute.traffic === false,
  'exit route missing or open to traffic');
let worstStep = 0;
let worstRise = 0;
let undrivable = 0;
for (const lateral of [-1.5, 0, 1.5]) {
  let previous = null;
  for (let s = 0; s <= exitRoute.length; s += 0.5) {
    const centre = map._sampleCenter(exitRoute, Math.min(s, exitRoute.length), 1);
    const point = centre.position.clone().addScaledVector(centre.normal, lateral);
    point.y += 0.4;
    const info = map.getRoadInfo(point);
    if (!info?.drivable || !Number.isFinite(info.height)) { undrivable += 1; previous = null; continue; }
    if (previous != null) worstStep = Math.max(worstStep, Math.abs(info.height - previous));
    if (lateral === 0) worstRise = Math.max(worstRise, info.height - centre.position.y);
    previous = info.height;
  }
}
check(undrivable === 0, `${undrivable} undrivable stations along the exit lane`);
check(worstStep < 0.1, `collision step ${worstStep.toFixed(3)} m along the exit (>= 0.1)`);
check(worstRise < 0.3, `collision rises ${worstRise.toFixed(2)} m above the rendered lane (invisible kerb)`);

// --- 4. open mouth ------------------------------------------------------------------
const opening = (area.fenceOpenings || [])[0];
check(!!opening, 'fence opening missing');
let crossU = null;
{
  const fenceLine = area.width * 0.5 - 0.3;
  let previous = null;
  for (let s = 0; s <= exitRoute.length; s += 0.5) {
    const l = local(map._sampleCenter(exitRoute, Math.min(s, exitRoute.length), 1).position);
    if (previous && Math.abs(previous.v) < fenceLine && Math.abs(l.v) >= fenceLine) { crossU = (previous.u + l.u) * 0.5; break; }
    previous = l;
  }
}
check(crossU != null, 'exit lane never crosses the fence line');
if (crossU != null && opening) {
  check(crossU > opening.from + 2 && crossU < opening.to - 2,
    `lane crosses the fence at u=${crossU.toFixed(1)} outside the opening ${opening.from.toFixed(1)}..${opening.to.toFixed(1)}`);
}
// No collision wall crosses the exit corridor.
const segmentsCross = (a1, a2, b1, b2) => {
  const d = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = d(b1, b2, a1); const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1); const d4 = d(a1, a2, b2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
};
let wallHits = 0;
for (let s = 0.5; s <= exitRoute.length; s += 0.5) {
  const a = map._sampleCenter(exitRoute, s - 0.5, 1).position;
  const b = map._sampleCenter(exitRoute, Math.min(s, exitRoute.length), 1).position;
  for (const segment of map.wallSegments || []) {
    if (!segment.a || !segment.b) continue;
    if (Math.abs(((segment.a.y + segment.b.y) * 0.5) - ((a.y + b.y) * 0.5)) > 4) continue;
    if (segmentsCross(a, b, segment.a, segment.b)) wallHits += 1;
  }
}
check(wallHits === 0, `${wallHits} collision wall segments cross the exit lane`);
// Host rail must be open across the glue window; the branch must not carry a
// hostward rail over the glued section.
const ramp8 = map.routes.get('ramp_8');
const hostSpan = map.junctionZones.find((zone) => zone.branch?.id === 'tatsumi_pa_exit')?.hostSpan;
check(!!hostSpan, 'exit merge zone missing');
if (hostSpan) {
  const deckSide = Math.sign(area.center.clone().sub(map._sampleCenter(ramp8, hostSpan[0], 1).position)
    .dot(map._sampleCenter(ramp8, hostSpan[0], 1).normal)) || 1;
  const hostRuns = ramp8._railRuns?.[deckSide] || [];
  const runs = Array.isArray(hostRuns) ? hostRuns : hostRuns.runs || [];
  const blocked = runs.some((run) => {
    const from = run.from ?? run.start ?? run[0];
    const to = run.to ?? run.end ?? run[1];
    return from < hostSpan[1] - 1 && to > hostSpan[0] + 1;
  });
  check(!blocked, 'host guardrail crosses the exit mouth');
}
const branchZone = map.junctionZones.find((zone) => zone.branch?.id === 'tatsumi_pa_exit');
if (branchZone) {
  const hostward = branchZone.hostwardSign;
  const branchRuns = exitRoute._railRuns?.[hostward] || [];
  const runsList = Array.isArray(branchRuns) ? branchRuns : branchRuns.runs || [];
  const glued = runsList.some((run) => {
    const to = run.to ?? run.end ?? run[1];
    return to > branchZone.branchSpan[0] + 30;
  });
  check(!glued, 'branch guardrail extends along the hostward side of the glued section');
}

// --- 5. grade separation ---------------------------------------------------------
for (const wanganId of ['wangan_0', 'wangan_1']) {
  const wangan = map.routes.get(wanganId);
  let sampled = 0;
  for (let s = 0; s < wangan.length; s += 12) {
    const sample = map._sampleCenter(wangan, s, 1);
    const l = local(sample.position);
    if (Math.abs(l.u) > area.length * 0.5 || Math.abs(l.v) > area.width * 0.5) continue;
    sampled += 1;
    check(area.elevation - sample.position.y >= 7,
      `${wanganId}@${s.toFixed(0)} only ${(area.elevation - sample.position.y).toFixed(1)} m under the deck`);
    const info = map.getRoadInfo(sample.position.clone().add({ x: 0, y: 0.4, z: 0 }));
    check(info?.routeId === wanganId,
      `${wanganId}@${s.toFixed(0)} captured by ${info?.routeId ?? info?.serviceAreaId ?? 'nothing'} under the deck`);
  }
  check(sampled > 8, `${wanganId}: only ${sampled} stations under the deck footprint`);
}

// --- 6. left-hand traffic -----------------------------------------------------------
for (const [aId, bId] of [['wangan_0', 'wangan_1'], ['wangan_1', 'wangan_0']]) {
  const routeB = map.routes.get(bId);
  for (const s of [5000, 15000, 25000]) {
    const sample = map._sampleCenter(aId, s, 1);
    const projection = map._projectToRoute(routeB, sample.position);
    if (projection.point.distanceTo(sample.position) > 60) continue;
    const side = projection.point.clone().sub(sample.position).dot(sample.normal);
    check(side > 0, `${bId} on the LEFT of ${aId}@${s} (${side.toFixed(1)} m) — right-hand traffic`);
  }
}
check(map.trafficLanes.every((lane) => lane.direction === 1),
  'traffic lanes with direction != +1 exist');
check(map.trafficLanes.every((lane) => !`${lane.routeId}`.includes('tatsumi')),
  'traffic routes onto the Tatsumi exit');
const laneSample = map.sampleLane('wangan_0', 8000, 0, 1);
const laneTangent = map._sampleCenter('wangan_0', 8000, 1).tangent;
check(laneSample.tangent.dot(laneTangent) > 0.99, 'lane sampling does not face the route tangent');
// Legal continuation: PA exit -> ramp_8 (downstream) -> wangan_0 mainline.
const exitEdge = map.edges.find((edge) => edge.from.routeId === 'tatsumi_pa_exit');
check(exitEdge?.kind === 'merge' && exitEdge?.to.routeId === 'ramp_8', 'exit edge does not merge onto ramp_8');
const rampToWangan = map.edges.find((edge) => edge.from.routeId === 'ramp_8' && edge.kind === 'merge');
check(rampToWangan?.to.routeId === 'wangan_0', `ramp_8 merges into ${rampToWangan?.to.routeId}`);
if (exitEdge && rampToWangan) {
  check(rampToWangan.from.distance > exitEdge.to.distance,
    'ramp_8 reaches wangan_0 upstream of the PA glue (wrong direction)');
  const wangan0 = map.routes.get('wangan_0');
  check(wangan0.length - rampToWangan.to.distance > 20000,
    `only ${((wangan0.length - rampToWangan.to.distance) / 1000).toFixed(1)} km of wangan_0 ahead of the merge`);
  const rampDownhill = map._sampleCenter('ramp_8', exitEdge.to.distance, 1).position.y
    > map._sampleCenter('ramp_8', ramp8.length - 10, 1).position.y;
  check(rampDownhill, 'ramp_8 does not descend toward the Wangan past the PA');
}
// Opposite carriageway reaches the Tatsumi turnaround back onto wangan_0.
const uturnIn = map.edges.find((edge) => edge.from.routeId === 'wangan_1' && `${edge.to.routeId}`.includes('uturn'));
check(!!uturnIn, 'wangan_1 does not reach a turnaround');
if (uturnIn) {
  const uturnOut = map.edges.find((edge) => edge.from.routeId === uturnIn.to.routeId);
  check(uturnOut?.to.routeId === 'wangan_0', `turnaround continues into ${uturnOut?.to.routeId}`);
  const wangan1 = map.routes.get('wangan_1');
  check(wangan1.length - uturnIn.from.distance < 50, 'turnaround not at the wangan_1 terminus');
}

// --- 7. nothing else enabled --------------------------------------------------------
const serviceRoutes = [...map.routes.values()].filter((route) => route.kind === 'service');
check(serviceRoutes.length === 1 && serviceRoutes[0].id === 'tatsumi_pa_exit',
  `service routes: ${serviceRoutes.map((route) => route.id).join(', ') || '(none)'}`);
check(map.serviceAreas.length === 4, `${map.serviceAreas.length} service areas registered`);
for (const other of map.serviceAreas) {
  const info = map.getRoadInfo(other.center.clone().add({ x: 0, y: 0.4, z: 0 }));
  check(!!info?.inServiceArea && !!info?.drivable, `${other.id} lot centre not drivable`);
  check(!!other.refuelPosition, `${other.id} refuel anchor missing`);
}
const twinGarage = twin.serviceAreas.find((candidate) => candidate.hasGarage);
check(twinGarage?.id === 'shibaura_pa', `paAccessLanes twin garage is ${twinGarage?.id}`);
check(!!twinGarage?.accessRouteId && twin.routes.has(twinGarage.accessRouteId),
  'paAccessLanes twin lost the Shibaura garage connector');

console.log(`\nspawn u=${spawnLocal.u.toFixed(1)} v=${spawnLocal.v.toFixed(1)} | exit ${exitRoute?.length.toFixed(0)} m, worst step ${worstStep.toFixed(3)} m | opening ${opening?.from.toFixed(1)}..${opening?.to.toFixed(1)} (lane crosses ${crossU?.toFixed(1)})`);
if (failures) { console.log(`TATSUMI PA FLOW PROBE: FAIL (${failures})`); process.exit(1); }
console.log('TATSUMI PA FLOW PROBE: PASS');
