/**
 * PA ACCESS-DISABLE PROBE — proves that while PA_ACCESS_LANES_DISABLED is
 * active (the temporary junction-finishing state), no parking/service-area
 * connector exists at runtime in ANY subsystem, and that the garage flow
 * survives without its lane:
 *
 *  1. NO REGISTERED GEOMETRY — no route of kind 'service' is registered
 *     (asphalt, markings and guardrails are only ever generated for
 *     registered routes), and every service area is flagged accessDisabled
 *     with a null accessRouteId.
 *  2. NO COLLISION CORRIDOR — walking each connector's restored centreline
 *     (from a paAccessLanes:true twin map), the disabled map never
 *     attributes road surface to an access route; connector-only stations
 *     (away from hosts and lots) have no drivable corridor at all.
 *  3. NO TRAFFIC — no traffic lane references an access route; no runtime
 *     graph edge touches an unregistered route id.
 *  4. NO MINIMAP GEOMETRY — the minimap carries no service-kind polyline.
 *  5. NO JUNCTION ARTEFACTS — no junction mouth/zone has a service-kind
 *     branch (rail openings and marking zones can't reference the lanes).
 *  6. GARAGE PRESERVED — initial spawn sits on a registered mainline lane;
 *     the garage entrance trigger sits ON the host carriageway's deck and
 *     getGarageTransition fires there; the minimap garage marker agrees.
 *  7. REVERSIBLE — the paAccessLanes:true twin restores all four access
 *     lanes (including the Shibaura garage connector) with valid edges.
 *
 * Run: node .devtests/pa-access-probe.mjs
 */
const origWarn = console.warn;
console.warn = () => {};
const { HighwayMap } = await import('../js/map.js');
const map = new HighwayMap(null, { addLighting: false });
const restored = new HighwayMap(null, { addLighting: false, paAccessLanes: true });
console.warn = origWarn;

let failures = 0;
const check = (ok, label) => {
  if (!ok) { failures += 1; console.log(`FAIL  ${label}`); }
};
const isAccessId = (id) => typeof id === 'string' && id.endsWith('_access');

// --- 1. no registered geometry ---------------------------------------------
const serviceRoutes = [...map.routes.values()].filter((r) => r.kind === 'service');
check(serviceRoutes.length === 0,
  `service routes still registered: ${serviceRoutes.map((r) => r.id).join(', ')}`);
check(map.serviceAreas.length > 0, 'no service areas at all (lots should stay)');
for (const area of map.serviceAreas) {
  check(area.accessDisabled === true, `${area.id} not flagged accessDisabled`);
  check(area.accessRouteId === null, `${area.id} still has accessRouteId ${area.accessRouteId}`);
}
check(![...map.routes.keys()].some(isAccessId), 'an *_access route id is registered');

// --- 2. no collision corridor along the old connector paths -----------------
let corridorSamples = 0;
let corridorAttributedToAccess = 0;
let orphanDrivable = 0;
for (const twin of restored.routes.values()) {
  if (twin.kind !== 'service') continue;
  for (let s = 4; s < twin.length - 4; s += 12) {
    const sample = restored._sampleCenter(twin, s, 1);
    const point = sample.position.clone();
    point.y += 0.4;
    corridorSamples += 1;
    const info = map.getRoadInfo(point);
    if (info && isAccessId(info.routeId)) corridorAttributedToAccess += 1;
    // connector-only stations: not near any registered corridor of the
    // disabled map and not inside a lot -> must not be drivable
    if (info && info.onRoadSurface && !info.inServiceArea) {
      const near = map.getNearestRoute(point, { maxDistance: 30, includeService: true });
      if (!near) orphanDrivable += 1;
    }
  }
}
check(corridorSamples > 50, `too few connector samples (${corridorSamples}) — twin map broken?`);
check(corridorAttributedToAccess === 0,
  `${corridorAttributedToAccess} stations still resolve to an access-route corridor`);
check(orphanDrivable === 0, `${orphanDrivable} connector stations drivable with no owning route`);

