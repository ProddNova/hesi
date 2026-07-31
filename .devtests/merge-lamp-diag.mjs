/**
 * Diagnostic: where do the lampposts stand around the ramp_8 -> wangan_0
 * progressive merge (J13), and around the Tatsumi PA lay-by on ramp_8?
 *
 * Run: node .devtests/merge-lamp-diag.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const proto = HighwayMap.prototype;
const originalInstance = proto._instance;
const originalLamps = proto._queueRouteLamps;

const lamps = [];
let current = null;
proto._queueRouteLamps = function patched(route) {
  current = route;
  const result = originalLamps.call(this, route);
  current = null;
  return result;
};
proto._instance = function patchedInstance(position, scale, quaternion, color, type) {
  const result = originalInstance.call(this, position, scale, quaternion, color, type);
  if (current && type === 'lamppost:concrete') {
    const bucket = this._chunkInstances.get(this._chunkKey(position.x, position.z)).get(type);
    lamps.push({
      route: current.id,
      position: position.clone(),
      suppressed: bucket[bucket.length - 1].suppressed,
    });
  }
  return result;
};

const map = new HighwayMap(null, {});
console.log(`lampposts captured: ${lamps.length}`);

// Resolve each lamp's station on its own route (the loop does not hand it over).
for (const lamp of lamps) {
  const route = map.routes.get(lamp.route);
  const projection = map._projectToRoute(route, lamp.position);
  lamp.distance = projection.distance;
  lamp.lateral = projection.signedLateral;
}

const t = map.progressiveTransitions.find((r) => r.id.startsWith('J13:'));
if (!t) { console.log('no J13 transition'); process.exit(1); }
console.log(`\n== ${t.id}`);
console.log(`  host=${t.hostRouteId} branch=${t.branchRouteId} side=${t.side}(${t.sideSign})`
  + ` anchor=${t.branchAnchor} topology=${t.topology}`);
console.log(`  host  approach=${t.approachStart.toFixed(1)} opening=${t.openingStart.toFixed(1)}`
  + ` parallel/FULL5=${t.parallelStart.toFixed(1)} absorption=${t.absorptionStart.toFixed(1)}`
  + ` end=${t.transitionEnd.toFixed(1)}`);
console.log(`  branch interval=[${t.branchInterval.map((v) => v.toFixed(1)).join(', ')}]`
  + ` of ${map.routes.get(t.branchRouteId).length.toFixed(1)} m`);

const host = map.routes.get(t.hostRouteId);
const branch = map.routes.get(t.branchRouteId);
console.log(`  host lampSide=${map._lampSideFor(host)}  branch lampSide=${map._lampSideFor(branch)}`);

console.log(`\n-- ${host.id} lamps in [${(t.approachStart - 120).toFixed(0)}, ${(t.transitionEnd + 120).toFixed(0)}]`);
console.log('    s      poleLateral  edgeHalf  halfWidth  envOuter  insideSurfaceBy  suppressed');
for (const lamp of lamps.filter((l) => l.route === host.id
  && l.distance > t.approachStart - 120 && l.distance < t.transitionEnd + 120)) {
  const side = map._lampSideFor(host);
  const mountHalf = map._edgeHalfAt(host, lamp.distance, side);
  const half = map._halfWidthAt(host, lamp.distance);
  const env = map._progressiveEnvelopeAt(host, lamp.distance);
  const outer = env && env.transition.sideSign === side ? env.envelope.outerLateral : null;
  // How far the pole stands INSIDE the real pavement edge (>0 = on the road).
  const edge = Math.max(mountHalf, outer === null ? 0 : Math.abs(outer));
  const inside = edge - Math.abs(lamp.lateral);
  console.log(`  ${lamp.distance.toFixed(1).padStart(7)}  ${lamp.lateral.toFixed(2).padStart(10)}`
    + `  ${mountHalf.toFixed(2).padStart(7)}  ${half.toFixed(2).padStart(8)}`
    + `  ${(outer === null ? '-' : outer.toFixed(2)).padStart(8)}`
    + `  ${inside.toFixed(2).padStart(14)}  ${lamp.suppressed}`);
}

console.log(`\n-- ${branch.id} lamps (length ${branch.length.toFixed(1)}), lampSide=${map._lampSideFor(branch)}`);
const branchLamps = lamps.filter((l) => l.route === branch.id).sort((a, b) => a.distance - b.distance);
for (const lamp of branchLamps) {
  const side = map._lampSideFor(branch);
  console.log(`  s=${lamp.distance.toFixed(1).padStart(7)}`
    + ` mountHalf=${map._edgeHalfAt(branch, lamp.distance, side).toFixed(2).padStart(6)}`
    + ` half=${map._halfWidthAt(branch, lamp.distance).toFixed(2).padStart(6)}`
    + ` layby=${map._laybyAt(branch, lamp.distance, side) ? 'yes' : 'no '}`
    + ` inClearing=${map._insideTatsumiClearing(lamp.position, 0.6)}`
    + ` suppressed=${lamp.suppressed}`);
}

console.log('\n-- ramp_8 lay-bys');
for (const layby of branch.laybys || []) {
  console.log(`  side=${layby.side} start=${layby.start.toFixed(1)} end=${layby.end.toFixed(1)}`
    + ` extra=${(layby.extra ?? layby.width ?? '?')} taperIn=${layby.taperIn} taperOut=${layby.taperOut}`);
}

const area = map.serviceAreas?.find((a) => a.id === 'tatsumi_pa');
if (area) {
  console.log(`\n-- tatsumi_pa deck: center=(${area.center.x.toFixed(1)}, ${area.center.y.toFixed(1)},`
    + ` ${area.center.z.toFixed(1)}) L=${area.length.toFixed(1)} W=${area.width.toFixed(1)}`
    + ` routeId=${area.routeId} rampSideSign=${area.rampSideSign} elevation=${(area.elevation ?? 0).toFixed(2)}`);
  const projection = map._projectToRoute(branch, area.center);
  console.log(`  deck centre projects to ramp_8 s=${projection.distance.toFixed(1)}`
    + ` lateral=${projection.signedLateral.toFixed(2)}`);
}

console.log('\n-- ramp_8 barrier-suppression / clearing walk (every 20 m, lamp side)');
{
  const side = map._lampSideFor(branch);
  for (let d = 0; d < branch.length; d += 20) {
    const center = map._sampleCenter(branch, d, 1);
    const tangent = center.baseTangent;
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    const mountHalf = map._edgeHalfAt(branch, d, side);
    const frame = { position: center.position, tangent, normal, bank: map._bankAt(branch, d) };
    const point = map._deckPoint(frame, side * (mountHalf - 0.62), 0.01);
    const blocked = map._barrierSuppressed(point, branch, !!map._laybyAt(branch, d, side));
    const clearing = map._insideTatsumiClearing(point, 0.6);
    if (blocked || clearing) {
      console.log(`  s=${d.toFixed(0).padStart(5)} barrierSuppressed=${blocked} inClearing=${clearing}`);
    }
  }
}
