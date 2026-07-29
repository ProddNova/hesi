/**
 * Lamp coverage audit: how many lampposts each route carries, on which kerb,
 * how many the Tatsumi clearing zeroes, and whether the instance indices the
 * editor saved still address the instances they were saved against.
 *
 * Both lamp rows are expected on every route: the first walk lights one kerb,
 * the mirror pass (_buildMirrorSideLamps) lights the other.
 *
 * Run: node .devtests/lamp-coverage-probe.mjs [--verbose]
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { HighwayMap } from '../js/map.js';

const VERBOSE = process.argv.includes('--verbose');
const proto = HighwayMap.prototype;
const originalInstance = proto._instance;
const originalLamps = proto._queueRouteLamps;

const lamps = [];
let currentRoute = null;
let currentMirror = false;
proto._queueRouteLamps = function patchedLamps(route, mirror) {
  currentRoute = route;
  currentMirror = !!mirror;
  const result = originalLamps.call(this, route, mirror);
  currentRoute = null;
  return result;
};
proto._instance = function patchedInstance(position, scale, quaternion, color, type) {
  const result = originalInstance.call(this, position, scale, quaternion, color, type);
  if (currentRoute && type === 'lamppost:concrete') {
    const bucket = this._chunkInstances.get(this._chunkKey(position.x, position.z)).get(type);
    lamps.push({
      route: currentRoute.id,
      kind: currentRoute.kind,
      mirror: currentMirror,
      suppressed: bucket[bucket.length - 1].suppressed,
    });
  }
  return result;
};

const started = Date.now();
const map = new HighwayMap(null, {});
console.log(`world built in ${((Date.now() - started) / 1000).toFixed(1)} s`);

const byRoute = new Map();
for (const lamp of lamps) {
  const entry = byRoute.get(lamp.route) || { kind: lamp.kind, first: 0, mirror: 0, suppressed: 0 };
  entry[lamp.mirror ? 'mirror' : 'first'] += 1;
  if (lamp.suppressed) entry.suppressed += 1;
  byRoute.set(lamp.route, entry);
}
const firstRow = lamps.filter((lamp) => !lamp.mirror).length;
const mirrorRow = lamps.length - firstRow;
console.log(`lampposts: ${firstRow} on the first kerb, ${mirrorRow} on the mirror kerb`);

if (VERBOSE) {
  for (const [id, entry] of [...byRoute].sort((a, b) => a[0].localeCompare(b[0]))) {
    const length = Math.round(map.routes.get(id).length);
    console.log(`  ${id.padEnd(20)} ${entry.kind.padEnd(9)} len=${String(length).padStart(5)}`
      + ` first=${String(entry.first).padStart(4)} mirror=${String(entry.mirror).padStart(4)}`
      + ` zeroed=${entry.suppressed}`);
  }
}

const oneSided = [...byRoute].filter(([, entry]) => !entry.first || !entry.mirror);
const unlit = [...map.routes.values()].filter((route) => !byRoute.has(route.id));
console.log(`routes lit on one kerb only: ${oneSided.length ? oneSided.map(([id]) => id).join(', ') : 'none'}`);
console.log(`routes with no lampposts at all: ${unlit.length
  ? unlit.map((route) => `${route.id} (${route.kind}, ${Math.round(route.length)} m)`).join(', ')
  : 'none'}`);

// The PA deck is meant to stay an empty paved rectangle: nothing the clearing
// let through may end up standing on it.
const deck = map.serviceAreas?.find((area) => area.id === 'tatsumi_pa');
if (deck) {
  let onDeck = 0;
  map.group.traverse((object) => {
    // The soffit pools are deliberately under the slab, not on it.
    if (!object.isInstancedMesh || object.userData.bakedRoadLighting) return;
    const local = new THREE.Matrix4();
    const point = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let index = 0; index < object.count; index += 1) {
      object.getMatrixAt(index, local);
      scale.setFromMatrixScale(local);
      if (scale.lengthSq() === 0) continue;
      point.setFromMatrixPosition(local);
      if (map._insideTatsumiClearing(point)) onDeck += 1;
    }
  });
  console.log(`live instances standing inside the Tatsumi clearing: ${onDeck}`);
}

// Editor saves address instances by (bucket, index) with no matrix check, so a
// pass that inserts instances anywhere but at the end silently moves every edit
// saved after it. Each saved op recorded the matrix it was applied to; compare
// its translation against the instance living at that index today.
const build = JSON.parse(readFileSync(new URL('../data/editor/hesi-world-build.json', import.meta.url)));
const instanced = new Map();
map.group.traverse((object) => {
  if (object.isInstancedMesh && !instanced.has(object.name)) instanced.set(object.name, object);
});
const matrix = new THREE.Matrix4();
const here = new THREE.Vector3();
const there = new THREE.Vector3();
let matched = 0;
const drifted = [];
let unresolved = 0;
for (const op of build.operations) {
  if (op.op !== 'instance') continue;
  const mesh = instanced.get(op.mesh);
  if (!mesh || !Number.isInteger(op.index) || op.index >= mesh.count) { unresolved += 1; continue; }
  mesh.getMatrixAt(op.index, matrix);
  here.setFromMatrixPosition(matrix);
  there.set(op.matrix[12], op.matrix[13], op.matrix[14]);
  const zeroed = mesh.userData?.tatsumiClearingSuppressedIndices?.includes(op.index);
  if (here.distanceTo(there) < 0.05 || (zeroed && here.lengthSq() === 0)) matched += 1;
  else drifted.push(`${op.mesh}#${op.index}`);
}
console.log(`saved editor instance ops: ${matched} still on target, ${drifted.length} drifted,`
  + ` ${unresolved} unresolved`);
if (drifted.length) console.log(`  drifted: ${drifted.join(', ')}`);
