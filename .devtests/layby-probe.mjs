/**
 * Does the Ramp 8 emergency lay-by (非常駐車帯) actually exist as a widened,
 * drivable, railed bay — and does it leave the rest of the road alone?
 *
 * The lay-by is defined once in map.js LAYBYS and read by _laybyExtraAt; every
 * consumer (drawn deck edge, parapet, wall segments, physics corridor) derives
 * from that, so the checks here follow the same chain the game does:
 *
 *  1  the paved edge widens to the requested extra at the plateau and returns
 *     to the plain shoulder edge outside the span, tangentially;
 *  2  the deck quads actually reach the widened edge (the surface frames were
 *     refined enough to follow the taper);
 *  3  the parapet/wall segments moved out with it — no rail left cutting
 *     across the bay, no gap in the run;
 *  4  physics accepts a car parked in the bay and still refuses the void just
 *     outside it;
 *  5  the through lanes, their markings and the traffic lanes are untouched.
 *
 * Run: node .devtests/layby-probe.mjs
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HighwayMap } from '../js/map.js';

const ROUTE_ID = 'ramp_8';
const BUILD = fileURLToPath(new URL('../data/editor/hesi-world-build.json', import.meta.url));
const CLICKED = new THREE.Vector3(3604.4961190761646, 59.471967371157845, -4047.937603308453);

const map = new HighwayMap(null, {});
const route = map.routes.get(ROUTE_ID);
const failures = [];
const notes = [];
const check = (ok, label) => { (ok ? notes : failures).push(`${ok ? 'PASS' : 'FAIL'} ${label}`); return ok; };

// ---------------------------------------------------------------- 0. registered
const layby = route?.laybys?.[0];
if (!layby) {
  console.log('FAIL no lay-by registered on', ROUTE_ID);
  process.exit(1);
}
const { start, end, taperIn, taperOut, side, extra } = layby;
const bayFrom = start + taperIn;
const bayTo = end - taperOut;
console.log(`lay-by ${layby.id}: side ${side}, span ${start.toFixed(1)}..${end.toFixed(1)} m `
  + `(bay ${bayFrom.toFixed(1)}..${bayTo.toFixed(1)}), +${extra} m`);

const clickedStation = map._projectToRoute(route, CLICKED).distance;
check(clickedStation > bayFrom && clickedStation < bayTo,
  `the requested point (s=${clickedStation.toFixed(1)}) is inside the flat bay`);

// ---------------------------------------------------------------- 1. envelope
const edgeAt = (distance, s = side) => map._surfaceEdgeLateral(map._frameAt(route, distance), s);
const plainHalf = map._halfWidthAt(route, (bayFrom + bayTo) / 2);
check(Math.abs(Math.abs(edgeAt((bayFrom + bayTo) / 2)) - (plainHalf + extra)) < 0.01,
  `bay edge = shoulder + ${extra} m (${Math.abs(edgeAt((bayFrom + bayTo) / 2)).toFixed(2)} m)`);
check(Math.abs(Math.abs(edgeAt(start - 12)) - plainHalf) < 1e-6
  && Math.abs(Math.abs(edgeAt(end + 12)) - plainHalf) < 1e-6,
  'edge is back to the plain shoulder outside the span');
check(Math.abs(Math.abs(edgeAt(-side * 0 + (bayFrom + bayTo) / 2, -side)) - plainHalf) < 1e-6,
  'the opposite shoulder is untouched');
// Shape, in the order the driver meets it: traffic runs up-chainage on ramp_8,
// so `start` is the transverse edge reached FIRST. That one is square — the bay
// opens dead on a line across it — and the far one flares back onto the
// shoulder gently enough to drive out of at speed.
const slopeOver = (from, to) => {
  let peak = 0;
  for (let d = from; d <= to; d += 0.5) {
    peak = Math.max(peak, Math.abs(Math.abs(edgeAt(d + 0.5)) - Math.abs(edgeAt(d))) / 0.5);
  }
  return peak;
};
check(taperIn === 0, 'the FIRST transverse edge is authored square (taperIn 0)');
check(taperOut > 0, `the SECOND one flares back open (taperOut ${taperOut} m)`);
const exitSlope = slopeOver(bayTo, end + 2);
check(exitSlope < 0.40, `the exit flare stays drivable (1:${(1 / exitSlope).toFixed(1)})`);

const STEP = 0.05;
check(Math.abs(Math.abs(edgeAt(start - 0.01)) - plainHalf) < 1e-6
  && Math.abs(Math.abs(edgeAt(start + STEP)) - (plainHalf + extra)) < 0.01,
  `the square end is plain shoulder at s=${start} and full width immediately after it`);
const stepFrames = route.surfaceFrames.filter((f) => f.distance >= start - 1e-4 && f.distance <= start + STEP + 1e-4);
check(stepFrames.length === 2 && Math.abs(stepFrames[1].distance - stepFrames[0].distance - STEP) < 1e-6,
  `the step is a real frame pair ${STEP} m apart (${stepFrames.length} frames), not an adaptive chamfer`);

// ---------------------------------------------------------------- 2. drawn deck
// Surface frames must be dense enough through the taper that the drawn chord
// tracks the analytic edge; sample the worst chord error over the span.
const frames = route.surfaceFrames.filter((f) => f.distance >= start - 2 && f.distance <= end + 2);
check(frames.length >= 20, `${frames.length} surface stations across the bay`);
// Measured as the lay-by's CONTRIBUTION, not the absolute error: this stretch
// of Ramp 8 has a pre-existing bank kink near s=554 that costs 0.22 m of chord
// error on the plain shoulder edge too, and an absolute threshold would just be
// re-measuring the road.
const chordError = (a, b, lateralOf) => {
  const pa = map._deckPoint(a, lateralOf(a));
  const pb = map._deckPoint(b, lateralOf(b));
  const mf = map._frameAt(route, (a.distance + b.distance) / 2);
  return map._deckPoint(mf, lateralOf(mf)).distanceTo(pa.clone().lerp(pb, 0.5));
};
// The square-end step is excluded: it is a deliberate 10 m jump inside 5 cm of
// chainage, so "chord error" there measures the feature, not the tessellation.
let worstChord = 0;
for (let i = 0; i < frames.length - 1; i += 1) {
  if (frames[i].distance < start + STEP - 1e-4) continue;
  const taper = chordError(frames[i], frames[i + 1], (f) => map._surfaceEdgeLateral(f, side));
  const plain = chordError(frames[i], frames[i + 1], (f) => side * f.half);
  worstChord = Math.max(worstChord, taper - plain);
}
check(worstChord < 0.08,
  `the taper adds almost nothing to the drawn edge's chord error (worst +${worstChord.toFixed(3)} m)`);

// ---------------------------------------------------------------- 3. parapet
const walls = map.wallSegments.filter((w) => w.routeId === ROUTE_ID && w.side === side
  && w.type === 'outer' && w.distanceStart >= start - 30 && w.distanceEnd <= end + 30);
check(walls.length > 0, `${walls.length} outer wall segments over the bay (rail run not dropped)`);
// Collision walls come from the COARSE frame level, so a segment rarely lands
// wholly inside the plateau — take the one straddling the bay midpoint.
const bayMid = (bayFrom + bayTo) / 2;
const bayWall = walls.find((w) => w.distanceStart <= bayMid && w.distanceEnd >= bayMid);
check(!!bayWall, 'a collision wall covers the middle of the bay');
if (bayWall) {
  const wallLateral = Math.abs(map._projectToRoute(route, bayWall.start.clone()
    .lerp(bayWall.end, 0.5)).signedLateral);
  check(wallLateral > plainHalf + extra - 1.2,
    `the rail over the bay stands at the OUTER edge (${wallLateral.toFixed(2)} m, not ${plainHalf.toFixed(2)})`);
}
// No parapet visibility hole: every surface segment in the span must be drawn.
const visible = map._computeBarrierVisibility(route)[side];
let holes = 0;
route.surfaceFrames.forEach((f, i) => {
  if (f.distance < start - 20 || f.distance > end + 20) return;
  if (!visible[i]) holes += 1;
});
check(holes === 0, `no parapet suppression over the bay approach (${holes} suppressed stations)`);

// ---------------------------------------------------------------- 4. physics
const parkAt = (distance, lateral) => {
  const frame = map._frameAt(route, distance);
  const point = map._deckPoint(frame, lateral, 0.6);
  return { point, info: map.getRoadInfo(point) };
};
const inBay = parkAt((bayFrom + bayTo) / 2, side * (plainHalf + extra - 1.3));
check(!!inBay.info && inBay.info.routeId === ROUTE_ID && inBay.info.onRoad,
  `a car parked in the bay is ON the road (onRoad=${inBay.info?.onRoad}, edgeDistance=${inBay.info?.edgeDistance?.toFixed(2)})`);
check(map.isPointDrivable(inBay.point, 1.25), 'the bay is drivable with a full vehicle radius');
// Ownership: this bay reaches past the (removed) Tatsumi PA lot rectangle, and
// authored road surface must outrank a lot rectangle rather than the other way
// round — otherwise getRoadInfo reports the PA and the collision bounds become
// the lot's instead of the bay's.
const deep = parkAt((bayFrom + bayTo) / 2, side * (plainHalf + extra - 0.9));
check(!!map._lotAt(deep.point, 0) && !!map._laybyOwnsPoint(deep.point),
  'the deep end of the bay does sit inside a service-area rectangle (the case under test)');
check(deep.info?.routeId === ROUTE_ID && !deep.info.inServiceArea,
  `deep in the bay the ROUTE owns the surface, not the lot (route=${deep.info?.routeId}, inServiceArea=${deep.info?.inServiceArea})`);
const deepBounds = map.getWallCollisionBounds(deep.point, 1.25);
check(deepBounds?.type === 'route' && deepBounds.routeId === ROUTE_ID,
  `collision bounds deep in the bay come from the route (${deepBounds?.type})`);
// …and a real PA lot well away from any lay-by still answers for itself.
const pa = map.serviceAreas.find((a) => a.id === 'shibaura_pa') || map.serviceAreas[0];
const onLot = pa.center.clone(); onLot.y = pa.elevation + 0.6;
check(!!map._lotAt(onLot, 0) && !map._laybyOwnsPoint(onLot)
  && map.getRoadInfo(onLot)?.inServiceArea === true,
  `an untouched PA lot (${pa.id}) still reports as a service area`);
// Just beyond the bulge THIS route's corridor must stop. Tested against the
// corridor envelope rather than isPointDrivable, because the deleted Tatsumi
// PA lot still claims that airspace in the model and would answer for it.
const pastLateral = side * (plainHalf + extra + 1.0);
const pastBay = parkAt((bayFrom + bayTo) / 2, pastLateral);
const rampCorridor = map._corridorsAt(pastBay.point, 1.25).find((c) => c.route.id === ROUTE_ID);
check(!!rampCorridor
  && map._lateralCorrection(rampCorridor, rampCorridor.projection.signedLateral, -1.25) !== 0,
  'the corridor stops at the bay edge — no drivable overhang past it');
const offOtherSide = parkAt((bayFrom + bayTo) / 2, -side * (plainHalf + 2.0));
check(!map.isPointDrivable(offOtherSide.point, 1.25), 'the widening did NOT open up the opposite shoulder');
// The wall push-back must let the car reach the outer edge, not the old one.
const outside = parkAt((bayFrom + bayTo) / 2, side * (plainHalf + extra + 1.0));
const resolved = map.resolveWallCollision(outside.point.clone(), null, 1.25);
const resolvedLateral = map._projectToRoute(route, resolved.position || outside.point).signedLateral;
check(Math.abs(resolvedLateral) > plainHalf + 0.5,
  `wall collision pushes back to the bay edge, not the lane edge (${resolvedLateral.toFixed(2)} m)`);

// ---------------------------------------------------------------- 5. no bleed
check(map._halfWidthAt(route, (bayFrom + bayTo) / 2) === route.halfWidth,
  'through-lane half-width unchanged (edge line + lane dashes stay straight)');
const laneInBay = map.sampleLane(ROUTE_ID, (bayFrom + bayTo) / 2, 0, route.oneWayDirection);
const laneOutside = map.sampleLane(ROUTE_ID, start - 40, 0, route.oneWayDirection);
const laneLateral = (sample, distance) => map._projectToRoute(route, sample.position).signedLateral;
check(Math.abs(laneLateral(laneInBay) - laneLateral(laneOutside)) < 0.05,
  'traffic lane centres are unchanged through the bay');
let otherRoutesTouched = 0;
for (const other of map.routes.values()) {
  if (other === route) continue;
  if (other.laybys) otherRoutesTouched += 1;
}
check(otherRoutesTouched === 0, 'no other route gained a lay-by');

// ------------------------------------------------- 6. editor index safety
// The bay carries parapet furniture outward and appends its own props. Neither
// may renumber an instance the editor saved against. Rebuild with the feature
// neutralised and diff every pre-existing instance matrix: a MOVE is allowed
// only where no saved op addresses that index, and nothing may be inserted or
// dropped mid-bucket (only appended at the end of a bucket).
const NoLayby = class extends HighwayMap {
  _laybyExtraAt() { return 0; }
  _buildLaybyDressing() {}
};
const meshesOf = (m) => {
  const out = new Map();
  m.group.traverse((o) => { if (o.isInstancedMesh) out.set(o.name, o); });
  return out;
};
const withBay = meshesOf(map);
const without = meshesOf(new NoLayby(null, {}));
const savedOps = new Set(JSON.parse(readFileSync(BUILD, 'utf8')).operations
  ?.filter((op) => op.op === 'instance').map((op) => `${op.mesh}|${op.index}`) || []);
const mA = new THREE.Matrix4();
const mB = new THREE.Matrix4();
const pA = new THREE.Vector3();
const pB = new THREE.Vector3();
let compared = 0;
let moved = 0;
let appended = 0;
const clobbered = [];
const shrunk = [];
for (const [name, meshB] of without) {
  const meshA = withBay.get(name);
  if (!meshA) { shrunk.push(`${name} disappeared`); continue; }
  if (meshA.count < meshB.count) shrunk.push(`${name}: ${meshB.count} -> ${meshA.count}`);
  appended += Math.max(0, meshA.count - meshB.count);
  for (let i = 0; i < Math.min(meshA.count, meshB.count); i += 1) {
    compared += 1;
    meshA.getMatrixAt(i, mA);
    meshB.getMatrixAt(i, mB);
    pA.setFromMatrixPosition(mA);
    pB.setFromMatrixPosition(mB);
    if (pA.distanceTo(pB) <= 1e-6) continue;
    moved += 1;
    if (savedOps.has(`${name}|${i}`)) clobbered.push(`${name} [${i}] moved ${pA.distanceTo(pB).toFixed(2)} m`);
  }
}
check(shrunk.length === 0,
  `no instance bucket lost entries (${shrunk.join('; ') || 'none'})`);
check(clobbered.length === 0,
  `no saved editor op had its target moved (${compared} instances compared, ${moved} moved onto the bay parapet, ${appended} appended)${clobbered.length ? ': ' + clobbered.join('; ') : ''}`);

// ---------------------------------------------------------------- report
for (const line of notes) console.log(line);
for (const line of failures) console.log(line);
console.log(`\n${notes.length}/${notes.length + failures.length} checks passed`);
process.exit(failures.length ? 1 : 0);
