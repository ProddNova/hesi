/**
 * Does the editor's saved world build still address what it was saved against?
 *
 * data/editor/hesi-world-build.json addresses instances by (mesh name, index)
 * and objects by (name, nameIndex) — positions are NOT part of the address.
 * So any generator change that adds, removes or reorders an _instance() call
 * of a type the file references silently re-points the user's edits at a
 * different prop. This probe catches that, because every op also stores the
 * matrix it was saved with: if the instance at that index no longer sits where
 * the op says it did, the address has drifted.
 *
 * A generator change that only adds MERGED geometry (chunk quads, buildings)
 * can never drift these — that is why _buildInfill runs last and places
 * nothing instanced.
 *
 * Run: node .devtests/editor-build-ops-probe.mjs
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HighwayMap } from '../js/map.js';

const BUILD = fileURLToPath(new URL('../data/editor/hesi-world-build.json', import.meta.url));
const TOLERANCE = 0.05; // metres; the file stores 5 decimals

const build = JSON.parse(readFileSync(BUILD, 'utf8'));
const operations = build.operations || [];
const map = new HighwayMap(null, {});

const instanced = new Map();
const named = new Map();
map.group.traverse((object) => {
  if (object.isInstancedMesh) { instanced.set(object.name, object); return; }
  if (!object.name) return;
  if (!named.has(object.name)) named.set(object.name, []);
  named.get(object.name).push(object);
});

const matrix = new THREE.Matrix4();
const point = new THREE.Vector3();
const drifted = [];
const missing = [];
let checkable = 0;
let onTarget = 0;
let unverifiable = 0;

for (const op of operations) {
  // Only a HIDE can be checked. The editor writes a hidden instance as a
  // zeroed basis with the generator's own translation left in place, so that
  // translation is exactly what the index used to hold. An op that moved or
  // rescaled its target stores the user's new transform instead, which says
  // nothing about where the generator put it — those are counted, not judged.
  if (op.op !== 'instance' || !Array.isArray(op.matrix) || !op.matrix.slice(0, 12).every((v) => v === 0)) {
    unverifiable += 1;
    continue;
  }
  const label = `${op.mesh} [${op.index}]`;
  const mesh = instanced.get(op.mesh);
  if (!mesh || op.index >= mesh.count) { missing.push(`${label} — no such instance any more`); continue; }
  checkable += 1;
  mesh.getMatrixAt(op.index, matrix);
  const actual = point.setFromMatrixPosition(matrix).clone();
  const expected = new THREE.Vector3(op.matrix[12], op.matrix[13], op.matrix[14]);
  const distance = actual.distanceTo(expected);
  if (distance <= TOLERANCE) { onTarget += 1; continue; }
  drifted.push(`${label} — hidden at ${expected.toArray().map((v) => v.toFixed(2)).join(', ')}, index now holds ${actual.toArray().map((v) => v.toFixed(2)).join(', ')} (${distance.toFixed(1)} m off)`);
}

console.log('\n=== editor build ops ===');
console.log(BUILD);
console.log(`ops: ${operations.length}  ·  hide ops checked: ${checkable}  ·  on target: ${onTarget}  ·  move/object ops (not checkable): ${unverifiable}`);
for (const line of missing) console.log(`  GONE     ${line}`);
if (drifted.length) {
  console.log(`\nDRIFTED (${drifted.length}) — these hides now apply to a different prop:`);
  for (const line of drifted) console.log(`  ${line}`);
} else if (!missing.length) {
  console.log('no drift');
}
process.exitCode = 0;
