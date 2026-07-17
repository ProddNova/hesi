/**
 * TATSUMI PA PLACEMENT PROBE — proves the elevated-deck prototype placement
 * (js/map.js _defineTatsumiDeck) without touching the rest of the network:
 *
 *  1. EXISTS + OVERRIDDEN — tatsumi_pa is registered through the deck
 *     override, access stays disabled, and no lot fields are left undefined.
 *  2. ELEVATED — the deck sits well above the Wangan pair (beyond the ±6 m
 *     _lotAt gate) and approximately at the level of the two ramps.
 *  3. BETWEEN THE RAMPS — the deck centre lies inside the ramp_8..ramp_9
 *     corridor, and the rectangle never enters either ramp corridor.
 *  4. OVER THE WANGAN — both wangan_0 and wangan_1 centrelines run under the
 *     deck's plan-view footprint for most of its length, vertically separated.
 *  5. DRIVABLE DECK — a grid over the lot resolves to a flat, continuous,
 *     full-grip service-area surface at deck elevation.
 *  6. NO INTERFERENCE BELOW — every Wangan station under the deck still
 *     resolves to its own carriageway (drivable, not in a service area), and
 *     ramp stations (including lane-edge excursions) are never captured by
 *     the lot. Support pillars stand clear of both carriageways below.
 *  7. ONLY THE ENTRY/EXIT PAIR ENABLED — the deck's two ramp_8 connectors
 *     are the only service routes/edges in the disabled-lane network;
 *     traffic never routes onto them, and the paAccessLanes:true twin still
 *     restores the legacy behaviour (4 lanes, legacy Tatsumi placement).
 *  8. LIVE GARAGE + SPAWN — tatsumi_pa owns the only garage flag and the
 *     initialSpawn sits on the deck (see tatsumi-pa-flow-probe for the
 *     detailed drivability/obstruction assertions).
 *  9. ANCHORS — garage / spawn / wangan_0-exit anchors are exposed and sit
 *     on the deck surface; the spawn anchor is consumed by initialSpawn,
 *     the wangan_0 exit remains a future checkpoint.
 *
 * Run: node .devtests/tatsumi-pa-placement-probe.mjs
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

// --- 1. exists + overridden --------------------------------------------------
const area = map.serviceAreas.find((candidate) => candidate.id === 'tatsumi_pa');
check(!!area, 'tatsumi_pa service area missing');
if (!area) { console.log('TATSUMI PA PROBE: FAIL (1)'); process.exit(1); }
check(area.placement === 'tatsumi-elevated-deck', `placement override not applied (${area.placement})`);
check(area.accessDisabled === true, 'tatsumi_pa not flagged accessDisabled');
check(area.accessRouteId === null, `tatsumi_pa has an access route (${area.accessRouteId})`);
check(area.hasGarage === true, 'tatsumi_pa must own the active garage');
check(map.serviceAreas.length === 4, `service area count changed (${map.serviceAreas.length})`);
for (const key of ['center', 'tangent', 'normal', 'width', 'length', 'elevation']) {
  check(area[key] !== undefined && area[key] !== null, `lot field ${key} missing`);
}

const ramp8 = map.routes.get(area.rampRefs?.north);
const ramp9 = map.routes.get(area.rampRefs?.south);
const wangan0 = map.routes.get('wangan_0');
const wangan1 = map.routes.get('wangan_1');
check(ramp8?.id === 'ramp_8' && ramp9?.id === 'ramp_9',
  `ramp refs wrong (${area.rampRefs?.north}, ${area.rampRefs?.south})`);
check(!!wangan0 && !!wangan1, 'wangan carriageways missing');

const local = (p) => {
  const dx = p.x - area.center.x;
  const dz = p.z - area.center.z;
  return {
    u: dx * area.tangent.x + dz * area.tangent.z,
    v: dx * area.normal.x + dz * area.normal.z,
  };
};

// --- 2. elevated ---------------------------------------------------------------
let wanganMaxY = -Infinity;
const coverage = { wangan_0: 0, wangan_1: 0 };
const separations = [];
for (const route of [wangan0, wangan1]) {
  let covered = 0;
  for (let d = 0; d < route.length; d += 4) {
    const p = map._sampleCenter(route, d, 1).position;
    const l = local(p);
    if (Math.abs(l.u) > area.length / 2 || Math.abs(l.v) > area.width / 2) continue;
    covered += 4;
    wanganMaxY = Math.max(wanganMaxY, p.y);
    separations.push(area.elevation - p.y);
  }
  coverage[route.id] = covered;
}
check(wanganMaxY > -Infinity, 'no Wangan stations under the deck at all');
const minSeparation = Math.min(...separations);
check(minSeparation >= 7, `deck only ${minSeparation.toFixed(2)} m above the Wangan (needs >= 7 for the ±6 m lot gate)`);
let rampMinY = Infinity;
let rampMaxY = -Infinity;
for (const route of [ramp8, ramp9]) {
  for (let d = 0; d < route.length; d += 4) {
    const p = map._sampleCenter(route, d, 1).position;
    const l = local(p);
    if (Math.abs(l.u) > area.length / 2) continue;
    rampMinY = Math.min(rampMinY, p.y);
    rampMaxY = Math.max(rampMaxY, p.y);
  }
}
check(area.elevation >= rampMinY - 3.5 && area.elevation <= rampMaxY + 3.5,
  `deck elevation ${area.elevation.toFixed(1)} not at ramp level (${rampMinY.toFixed(1)}..${rampMaxY.toFixed(1)})`);

// --- 3. between the ramps --------------------------------------------------------
const p8 = map._projectToRoute(ramp8, area.center);
const p9 = map._projectToRoute(ramp9, area.center);
const rampGap = Math.hypot(p8.point.x - p9.point.x, p8.point.z - p9.point.z);
check(Math.abs(Math.abs(p8.signedLateral) + Math.abs(p9.signedLateral) - rampGap) < 3,
  'deck centre is not between ramp_8 and ramp_9');
check(Math.abs(p8.signedLateral) < 40 && Math.abs(p9.signedLateral) < 40,
  `deck centre too far from the ramps (${Math.abs(p8.signedLateral).toFixed(1)}, ${Math.abs(p9.signedLateral).toFixed(1)})`);
// the rectangle stays out of both ramp corridors
let rampEdgeClear = Infinity;
for (const route of [ramp8, ramp9]) {
  for (let d = 0; d < route.length; d += 3) {
    const p = map._sampleCenter(route, d, 1).position;
    const l = local(p);
    if (Math.abs(l.u) > area.length / 2 + 4) continue;
    rampEdgeClear = Math.min(rampEdgeClear, Math.abs(l.v) - route.halfWidth - area.width / 2);
  }
}
check(rampEdgeClear > 0.8, `deck edge ${rampEdgeClear.toFixed(2)} m from a ramp surface (needs > 0.8)`);

// --- 4. over the Wangan -----------------------------------------------------------
check(coverage.wangan_0 >= area.length * 0.8,
  `wangan_0 runs only ${coverage.wangan_0} m under the ${area.length.toFixed(0)} m deck`);
check(coverage.wangan_1 >= area.length * 0.8,
  `wangan_1 runs only ${coverage.wangan_1} m under the ${area.length.toFixed(0)} m deck`);

// --- 5. drivable deck ---------------------------------------------------------------
let deckSamples = 0;
let deckBad = 0;
let deckYSpread = 0;
for (let u = -area.length / 2 + 1.5; u <= area.length / 2 - 1.5; u += 8) {
  for (let v = -area.width / 2 + 1.5; v <= area.width / 2 - 1.5; v += 4) {
    const p = area.center.clone()
      .addScaledVector(area.tangent, u)
      .addScaledVector(area.normal, v);
    p.y = area.elevation + 0.5;
    const info = map.getRoadInfo(p);
    deckSamples += 1;
    if (!info || !info.inServiceArea || info.serviceAreaId !== 'tatsumi_pa'
      || !info.drivable || !info.onRoadSurface
      || Math.abs(info.y - area.elevation) > 0.01
      || info.grade !== 0 || info.surfaceGrip < 0.9) deckBad += 1;
    if (info) deckYSpread = Math.max(deckYSpread, Math.abs(info.y - area.elevation));
  }
}
check(deckSamples > area.length * 0.7, `too few deck samples (${deckSamples})`);
check(deckBad === 0, `${deckBad}/${deckSamples} deck samples not flat drivable lot surface`);
check(map.isInServiceArea(area.center.clone())?.id === 'tatsumi_pa', 'isInServiceArea misses the deck centre');

// --- 6. no interference below --------------------------------------------------------
let wanganBad = 0;
let wanganUnder = 0;
for (const route of [wangan0, wangan1]) {
  for (let d = 0; d < route.length; d += 6) {
    const sample = map._sampleCenter(route, d, 1);
    const l = local(sample.position);
    if (Math.abs(l.u) > area.length / 2 || Math.abs(l.v) > area.width / 2) continue;
    wanganUnder += 1;
    const p = sample.position.clone();
    p.y += 0.5;
    const info = map.getRoadInfo(p, route.id);
    if (!info || info.routeId !== route.id || !info.onRoad || info.inServiceArea) wanganBad += 1;
  }
}
check(wanganUnder > area.length * 0.25, `too few Wangan under-deck samples (${wanganUnder})`);
check(wanganBad === 0, `${wanganBad} Wangan stations under the deck lost their carriageway`);
let rampCaptured = 0;
for (const route of [ramp8, ramp9]) {
  for (let d = 0; d < route.length; d += 4) {
    const sample = map._sampleCenter(route, d, 1);
    for (const lat of [-route.halfWidth + 0.9, 0, route.halfWidth - 0.9]) {
      const p = sample.position.clone().addScaledVector(sample.normal, lat);
      p.y += 0.5;
      if (map.getRoadInfo(p, route.id)?.inServiceArea) rampCaptured += 1;
    }
  }
}
check(rampCaptured === 0, `${rampCaptured} ramp stations captured by the lot`);
// support pillars stand clear of the carriageways underneath
check(Array.isArray(area.pillarLateralOffsets) && area.pillarLateralOffsets.length > 0,
  'deck pillar offsets missing');
for (const along of [-area.length * 0.36, 0, area.length * 0.36]) {
  for (const across of area.pillarLateralOffsets || []) {
    const pillar = area.center.clone()
      .addScaledVector(area.tangent, along)
      .addScaledVector(area.normal, across);
    for (const route of [wangan0, wangan1]) {
      const projection = map._projectToRoute(route, pillar);
      check(Math.abs(projection.signedLateral) > route.halfWidth + 1.0,
        `pillar at u=${along.toFixed(0)} stands in ${route.id} (lat ${projection.signedLateral.toFixed(2)})`);
    }
  }
}

// --- 7. only the Tatsumi entry/exit enabled -----------------------------------------------
// The refined checkpoint registers exactly two service connectors (the
// ramp_8 -> deck entry and the deck -> ramp_8 exit) with one edge each;
// every other PA access lane stays disabled and traffic never routes onto
// either connector.
const serviceRoutes = [...map.routes.values()].filter((route) => route.kind === 'service');
check(serviceRoutes.length === 2
  && serviceRoutes.every((route) => ['tatsumi_pa_entry', 'tatsumi_pa_exit'].includes(route.id)),
`unexpected service routes: ${serviceRoutes.map((r) => r.id).join(', ') || '(none)'}`);
const tatsumiEdges = map.edges.filter((edge) => `${edge.from.routeId}${edge.to.routeId}`.includes('tatsumi'));
check(tatsumiEdges.length === 2
  && tatsumiEdges.some((edge) => edge.kind === 'merge' && edge.to.routeId === 'ramp_8')
  && tatsumiEdges.some((edge) => edge.kind === 'diverge' && edge.from.routeId === 'ramp_8'),
`tatsumi edges: ${tatsumiEdges.map((e) => `${e.kind}:${e.from.routeId}->${e.to.routeId}`).join(', ') || '(none)'}`);
const tatsumiLanes = map.getTrafficLanes().filter((lane) => `${lane.routeId ?? lane.id}`.includes('tatsumi'));
check(tatsumiLanes.length === 0, `${tatsumiLanes.length} traffic lanes reference tatsumi`);
check(map.edges.length === twin.edges.length - 8 + 2,
  `edge count drift: disabled ${map.edges.length} vs twin ${twin.edges.length} (twin adds 2 per access lane, disabled adds the Tatsumi entry+exit)`);

// --- 8. garage + initialSpawn live on the deck --------------------------------------------
const garageArea = map.serviceAreas.find((candidate) => candidate.hasGarage);
check(garageArea?.id === 'tatsumi_pa', `active garage is ${garageArea?.id}`);
check(map.serviceAreas.filter((candidate) => candidate.hasGarage).length === 1, 'more than one active garage');
check(map.initialSpawn.serviceAreaId === 'tatsumi_pa', `initialSpawn anchored to ${map.initialSpawn.serviceAreaId}`);
check(map.initialSpawn.label === 'Tatsumi PA deck', `initialSpawn label changed (${map.initialSpawn.label})`);
const spawnToDeck = Math.hypot(map.initialSpawn.position.x - area.center.x, map.initialSpawn.position.z - area.center.z);
check(spawnToDeck < area.length * 0.5, `initialSpawn off the deck (${spawnToDeck.toFixed(0)} m from centre)`);
check(garageArea && map.garagePosition.equals(garageArea.garageEntrance), 'garagePosition detached from the deck entrance');
check(!!map.getGarageTransition(map.garagePosition.clone(), 13)?.triggered, 'deck garage transition does not fire');

// --- 9. future anchors -----------------------------------------------------------------------
const anchors = area.futureAnchors;
check(!!anchors?.garage && !!anchors?.spawn && !!anchors?.wanganExit, 'future anchors missing');
if (anchors?.garage && anchors?.spawn && anchors?.wanganExit) {
  for (const [name, anchor] of [['garage', anchors.garage], ['spawn', anchors.spawn]]) {
    const l = local(anchor.position);
    check(Math.abs(l.u) < area.length / 2 && Math.abs(l.v) < area.width / 2,
      `${name} anchor off the deck (u ${l.u.toFixed(1)}, v ${l.v.toFixed(1)})`);
    check(Math.abs(anchor.position.y - area.elevation) < 0.01, `${name} anchor not on the deck surface`);
    check(Number.isFinite(anchor.heading), `${name} anchor heading missing`);
    const info = map.getRoadInfo(anchor.position.clone());
    check(info?.inServiceArea && info?.drivable, `${name} anchor not on drivable lot surface`);
  }
  const exit = anchors.wanganExit;
  const el = local(exit.deckEdge);
  check(Math.abs(el.u) <= area.length / 2 && Math.abs(el.v) <= area.width / 2,
    `exit anchor off the deck (u ${el.u.toFixed(1)}, v ${el.v.toFixed(1)})`);
  check(el.v > area.width * 0.25, 'exit anchor not on the wangan_0-side deck edge');
  check(el.u > area.length * 0.25, 'exit anchor not at the downstream deck end');
  check(exit.targetRouteId === 'wangan_0', `exit targets ${exit.targetRouteId}`);
  const target = map._sampleCenter(wangan0, exit.targetDistance, 1);
  check(target.position.distanceTo(exit.targetPoint) < 2, 'exit target point does not match its station');
  check(exit.targetDistance > map._projectToRoute(wangan0, exit.deckEdge).distance + 100,
    'exit target is not downstream of the deck');
  check(exit.grade > 0.01 && exit.grade <= 0.05,
    `exit grade ${(exit.grade * 100).toFixed(2)}% outside (1%..5%]`);
}

// --- twin keeps legacy behaviour ---------------------------------------------------------------
const twinArea = twin.serviceAreas.find((candidate) => candidate.id === 'tatsumi_pa');
check(twinArea?.placement !== 'tatsumi-elevated-deck', 'paAccessLanes:true twin unexpectedly uses the deck override');
check(!!twinArea?.accessRouteId && twin.routes.has(twinArea.accessRouteId),
  'paAccessLanes:true twin lost the legacy Tatsumi access lane');

console.log(`\ndeck ${area.width.toFixed(1)}x${area.length.toFixed(1)} @ y=${area.elevation.toFixed(2)}`
  + ` | centre ${area.center.x.toFixed(1)}, ${area.center.z.toFixed(1)}`
  + ` | ${minSeparation.toFixed(2)} m above Wangan | ramp clearance ${rampEdgeClear.toFixed(2)} m`
  + ` | deck samples ${deckSamples} | under-deck Wangan stations ${wanganUnder}`);
if (failures) { console.log(`TATSUMI PA PROBE: FAIL (${failures})`); process.exit(1); }
console.log('TATSUMI PA PROBE: PASS');
