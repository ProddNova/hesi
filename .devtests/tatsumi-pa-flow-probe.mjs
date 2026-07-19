/**
 * TATSUMI PA FLOW PROBE — proves the compact empty deck is the live player
 * garage/spawn and that BOTH ramp_8 connectors (entry + exit) are
 * continuously drivable with one authoritative height profile, without
 * re-enabling anything else:
 *
 *  1. ACTIVE GARAGE — tatsumi_pa owns the only hasGarage flag; the ENTER
 *     trigger sits on the drivable deck, fires getGarageTransition, the
 *     minimap marker follows it, and the deck carries the dedicated
 *     real-world dressing style (dressing === 'tatsumi', not the generic
 *     recipe and not the bare dressingMinimal platform).
 *  2. SPAWN — initialSpawn (boot, garage exit, tow and crash recovery all
 *     route through game.js placeAtSpawn) is anchored to tatsumi_pa on the
 *     drivable deck, above collision, aligned with the deck axis toward the
 *     exit end, clear of the deck edges, and outside both the 13 m ENTER
 *     transition radius and the 18 m proximity-prompt radius.
 *  3. ACCESS CONTINUITY + ONE HEIGHT AUTHORITY — along the entry and the
 *     exit, the centreline and both wheel-track offsets resolve to drivable
 *     collision every 0.5 m with no step, the collision profile never
 *     diverges from the rendered lane profile (the old glue drew its strip
 *     above the ramp plane while collision picked the ramp — the car sank
 *     below the asphalt), and the centreline grade stays under 6 %.
 *  4. OPEN GATES — both connectors pass through the deck ENDS (the side
 *     fence/kerb stays unbroken: no fenceOpenings), no collision wall
 *     crosses either lane, and the host guardrail is open across both
 *     junction mouths.
 *  5. GRADE SEPARATION — both Wangan carriageways still run >= 7 m under
 *     the deck footprint and never resolve to the lot.
 *  6. LEFT-HAND TRAFFIC — opposing carriageway on the driver's RIGHT along
 *     the Wangan pair, all traffic lanes direction +1, the exit merges
 *     downstream into ramp_8 which merges into wangan_0 with >20 km of
 *     mainline ahead, the entry diverges from ramp_8 upstream of the deck
 *     with probability 0 (player-only), and wangan_1 terminates in the
 *     Tatsumi turnaround back onto wangan_0.
 *  7. NOTHING ELSE ENABLED — the two connectors are the only service
 *     routes, they carry no traffic lanes, all four PAs keep valid lots,
 *     and the paAccessLanes:true twin still restores the legacy Shibaura
 *     garage.
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

// --- deck matches the real strip ----------------------------------------------
// The real Tatsumi No.1 PA is a ~190 m elevated strip; the deck is trimmed
// to that length around the OSM lot centroid.
check(area.length >= 170 && area.length <= 212, `deck ${area.length.toFixed(0)} m long (real strip is ~190 m)`);
check(area.width >= 22, `deck only ${area.width.toFixed(0)} m wide`);
check(Number.isFinite(area.rampSideSign) && Math.abs(area.rampSideSign) === 1,
  `rampSideSign missing (${area.rampSideSign})`);
check(area.tatsumiPlan && area.tatsumiPlan.truckDepth >= 7.5 && area.tatsumiPlan.truckDepth <= 11.5,
  `tatsumiPlan missing or implausible (${JSON.stringify(area.tatsumiPlan || null)})`);

// --- 1. active garage on a bare platform --------------------------------------
const garageAreas = map.serviceAreas.filter((candidate) => candidate.hasGarage);
check(garageAreas.length === 1 && garageAreas[0].id === 'tatsumi_pa',
  `active garages: ${garageAreas.map((a) => a.id).join(', ') || '(none)'}`);
check(area.dressing === 'tatsumi' && area.dressingMinimal !== true,
  'deck does not carry the dedicated Tatsumi dressing style');
check(Number.isFinite(area.aisleV) && Math.abs(area.aisleV) > 1 && Math.abs(area.aisleV) < area.width * 0.25,
  `deck aisleV missing or implausible (${area.aisleV})`);
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
const spawnToRing = Math.hypot(entrance.x - spawn.position.x, entrance.z - spawn.position.z);
check(spawnToRing > 18, `spawn ${spawnToRing.toFixed(1)} m from the ENTER trigger (prompt radius is 18)`);

// --- 3. access continuity + one height authority --------------------------------
const connectors = [
  ['entry', map.routes.get(area.entryRouteId)],
  ['exit', map.routes.get(area.exitRouteId)],
];
for (const [label, route] of connectors) {
  check(!!route && route.kind === 'service' && route.traffic === false,
    `${label} route missing or open to traffic`);
  if (!route) continue;
  let worstStep = 0;
  let worstDivergence = 0;
  let undrivable = 0;
  let worstGrade = 0;
  let previousY = null;
  for (const lateral of [-1.5, 0, 1.5]) {
    let previous = null;
    for (let s = 0; s <= route.length; s += 0.5) {
      const centre = map._sampleCenter(route, Math.min(s, route.length), 1);
      const point = centre.position.clone().addScaledVector(centre.normal, lateral);
      point.y += 0.4;
      const info = map.getRoadInfo(point);
      if (!info?.drivable || !Number.isFinite(info.height)) { undrivable += 1; previous = null; continue; }
      if (previous != null) worstStep = Math.max(worstStep, Math.abs(info.height - previous));
      previous = info.height;
      if (lateral === 0) {
        worstDivergence = Math.max(worstDivergence, Math.abs(info.height - centre.position.y));
        if (s >= 4) {
          if (previousY != null) worstGrade = Math.max(worstGrade, Math.abs(centre.position.y - previousY) / 4);
          previousY = centre.position.y;
        }
      }
    }
    previousY = null;
  }
  check(undrivable === 0, `${label}: ${undrivable} undrivable stations`);
  check(worstStep < 0.15, `${label}: collision step ${worstStep.toFixed(3)} m (>= 0.15)`);
  check(worstDivergence < 0.12,
    `${label}: collision diverges ${worstDivergence.toFixed(3)} m from the rendered lane (sinking)`);
  check(worstGrade < 0.06, `${label}: grade ${(worstGrade * 100).toFixed(1)} % (>= 6 %)`);
}

// --- 4. open gates ------------------------------------------------------------------
check((area.fenceOpenings || []).length === 0, 'side fence unexpectedly opened');
const fenceLine = area.width * 0.5 - 0.3;
const segmentsCross = (a1, a2, b1, b2) => {
  const d = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = d(b1, b2, a1); const d2 = d(b1, b2, a2);
  const d3 = d(a1, a2, b1); const d4 = d(a1, a2, b2);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
};
for (const [label, route] of connectors) {
  if (!route) continue;
  // The lane must cross the END line inside the deck's footprint width, and
  // must never cross the side fence line while over the deck.
  let endCross = null;
  let sideCross = 0;
  let previous = null;
  for (let s = 0; s <= route.length; s += 0.5) {
    const l = local(map._sampleCenter(route, Math.min(s, route.length), 1).position);
    if (previous) {
      const crossedEnd = (Math.abs(previous.u) - area.length * 0.5) * (Math.abs(l.u) - area.length * 0.5) < 0
        && Math.abs(l.v) < area.width * 0.5;
      if (crossedEnd && endCross === null) endCross = l;
      const insideU = Math.abs(l.u) < area.length * 0.5 && Math.abs(previous.u) < area.length * 0.5;
      if (insideU && (Math.abs(previous.v) - fenceLine) * (Math.abs(l.v) - fenceLine) < 0) sideCross += 1;
    }
    previous = l;
  }
  check(!!endCross, `${label} never crosses a deck end line`);
  check(sideCross === 0, `${label} crosses the side fence line ${sideCross} times`);
  // The visible host guardrail must be open where the lane crosses the
  // carriageway edge line (physics is corridor-based and always allows the
  // crossing — but a rendered rail across the mouth is exactly the "removed
  // wall section" look this checkpoint bans).
  const ramp8 = map.routes.get('ramp_8');
  {
    let crossing = null;
    let previous = null;
    for (let s = 0; s <= route.length; s += 1) {
      const point = map._sampleCenter(route, Math.min(s, route.length), 1).position;
      const projection = map._projectToRoute(ramp8, point);
      const edge = map._halfWidthAt(ramp8, projection.distance) + 0.42;
      const outside = Math.abs(projection.signedLateral) > edge;
      if (previous !== null && outside !== previous && crossing === null) crossing = projection.distance;
      previous = outside;
    }
    check(crossing !== null, `${label} never crosses the ramp_8 edge line`);
    if (crossing !== null) {
      const hostSample = map._sampleCenter(ramp8, crossing, 1);
      const sampleU = (hostSample.position.x - area.center.x) * area.tangent.x
        + (hostSample.position.z - area.center.z) * area.tangent.z;
      const axisPoint = area.center.clone().addScaledVector(area.tangent, sampleU);
      const deckSide = Math.sign(axisPoint.sub(hostSample.position).dot(hostSample.normal)) || 1;
      const runs = ramp8._railRuns?.[deckSide] || [];
      const list = Array.isArray(runs) ? runs : runs.runs || [];
      const blocked = list.some((run) => {
        const from = run.from ?? run.start ?? run[0];
        const to = run.to ?? run.end ?? run[1];
        return crossing > from + 0.5 && crossing < to - 0.5;
      });
      check(!blocked, `${label}: a visible guardrail crosses the mouth at ramp_8@${crossing.toFixed(0)}`);
    }
  }
  // Physics gate: sweep the whole lane like the car does — no wall hit.
  let sweepHits = 0;
  let previousPoint = null;
  for (let s = 0; s <= route.length; s += 2) {
    const point = map._sampleCenter(route, Math.min(s, route.length), 1).position.clone();
    point.y += 0.45;
    if (previousPoint) {
      const hit = map.sweepWallCollision(previousPoint, point, null, 0.62, 2);
      if (hit?.hit) sweepHits += 1;
    }
    previousPoint = point;
  }
  check(sweepHits === 0, `${label}: ${sweepHits} wall-collision hits sweeping the lane`);
  check(!!map.junctionZones.find((candidate) => candidate.branch?.id === route.id),
    `${label} junction zone missing`);
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
  check(sampled > 5, `${wanganId}: only ${sampled} stations under the deck footprint`);
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
  'traffic routes onto a Tatsumi connector');
// Traffic never enters the lot: no traffic lane centreline passes inside
// the deck rectangle (with margin) anywhere near deck height. The flanking
// ramps must stay outside the fence, not just outside the slab.
{
  let laneInLot = 0;
  let laneMargin = Infinity;
  for (const lane of map.trafficLanes) {
    const laneRoute = map.routes.get(lane.routeId);
    if (!laneRoute) continue;
    for (let s = 0; s < laneRoute.length; s += 2) {
      const sample = map.sampleLane(laneRoute.id, s, lane.laneIndex ?? lane.lane ?? 0, lane.direction ?? 1);
      if (Math.abs(sample.position.y - area.elevation) > 5) continue;
      const l = local(sample.position);
      const du = Math.abs(l.u) - area.length * 0.5;
      const dv = Math.abs(l.v) - area.width * 0.5;
      if (du < 0 && dv < 1.5) laneInLot += 1;
      if (du < 0) laneMargin = Math.min(laneMargin, dv);
    }
  }
  check(laneInLot === 0,
    `${laneInLot} traffic-lane stations inside the lot fence line (closest ${laneMargin.toFixed(2)} m)`);
}
const laneSample = map.sampleLane('wangan_0', 8000, 0, 1);
const laneTangent = map._sampleCenter('wangan_0', 8000, 1).tangent;
check(laneSample.tangent.dot(laneTangent) > 0.99, 'lane sampling does not face the route tangent');
// Legal continuation: PA exit -> ramp_8 (downstream) -> wangan_0 mainline.
const exitEdge = map.edges.find((edge) => edge.from.routeId === 'tatsumi_pa_exit');
check(exitEdge?.kind === 'merge' && exitEdge?.to.routeId === 'ramp_8', 'exit edge does not merge onto ramp_8');
const entryEdge = map.edges.find((edge) => edge.to.routeId === 'tatsumi_pa_entry');
check(entryEdge?.kind === 'diverge' && entryEdge?.from.routeId === 'ramp_8'
  && entryEdge?.probability === 0,
'entry edge is not a probability-0 diverge from ramp_8');
const rampToWangan = map.edges.find((edge) => edge.from.routeId === 'ramp_8' && edge.kind === 'merge');
check(rampToWangan?.to.routeId === 'wangan_0', `ramp_8 merges into ${rampToWangan?.to.routeId}`);
if (exitEdge && entryEdge && rampToWangan) {
  check(entryEdge.from.distance < exitEdge.to.distance,
    'entry diverge is not upstream of the exit merge on ramp_8');
  check(rampToWangan.from.distance > exitEdge.to.distance,
    'ramp_8 reaches wangan_0 upstream of the PA glue (wrong direction)');
  const wangan0 = map.routes.get('wangan_0');
  check(wangan0.length - rampToWangan.to.distance > 20000,
    `only ${((wangan0.length - rampToWangan.to.distance) / 1000).toFixed(1)} km of wangan_0 ahead of the merge`);
}
const uturnIn = map.edges.find((edge) => edge.from.routeId === 'wangan_1' && `${edge.to.routeId}`.includes('uturn'));
check(!!uturnIn, 'wangan_1 does not reach a turnaround');
if (uturnIn) {
  const uturnOut = map.edges.find((edge) => edge.from.routeId === uturnIn.to.routeId);
  check(uturnOut?.to.routeId === 'wangan_0', `turnaround continues into ${uturnOut?.to.routeId}`);
}

// --- 7. nothing else enabled --------------------------------------------------------
const serviceRoutes = [...map.routes.values()].filter((route) => route.kind === 'service');
check(serviceRoutes.length === 2
  && serviceRoutes.every((route) => ['tatsumi_pa_entry', 'tatsumi_pa_exit'].includes(route.id)),
`service routes: ${serviceRoutes.map((route) => route.id).join(', ') || '(none)'}`);
check(map.serviceAreas.length === 4, `${map.serviceAreas.length} service areas registered`);
for (const other of map.serviceAreas) {
  const info = map.getRoadInfo(other.center.clone().add({ x: 0, y: 0.4, z: 0 }));
  check(!!info?.inServiceArea && !!info?.drivable, `${other.id} lot centre not drivable`);
  check(other.id === 'tatsumi_pa' || other.dressingMinimal !== true,
    `${other.id} unexpectedly flagged dressingMinimal`);
}
const twinGarage = twin.serviceAreas.find((candidate) => candidate.hasGarage);
check(twinGarage?.id === 'shibaura_pa', `paAccessLanes twin garage is ${twinGarage?.id}`);
check(!!twinGarage?.accessRouteId && twin.routes.has(twinGarage.accessRouteId),
  'paAccessLanes twin lost the Shibaura garage connector');

console.log(`\ndeck ${area.width.toFixed(1)}x${area.length.toFixed(1)} | spawn u=${spawnLocal.u.toFixed(1)} v=${spawnLocal.v.toFixed(1)} (ring ${spawnToRing.toFixed(1)} m) | entry ${map.routes.get(area.entryRouteId)?.length.toFixed(0)} m, exit ${map.routes.get(area.exitRouteId)?.length.toFixed(0)} m`);
if (failures) { console.log(`TATSUMI PA FLOW PROBE: FAIL (${failures})`); process.exit(1); }
console.log('TATSUMI PA FLOW PROBE: PASS');
