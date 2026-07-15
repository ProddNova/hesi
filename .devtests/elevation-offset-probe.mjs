/**
 * Focused global road-network elevation audit.
 *
 * Reports the measured offset, ordinary non-tunnel deck clearance,
 * accidental terrain intersections before/after, and preservation of
 * route-to-route vertical differences.
 *
 * Run: node .devtests/elevation-offset-probe.mjs
 */
import ROUTE_DATA from '../data/routes-smoothed.js';
import { HighwayMap, ROAD_NETWORK_Y_OFFSET } from '../js/map.js';

const SAMPLE_STEP = 2;
const TERRAIN_TOP_Y = -0.12; // 1 m slab centred at -0.62 in _buildEnvironment.
const LOW_DECK_DEPTH = 0.5;
const ELEVATED_DECK_DEPTH = 1.35;
const ELEVATED_THRESHOLD_Y = 2.5;
const SAFE_VISIBLE_UNDERSIDE_GAP = 0.4;
const PARALLEL_TUNNEL_XZ_DISTANCE = 70;
const PARALLEL_TUNNEL_Y_DISTANCE = 8;

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const near = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;

const map = new HighwayMap(null, { addLighting: false });

// Explicit tunnel samples seed a small XZ index. An untagged opposing deck
// beside the same bore (or a connected underground ramp) is tunnel context,
// not an accidental floor intersection. Contiguous below-floor portal
// approaches inherit that context until their deck actually emerges.
const tunnelCell = PARALLEL_TUNNEL_XZ_DISTANCE;
const tunnelGrid = new Map();
const tunnelKey = (x, z) => `${Math.floor(x / tunnelCell)},${Math.floor(z / tunnelCell)}`;
for (const route of map.routes.values()) {
  for (const tunnel of route.tunnels) {
    for (let distance = tunnel.startDistance; distance <= tunnel.endDistance; distance += 10) {
      const point = map._sampleCenter(route, distance, 1).position;
      const key = tunnelKey(point.x, point.z);
      if (!tunnelGrid.has(key)) tunnelGrid.set(key, []);
      tunnelGrid.get(key).push(point);
    }
  }
}

const besideExplicitTunnel = (point) => {
  const cellX = Math.floor(point.x / tunnelCell);
  const cellZ = Math.floor(point.z / tunnelCell);
  for (let x = cellX - 1; x <= cellX + 1; x += 1) {
    for (let z = cellZ - 1; z <= cellZ + 1; z += 1) {
      for (const tunnelPoint of tunnelGrid.get(`${x},${z}`) || []) {
        if (Math.hypot(point.x - tunnelPoint.x, point.z - tunnelPoint.z) <= PARALLEL_TUNNEL_XZ_DISTANCE
          && Math.abs(point.y - tunnelPoint.y) <= PARALLEL_TUNNEL_Y_DISTANCE) return true;
      }
    }
  }
  return false;
};

const terrainAt = (x, z) => map._terrainSlabs.find((slab) => (
  Math.abs(x - slab.x) <= slab.w * 0.5 && Math.abs(z - slab.z) <= slab.d * 0.5
));