// --- 3. no traffic, no graph edges ------------------------------------------
const accessLanes = map.getTrafficLanes().filter((lane) => isAccessId(lane.routeId ?? lane.id));
check(accessLanes.length === 0, `${accessLanes.length} traffic lanes reference access routes`);
const badEdges = map.edges.filter((edge) => !map.routes.has(edge.from.routeId) || !map.routes.has(edge.to.routeId));
check(badEdges.length === 0, `${badEdges.length} runtime edges reference unregistered routes`);
const accessEdges = map.edges.filter((edge) => isAccessId(edge.from.routeId) || isAccessId(edge.to.routeId));
check(accessEdges.length === 0, `${accessEdges.length} runtime edges reference access routes`);

// --- 4. minimap --------------------------------------------------------------
const minimap = map.getMinimapData();
const minimapService = minimap.routes.filter((route) => route.kind === 'service' || isAccessId(route.id));
check(minimapService.length === 0, `${minimapService.length} minimap polylines are service connectors`);

// --- 5. junction artefacts ----------------------------------------------------
const serviceZones = (map.junctionZones || []).filter((zone) => zone.branch.kind === 'service' || zone.host.kind === 'service');
check(serviceZones.length === 0, `${serviceZones.length} junction zones involve service lanes`);
let serviceWalls = 0;
for (const segment of map.wallSegments) {
  if (isAccessId(segment.routeId)) serviceWalls += 1;
}
check(serviceWalls === 0, `${serviceWalls} wall segments belong to access routes`);

// --- 6. garage flow preserved -------------------------------------------------
const garageArea = map.serviceAreas.find((area) => area.hasGarage);
check(!!garageArea, 'garage service area missing');
if (garageArea) {
  const host = map.routes.get(garageArea.routeId);
  check(!!host && host.kind !== 'service', 'garage host route missing or a service lane');
  const projection = map._projectToRoute(host, garageArea.garageEntrance);
  const halfWidth = map._halfWidthAt(host, projection.distance);
  check(Math.abs(projection.signedLateral) < halfWidth - 0.5,
    `garage entrance trigger off the host deck (|lat| ${Math.abs(projection.signedLateral).toFixed(2)} vs half ${halfWidth.toFixed(2)})`);
  check(Math.abs(garageArea.garageEntrance.y - projection.point.y) < 2,
    'garage entrance trigger floats off the host deck');
  const transition = map.getGarageTransition(garageArea.garageEntrance.clone(), 13);
  check(!!transition?.triggered, 'getGarageTransition does not fire at the relocated entrance');
  check(!!garageArea.garageLotAnchor, 'garage lot anchor (building position) missing');
  check(garageArea.garageLotAnchor.distanceTo(garageArea.garageEntrance) > 5,
    'garage building anchor and mainline trigger unexpectedly coincide');
  check(minimap.garage
    && Math.hypot(minimap.garage.x - garageArea.garageEntrance.x, minimap.garage.z - garageArea.garageEntrance.z) < 1,
  'minimap garage marker does not sit on the entrance trigger');
  const spawn = map.initialSpawn;
  const spawnRoute = map.routes.get(spawn.routeId);
  check(!!spawnRoute && spawnRoute.kind !== 'service' && spawnRoute.kind !== 'ramp',
    `initial spawn not on a mainline (route ${spawn.routeId})`);
}

// --- 7. reversibility ----------------------------------------------------------
const restoredService = [...restored.routes.values()].filter((r) => r.kind === 'service');
check(restoredService.length === 4,
  `paAccessLanes:true restores ${restoredService.length}/4 access lanes`);
const restoredGarage = restored.serviceAreas.find((area) => area.hasGarage);
check(!!restoredGarage?.accessRouteId && restored.routes.has(restoredGarage.accessRouteId),
  'paAccessLanes:true does not restore the garage connector');
const restoredBadEdges = restored.edges.filter((edge) => !restored.routes.has(edge.from.routeId) || !restored.routes.has(edge.to.routeId));
check(restoredBadEdges.length === 0, `${restoredBadEdges.length} restored edges reference unregistered routes`);

console.log(`\nconnector stations sampled=${corridorSamples}; service areas=${map.serviceAreas.length}; restored lanes=${restoredService.length}`);
if (failures) { console.log(`PA ACCESS PROBE: FAIL (${failures})`); process.exit(1); }
console.log('PA ACCESS PROBE: PASS');
