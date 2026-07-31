/**
 * Diagnostic for the leftovers reported around the J13 merge, plus a census of
 * every lay-by and what lights it.
 *
 * Run: node .devtests/merge-residue-diag.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const proto = HighwayMap.prototype;
const originalInstance = proto._instance;
const originalDetails = proto._queueRouteDetails;
const originalSignage = proto._buildSignage;

const records = [];
let current = null;
proto._queueRouteDetails = function patched(route) {
  current = route.id;
  const result = originalDetails.call(this, route);
  current = null;
  return result;
};
proto._buildSignage = function patchedSignage() {
  current = 'SIGNAGE';
  const result = originalSignage.call(this);
  current = null;
  return result;
};
proto._instance = function patchedInstance(position, scale, quaternion, color, type) {
  const result = originalInstance.call(this, position, scale, quaternion, color, type);
  if (current) records.push({ owner: current, type, position: position.clone(), scale: scale.clone() });
  return result;
};

const map = new HighwayMap(null, {});
const t = map.progressiveTransitions.find((r) => r.id.startsWith('J13:'));
const host = map.routes.get(t.hostRouteId);

console.log(`== instances owned by ${host.id} between host s ${t.approachStart.toFixed(0)} and ${t.transitionEnd.toFixed(0)}`);
const rows = [];
for (const record of records) {
  if (record.owner !== host.id && record.owner !== 'SIGNAGE') continue;
  const projection = map._projectToRoute(host, record.position);
  if (projection.endOvershoot > 2) continue;
  if (projection.distance < t.approachStart - 40 || projection.distance > t.transitionEnd + 40) continue;
  if (record.owner === 'SIGNAGE' && Math.abs(projection.signedLateral) > 40) continue;
  const env = map._progressiveEnvelopeAt(host, projection.distance);
  const outer = env && env.transition.sideSign === t.sideSign ? Math.abs(env.envelope.outerLateral) : null;
  const drawn = map._edgeHalfAt(host, projection.distance, t.sideSign);
  rows.push({
    owner: record.owner,
    type: record.type,
    s: projection.distance,
    lat: projection.signedLateral,
    // >0 = standing inside the real pavement
    inside: Math.max(drawn, outer ?? 0) - Math.abs(projection.signedLateral),
    onSide: Math.sign(projection.signedLateral) === t.sideSign,
  });
}
rows.sort((a, b) => a.s - b.s);
const stray = rows.filter((row) => row.onSide && row.inside > 1.0);
console.log(`  ${rows.length} instances, of which ${stray.length} stand more than 1 m inside the paved edge:`);
for (const row of stray) {
  console.log(`    ${row.type.padEnd(20)} owner=${row.owner.padEnd(9)} s=${row.s.toFixed(1).padStart(7)}`
    + ` lateral=${row.lat.toFixed(2).padStart(7)} inside=${row.inside.toFixed(2)}`);
}
const byType = new Map();
for (const row of rows) byType.set(row.type, (byType.get(row.type) || 0) + 1);
console.log(`  types present: ${[...byType].map(([k, v]) => `${k}x${v}`).join(', ')}`);

console.log(`\n== ${host.id} rail runs on the transition side (${t.sideSign})`);
for (const run of (host._railRuns?.[t.sideSign] || [])) {
  if (run.to < t.approachStart - 60 || run.from > t.transitionEnd + 60) continue;
  console.log(`  ${run.from.toFixed(1)} .. ${run.to.toFixed(1)}  cut=${run.cutCause || '-'}`);
}

console.log('\n== every lay-by on the network');
for (const layby of map.laybys) {
  console.log(`  ${layby.route.id.padEnd(12)} side=${String(layby.side).padStart(2)}`
    + ` ${layby.start.toFixed(1)}..${layby.end.toFixed(1)} extra=${layby.extra}`
    + ` taper=${layby.taperIn}/${layby.taperOut} paZone=${layby.paZone || '-'}`);
}

console.log('\n== junction name masts');
console.log(`  ${map.junctions.length} junctions -> ${map.junctions.length} masts +`
  + ` ${map.junctions.length * 2} boards`);
for (const junction of map.junctions.slice(0, 6)) {
  console.log(`    ${junction.id} "${junction.name}" at`
    + ` (${junction.point.x.toFixed(0)}, ${junction.point.y.toFixed(0)}, ${junction.point.z.toFixed(0)})`);
}
void THREE;