const routeTables = new Map();
for (const route of map.routes.values()) {
  if (route.kind === 'service') continue;
  const rows = [];
  for (let distance = 0; distance <= route.length; distance += SAMPLE_STEP) {
    const frame = map._frameAt(route, distance);
    let slab = null;
    let currentMinSurfaceY = Infinity;
    for (const lateral of [-frame.half, 0, frame.half]) {
      const x = frame.position.x + frame.normal.x * lateral;
      const z = frame.position.z + frame.normal.z * lateral;
      const candidateSlab = terrainAt(x, z);
      if (!candidateSlab) continue;
      slab ||= candidateSlab;
      currentMinSurfaceY = Math.min(
        currentMinSurfaceY,
        frame.position.y + Math.tan(frame.bank) * lateral,
      );
    }
    const explicitTunnel = !!map._isTunnel(route, distance);
    rows.push({
      distance,
      slab,
      explicitTunnel,
      tunnelSeed: explicitTunnel || besideExplicitTunnel(frame.position),
      tunnelContext: false,
      baselineCenterY: frame.position.y - ROAD_NETWORK_Y_OFFSET,
      baselineMinSurfaceY: currentMinSurfaceY - ROAD_NETWORK_Y_OFFSET,
    });
  }

  const undergroundSpans = [];
  let span = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const underground = row.explicitTunnel
      || (row.slab && row.baselineMinSurfaceY <= TERRAIN_TOP_Y);
    if (underground && !span) span = { start: index, end: index, seeded: row.tunnelSeed };
    else if (underground) {
      span.end = index;
      span.seeded ||= row.tunnelSeed;
    } else if (span) {
      undergroundSpans.push(span);
      span = null;
    }
  }
  if (span) undergroundSpans.push(span);
  for (const undergroundSpan of undergroundSpans) {
    if (!undergroundSpan.seeded) continue;
    for (let index = undergroundSpan.start; index <= undergroundSpan.end; index += 1) {
      rows[index].tunnelContext = true;
    }
  }
  routeTables.set(route.id, { route, rows, undergroundSpans });
}

// Carry tunnel intent through graph-connected underground spans (notably the
// short Ginza tunnel ramps) without classifying above-floor C1 seam decks as
// tunnels merely because they are nearby in the route graph.
const rowAt = (routeId, distance) => {
  const table = routeTables.get(routeId);
  if (!table) return null;
  const index = Math.max(0, Math.min(table.rows.length - 1, Math.round(distance / SAMPLE_STEP)));
  return { table, index, row: table.rows[index] };
};
let tunnelContextChanged = true;
while (tunnelContextChanged) {
  tunnelContextChanged = false;
  for (const edge of map.edges) {
    const directions = [
      [edge.from.routeId, edge.from.distance, edge.to.routeId, edge.to.distance],
      [edge.to.routeId, edge.to.distance, edge.from.routeId, edge.from.distance],
    ];
    for (const [sourceId, sourceDistance, targetId, targetDistance] of directions) {
      const source = rowAt(sourceId, sourceDistance);
      const target = rowAt(targetId, targetDistance);
      if (!source?.row.tunnelContext || !target || target.row.tunnelContext) continue;
      const targetSpan = target.table.undergroundSpans.find((candidate) => (
        target.index >= candidate.start && target.index <= candidate.end
      ));
      if (!targetSpan) continue;
      for (let index = targetSpan.start; index <= targetSpan.end; index += 1) {
        if (target.table.rows[index].tunnelContext) continue;
        target.table.rows[index].tunnelContext = true;
        tunnelContextChanged = true;
      }
    }
  }
}

const deckGapAt = (row, offset) => {
  const centerY = row.baselineCenterY + offset;
  const depth = centerY > ELEVATED_THRESHOLD_Y ? ELEVATED_DECK_DEPTH : LOW_DECK_DEPTH;
  return row.baselineMinSurfaceY + offset - depth - TERRAIN_TOP_Y;
};

const ordinaryRows = [...routeTables.values()].flatMap(({ route, rows }) => rows
  .filter((row) => row.slab && !row.tunnelContext)
  .map((row) => ({ ...row, routeId: route.id })));

const measure = (offset) => {
  let minimum = null;
  for (const row of ordinaryRows) {
    const deckGap = deckGapAt(row, offset);
    const surfaceClearance = row.baselineMinSurfaceY + offset - TERRAIN_TOP_Y;
    if (!minimum || deckGap < minimum.deckGap) minimum = { ...row, deckGap, surfaceClearance };
  }
  return minimum;
};

const intersectionZones = (offset) => {
  const zones = [];
  for (const [routeId, { rows }] of routeTables) {
    let zone = null;
    for (const row of rows) {
      const intersects = row.slab && !row.tunnelContext && deckGapAt(row, offset) <= 0;
      if (intersects && !zone) {
        zone = { routeId, start: row.distance, end: row.distance, minGap: deckGapAt(row, offset) };
      } else if (intersects) {
        zone.end = row.distance;
        zone.minGap = Math.min(zone.minGap, deckGapAt(row, offset));
      } else if (zone) {
        zones.push(zone);
        zone = null;
      }
    }
    if (zone) zones.push(zone);
  }
  return zones;
};

