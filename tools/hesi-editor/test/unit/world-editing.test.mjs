import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applyEntityTransform, decomposeFiniteMatrix, setEntityVisible, snapshotTransform,
} from '../../src/interaction/entity-transform.js';
import { WorldProjectState } from '../../src/overrides/world-project-state.js';
import { AssetRegistry } from '../../src/world/asset-registry.js';

function instanceWorld(mesh, index) {
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(index, matrix);
  return matrix.premultiply(mesh.matrixWorld);
}

test('generated instance overrides move one occurrence and its components without touching its neighbor', () => {
  const geometry = new THREE.BoxGeometry(1, 4, 1);
  const material = new THREE.MeshBasicMaterial();
  const pole = new THREE.InstancedMesh(geometry, material, 2);
  const lens = new THREE.InstancedMesh(geometry, material, 2);
  pole.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 2, 0));
  pole.setMatrixAt(1, new THREE.Matrix4().makeTranslation(10, 2, 0));
  lens.setMatrixAt(0, new THREE.Matrix4().makeTranslation(0, 6, 0));
  lens.setMatrixAt(1, new THREE.Matrix4().makeTranslation(10, 6, 0));
  pole.updateMatrixWorld(true);
  lens.updateMatrixWorld(true);
  const proxy = new THREE.Object3D();
  proxy.position.set(0, 2, 0);
  const entity = {
    object3D: proxy,
    metadata: {
      sourceWorldMatrix: instanceWorld(pole, 0).toArray(),
      instanceComponents: [
        { mesh: pole, instanceIndex: 0, sourceWorldMatrix: instanceWorld(pole, 0).toArray() },
        { mesh: lens, instanceIndex: 0, sourceWorldMatrix: instanceWorld(lens, 0).toArray() },
      ],
    },
  };
  const target = snapshotTransform(proxy);
  target.position[0] = 5;
  applyEntityTransform(entity, target);
  assert.equal(instanceWorld(pole, 0).elements[12], 5);
  assert.equal(instanceWorld(lens, 0).elements[12], 5);
  assert.equal(instanceWorld(pole, 1).elements[12], 10, 'neighbor instance remains unchanged');
  setEntityVisible(entity, false);
  assert.equal(new THREE.Vector3().setFromMatrixScale(instanceWorld(pole, 0)).length(), 0);
  setEntityVisible(entity, true);
  assert.ok(new THREE.Vector3().setFromMatrixScale(instanceWorld(pole, 0)).length() > 0);
});

test('zero-scale tombstone instances stay finite when a saved project hides them', () => {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 1);
  const source = new THREE.Matrix4().compose(
    new THREE.Vector3(12, 34, 56),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.8),
    new THREE.Vector3(0, 0, 0),
  );
  mesh.setMatrixAt(0, source);
  mesh.updateMatrixWorld(true);

  const proxy = new THREE.Object3D();
  const decomposedNormally = decomposeFiniteMatrix(source, proxy.position, proxy.quaternion, proxy.scale);
  assert.equal(decomposedNormally, false, 'the singular matrix takes the finite fallback');
  assert.ok([...proxy.position.toArray(), ...proxy.quaternion.toArray(), ...proxy.scale.toArray()].every(Number.isFinite));

  const sourceWorldMatrix = instanceWorld(mesh, 0).toArray();
  const entity = {
    object3D: proxy,
    metadata: {
      sourceWorldMatrix,
      instanceComponents: [{ mesh, instanceIndex: 0, sourceWorldMatrix }],
    },
  };
  setEntityVisible(entity, false);
  const hidden = new THREE.Matrix4();
  mesh.getMatrixAt(0, hidden);
  assert.ok(hidden.toArray().every(Number.isFinite), 'hidden instance matrix contains no NaN/Infinity');
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(hidden).toArray(), [12, 34, 56]);
  assert.equal(new THREE.Vector3().setFromMatrixScale(hidden).length(), 0);
});

test('placed objects share asset geometry and project JSON remains declarative', () => {
  const editorGroup = new THREE.Group();
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial(), 1);
  mesh.setMatrixAt(0, new THREE.Matrix4().makeTranslation(3, 4, 5));
  mesh.updateMatrixWorld(true);
  const sourceMatrix = instanceWorld(mesh, 0).toArray();
  const proxy = new THREE.Object3D();
  new THREE.Matrix4().fromArray(sourceMatrix).decompose(proxy.position, proxy.quaternion, proxy.scale);
  const source = {
    id: 'lamp:test:0001', name: 'Test lamp', layer: 'Lamps', assetId: 'hesi:test-lamp', object3D: proxy,
    metadata: { instanceEligible: true, sourceWorldMatrix: sourceMatrix, instanceComponents: [{ mesh, instanceIndex: 0, sourceWorldMatrix: sourceMatrix }] },
  };
  const assets = new AssetRegistry({ editorGroup }).collect([source]);
  const placed = assets.createPlacedEntity(source);
  assert.equal(placed.object3D.children[0].geometry, mesh.geometry, 'geometry is shared by reference');
  assert.equal(placed.object3D.position.x, source.object3D.position.x + 2);
  const state = new WorldProjectState();
  state.addPlaced(assets.recordFor(placed));
  const json = JSON.stringify(state.toJSON());
  assert.match(json, /hesi:test-lamp/);
  assert.doesNotMatch(json, /attributes|vertices|materials|geometry/);
});

test('project state clones override and placed records at its boundary', () => {
  const state = new WorldProjectState();
  const override = { transform: { position: [1, 2, 3] }, visible: false };
  state.replaceOverride('lamp:test', override);
  override.transform.position[0] = 99;
  assert.equal(state.getOverride('lamp:test').transform.position[0], 1);
  state.addPlaced({ id: 'placed:0001', assetId: 'hesi:lamp', transform: { position: [0, 0, 0] } });
  assert.equal(state.toJSON().placedObjects.length, 1);
  state.removePlaced('placed:0001');
  assert.equal(state.toJSON().placedObjects.length, 0);
});

test('removing a placed object also removes its transient entity override', () => {
  const state = new WorldProjectState();
  state.addPlaced({ id: 'placed:0002', assetId: 'hesi:lamp', transform: { position: [0, 0, 0] } });
  state.replaceOverride('placed:0002', { name: 'Edited lamp' });

  state.removePlaced('placed:0002');

  assert.equal(state.getPlaced('placed:0002'), null);
  assert.equal(state.getOverride('placed:0002'), null);
});
