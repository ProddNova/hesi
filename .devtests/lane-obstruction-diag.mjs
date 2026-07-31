/**
 * Two audits:
 *  1. Does any lamppost stand inside a drivable surface that is NOT its own
 *     kerb line? (Its own row sits 0.62 m in from the drawn edge, i.e. 0.2 m
 *     inboard of the parapet — that is the design, not an offence.)
 *  2. Where does the paint down the middle of ramp_8 stop, and does anything
 *     take over?
 *
 * Run: node .devtests/lane-obstruction-diag.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const proto = HighwayMap.prototype;
const originalQuad = proto._pushQuad;
const paint = [];
let paintRoute = null;
let paintTag = null;
const originalPaint = proto._paintStrip;
proto._paintStrip = function patched(route, materialName, ...rest) {
  paintRoute = route.id;
  paintTag = `${materialName}/${this._markingTag || '?'}`;
  const result = originalPaint.call(this, route, materialName, ...rest);
  paintRoute = null;
  return result;
};
proto._pushQuad = function patchedQuad(bucket, a, b, c, d) {
  const result = originalQuad.call(this, bucket, a, b, c, d);
  if (paintRoute) {
    paint.push({
      route: paintRoute,
      tag: paintTag,
      position: new THREE.Vector3((a.x + b.x + c.x + d.x) / 4, (a.y + b.y + c.y + d.y) / 4, (a.z + b.z + c.z + d.z) / 4),
    });
  }
  return result;
};

const map = new HighwayMap(null, { markingDebug: true });

// ---- 1. lampposts in a lane ---------------------------------------------
const poles = [];
map.group.traverse((object) => {
  if (!object.isInstancedMesh) return;
  if (!object.name.includes('lamppost:concrete') && object.name !== 'Tatsumi bay lampposts') return;
  const matrix = new THREE.Matrix4();
  const point = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < object.count; i += 1) {
    object.getMatrixAt(i, matrix);
    scale.setFromMatrixScale(matrix);
    if (scale.lengthSq() === 0) continue;
    point.setFromMatrixPosition(matrix);
    poles.push({ mesh: object.name, index: i, position: point.clone() });
  }
});

const offenders = [];
for (const pole of poles) {
  let worst = null;
  for (const { route, index } of map._candidateRoutes(pole.position).values()) {
    if (route.removed) continue;
    const projection = map._projectToRoute(route, pole.position, index);
    if (projection.endOvershoot > 2) continue;
    // The pavement the driver actually has here, envelope included.
    const half = map._edgeHalfAt(route, projection.distance, Math.sign(projection.signedLateral) || 1);
    const deckY = projection.point.y
      + Math.tan(map._bankAt(route, projection.distance)) * projection.signedLateral;
    if (Math.abs(pole.position.y - deckY) > 2.5) continue;
    // 0.75 m of slack: the row legitimately stands 0.62 m in from the edge.
    const inside = half - 0.75 - Math.abs(projection.signedLateral);
    if (inside <= 0) continue;
    if (!worst || inside > worst.inside) {
      worst = { routeId: route.id, s: projection.distance, lateral: projection.signedLateral, half, inside };
    }
  }
  if (worst) offenders.push({ pole, ...worst });
}
offenders.sort((a, b) => b.inside - a.inside);
console.log(`live lampposts: ${poles.length}  ·  standing in a lane: ${offenders.length}`);
for (const o of offenders) {
  console.log(`  ${o.pole.mesh}#${o.pole.index} -> ${o.routeId} s=${o.s.toFixed(1)}`
    + ` lateral=${o.lateral.toFixed(2)} pavedHalf=${o.half.toFixed(2)} inside=${o.inside.toFixed(2)} m`
    + ` at (${o.pole.position.x.toFixed(0)}, ${o.pole.position.y.toFixed(1)}, ${o.pole.position.z.toFixed(0)})`);
}

// ---- 2. paint down ramp_8 ------------------------------------------------
const ramp = map.routes.get('ramp_8');
console.log(`\nramp_8 (${ramp.length.toFixed(0)} m, ${ramp.lanes} lanes) — paint quads within one lane width of its centreline:`);
const stations = [];
for (const quad of paint) {
  const projection = map._projectToRoute(ramp, quad.position);
  if (projection.endOvershoot > 2) continue;
  if (Math.abs(quad.position.y - projection.point.y) > 2.5) continue;
  if (!/laneDivider|progressiveMergeDivider/.test(quad.tag)) continue;
  if (Math.abs(projection.signedLateral) > ramp.laneWidth * 1.4) continue;
  stations.push({ s: projection.distance, owner: quad.route, tag: quad.tag, lateral: projection.signedLateral });
}
stations.sort((a, b) => a.s - b.s);
console.log(`  ${stations.length} quads; owners: ${[...new Set(stations.map((q) => `${q.owner} ${q.tag}`))].join(', ')}`);
let previous = 0;
for (const station of stations) {
  if (station.s - previous > 10) {
    console.log(`    GAP ${previous.toFixed(1)} .. ${station.s.toFixed(1)} (${(station.s - previous).toFixed(1)} m)`);
  }
  previous = Math.max(previous, station.s);
}
// A doubled or kinked line shows up as two owners painting the same station,
// or as a lateral step between consecutive quads.
let step = 0; let stepAt = null; let prior = null;
for (const station of stations) {
  if (prior && Math.abs(station.lateral - prior.lateral) > step && station.s - prior.s < 12) {
    step = Math.abs(station.lateral - prior.lateral); stepAt = `${prior.s.toFixed(1)}->${station.s.toFixed(1)}`;
  }
  prior = station;
}
console.log(`  worst lateral step between consecutive divider quads: ${step.toFixed(2)} m at ${stepAt}`);
const overlaps = stations.filter((q, i) => i > 0 && Math.abs(q.s - stations[i - 1].s) < 2 && q.owner !== stations[i - 1].owner);
console.log(`  stations painted by BOTH owners (doubled line): ${overlaps.length}`);
if (ramp.length - previous > 10) console.log(`    GAP ${previous.toFixed(1)} .. end (${(ramp.length - previous).toFixed(1)} m)`);
