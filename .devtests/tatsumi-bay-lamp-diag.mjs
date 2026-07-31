/**
 * Diagnostic: the Tatsumi PA lay-by ("slargo") lamp row on ramp_8 — are the
 * poles there, do they stand on the bay's outer edge, and are they clear of
 * the PA deck slab?
 *
 * Run: node .devtests/tatsumi-bay-lamp-diag.mjs
 */
import * as THREE from 'three';
import { HighwayMap } from '../js/map.js';

const map = new HighwayMap(null, {});
const ramp = map.routes.get('ramp_8');
const area = map.serviceAreas.find((a) => a.id === 'tatsumi_pa');
const deckY = area.elevation ?? area.center.y;
const layby = map.laybys.find((l) => l.paZone);
console.log(`PA bay: route=${layby.route.id} side=${layby.side} ${layby.start.toFixed(1)}..${layby.end.toFixed(1)}`
  + ` taperIn=${layby.taperIn} taperOut=${layby.taperOut}  deck y=${deckY.toFixed(2)}`);

const named = new Map();
map.group.traverse((object) => { if (object.name.startsWith('Tatsumi bay')) named.set(object.name, object); });
if (!named.size) { console.log('FAIL: no Tatsumi bay lamp meshes'); process.exit(1); }

const matrix = new THREE.Matrix4();
const point = new THREE.Vector3();
const scale = new THREE.Vector3();
for (const [name, mesh] of named) {
  console.log(`\n${name}: ${mesh.count} instances, material=${mesh.material.name || mesh.material.type}`);
  for (let i = 0; i < mesh.count; i += 1) {
    mesh.getMatrixAt(i, matrix);
    point.setFromMatrixPosition(matrix);
    scale.setFromMatrixScale(matrix);
    const projection = map._projectToRoute(ramp, point);
    console.log(`  #${i} s=${projection.distance.toFixed(1).padStart(6)}`
      + ` lateral=${projection.signedLateral.toFixed(2).padStart(6)}`
      + ` edgeHalf=${map._edgeHalfAt(ramp, projection.distance, layby.side).toFixed(2)}`
      + ` y=${point.y.toFixed(2)} (deck ${(point.y - deckY).toFixed(2)})`
      + ` scale=${scale.x.toFixed(2)},${scale.y.toFixed(2)},${scale.z.toFixed(2)}`);
  }
}

// Would the PA deck slab hide any of it? The slab is a flat box whose top is
// area.elevation; anything below that inside the rectangle is out of sight.
console.log('\nocclusion by the PA deck slab (corner samples per pool):');
{
  const pools = named.get('Tatsumi bay light pools');
  const corner = new THREE.Vector3();
  for (let i = 0; i < pools.count; i += 1) {
    pools.getMatrixAt(i, matrix);
    let buried = 0;
    const samples = [];
    for (const cx of [-0.5, -0.25, 0, 0.25, 0.5]) {
      for (const cz of [-0.5, -0.25, 0, 0.25, 0.5]) {
        corner.set(cx, 0, cz).applyMatrix4(matrix);
        samples.push(corner.clone());
        if (map._insideTatsumiClearing(corner, 0) && corner.y < deckY) buried += 1;
      }
    }
    console.log(`  pool #${i}: ${buried}/${samples.length} samples under the slab`);
  }
}

const paint = [];
map.nearestCarPaintLights(named.get('Tatsumi bay lamp lenses') ? (() => {
  named.get('Tatsumi bay lamp lenses').getMatrixAt(0, matrix);
  return point.setFromMatrixPosition(matrix).clone();
})() : ramp.samples[0].point, 70, 4, paint);
console.log(`\ncar-paint lights within 70 m of bay lens #0: ${paint.length}`
  + ` (${paint.map((p) => p.materialName).join(', ')})`);