let measuredMinimumOffset = null;
for (let decimetres = 0; decimetres <= 60; decimetres += 1) {
  const candidate = decimetres / 10;
  if (measure(candidate).deckGap >= SAFE_VISIBLE_UNDERSIDE_GAP) {
    measuredMinimumOffset = candidate;
    break;
  }
}

const beforeMinimum = measure(0);
const afterMinimum = measure(ROAD_NETWORK_Y_OFFSET);
const beforeIntersections = intersectionZones(0);
const afterIntersections = intersectionZones(ROAD_NETWORK_Y_OFFSET);

// Directly match unchanged X/Z controls that survived endpoint fairing. Their
// runtime Y delta must be the one global constant, proving the offset is at
// the data boundary rather than on a render group.
let matchedControls = 0;
let maxControlOffsetError = 0;
for (const sourceRoute of ROUTE_DATA.routes) {
  const runtimeRoute = map.routes.get(sourceRoute.id);
  if (!runtimeRoute) continue;
  const runtimeByXZ = new Map(runtimeRoute.points.map((point) => [
    `${point.x.toFixed(6)},${point.z.toFixed(6)}`, point,
  ]));
  for (const [x, y, z] of sourceRoute.points) {
    const runtimePoint = runtimeByXZ.get(`${x.toFixed(6)},${z.toFixed(6)}`);
    if (!runtimePoint) continue;
    matchedControls += 1;
    maxControlOffsetError = Math.max(
      maxControlOffsetError,
      Math.abs((runtimePoint.y - y) - ROAD_NETWORK_Y_OFFSET),
    );
  }
}

// Compare nearby controls from different routes (parallel and stacked decks).
// Adding one scalar must preserve every such vertical delta exactly.
const controls = ROUTE_DATA.routes.flatMap((route) => route.points.map(([x, y, z]) => ({
  routeId: route.id, x, y, z,
})));
const relativeCell = 20;
const controlGrid = new Map();
const controlKey = (x, z) => `${Math.floor(x / relativeCell)},${Math.floor(z / relativeCell)}`;
let relativePairs = 0;
let maxRelativeDeltaError = 0;
for (const control of controls) {
  const cellX = Math.floor(control.x / relativeCell);
  const cellZ = Math.floor(control.z / relativeCell);
  for (let x = cellX - 1; x <= cellX + 1; x += 1) {
    for (let z = cellZ - 1; z <= cellZ + 1; z += 1) {
      for (const other of controlGrid.get(`${x},${z}`) || []) {
        if (other.routeId === control.routeId || Math.hypot(other.x - control.x, other.z - control.z) > 20) continue;
        const beforeDelta = control.y - other.y;
        const afterDelta = (control.y + ROAD_NETWORK_Y_OFFSET) - (other.y + ROAD_NETWORK_Y_OFFSET);
        relativePairs += 1;
        maxRelativeDeltaError = Math.max(maxRelativeDeltaError, Math.abs(afterDelta - beforeDelta));
      }
    }
  }
  const key = controlKey(control.x, control.z);
  if (!controlGrid.has(key)) controlGrid.set(key, []);
  controlGrid.get(key).push(control);
}

const tunnelContextSpans = [];
for (const [routeId, { rows }] of routeTables) {
  let span = null;
  for (const row of rows) {
    if (row.tunnelContext && !span) span = { routeId, start: row.distance, end: row.distance };
    else if (row.tunnelContext) span.end = row.distance;
    else if (span) {
      tunnelContextSpans.push(span);
      span = null;
    }
  }
  if (span) tunnelContextSpans.push(span);
}
const tunnelConnectedRamps = ['ramp_5', 'ramp_29'].filter((routeId) => (
  routeTables.get(routeId)?.rows.some((row) => row.tunnelContext)
));

const sourceAreaById = new Map((ROUTE_DATA.serviceAreas || []).map((area) => [area.id, area]));
let nonGroundedAreasAligned = 0;
let groundedAreasPreserved = 0;
for (const area of map.serviceAreas) {
  const sourceArea = sourceAreaById.get(area.id);
  if (sourceArea?.grounded) {
    if (near(area.elevation, 1.35, 1e-6)) groundedAreasPreserved += 1;
    continue;
  }
  const host = map.routes.get(area.routeId);
  const hostY = map._sampleCenter(host, area.mainDistance, 1).position.y;
  if (near(area.elevation, hostY + 0.15, 1e-6)) nonGroundedAreasAligned += 1;
}
const garageArea = map.serviceAreas.find((area) => area.hasGarage);

console.log(`Chosen ROAD_NETWORK_Y_OFFSET: +${ROAD_NETWORK_Y_OFFSET.toFixed(1)} m`);
console.log(`Measured minimum safe offset (0.1 m scan): +${measuredMinimumOffset.toFixed(1)} m`);
console.log(`Minimum ordinary non-tunnel deck underside clearance: ${afterMinimum.deckGap.toFixed(3)} m`);
console.log(`Minimum ordinary non-tunnel surface clearance: ${afterMinimum.surfaceClearance.toFixed(3)} m`);
console.log(`Worst ordinary location: ${afterMinimum.routeId} @ ${afterMinimum.distance.toFixed(0)} m (${afterMinimum.slab.name})`);
console.log(`Accidental terrain-intersection zones before/after: ${beforeIntersections.length}/${afterIntersections.length}`);
console.log(`Representative pre-offset intersections: ${beforeIntersections
  .sort((a, b) => a.minGap - b.minGap)
  .slice(0, 3)
  .map((zone) => `${zone.routeId} ${zone.start.toFixed(0)}-${zone.end.toFixed(0)}m (${zone.minGap.toFixed(2)}m)`)
  .join('; ')}`);
console.log(`Intentional tunnel context: ${tunnelContextSpans.length} spans; connected ramps ${tunnelConnectedRamps.join(', ')}`);
console.log(`Route-to-route vertical-difference preservation: max error ${maxRelativeDeltaError.toExponential(2)} m across ${relativePairs} nearby control pairs`);
console.log(`Authoritative control-point offset: max error ${maxControlOffsetError.toExponential(2)} m across ${matchedControls} matched X/Z controls`);
console.log(`Service areas: ${nonGroundedAreasAligned} non-grounded aligned; ${groundedAreasPreserved} grounded preserved; garage connector ${garageArea?.accessRouteId ? 'present' : 'missing'}`);

check(ROAD_NETWORK_Y_OFFSET >= measuredMinimumOffset,
  `configured offset ${ROAD_NETWORK_Y_OFFSET} is below measured minimum ${measuredMinimumOffset}`);
check(beforeIntersections.length > 0, 'baseline unexpectedly has no accidental terrain intersections');
check(afterIntersections.length === 0, `${afterIntersections.length} accidental intersections remain after offset`);
check(afterMinimum.deckGap >= SAFE_VISIBLE_UNDERSIDE_GAP,
  `minimum visible deck gap ${afterMinimum.deckGap.toFixed(3)} m is below ${SAFE_VISIBLE_UNDERSIDE_GAP} m`);
check(relativePairs > 0 && maxRelativeDeltaError < 1e-12, 'route-to-route height deltas changed');
check(matchedControls > 1000 && maxControlOffsetError < 1e-9,
  `authoritative control points do not share one exact offset (${matchedControls} matches, ${maxControlOffsetError} error)`);
check(tunnelConnectedRamps.length === 2, 'tunnel-connected Ginza ramps were not classified as intentional tunnel context');
check(nonGroundedAreasAligned === map.serviceAreas.filter((area) => !sourceAreaById.get(area.id)?.grounded).length,
  'a non-grounded service area no longer follows its host route');
check(groundedAreasPreserved === map.serviceAreas.filter((area) => sourceAreaById.get(area.id)?.grounded).length,
  'a deliberately grounded service area moved off ground level');
check(garageArea?.accessRouteId && map.routes.has(garageArea.accessRouteId), 'Shibaura garage connector is missing');

if (failures.length) {
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  process.exitCode = 1;
} else {
  console.log('PASS  global road elevation offset audit');
}
