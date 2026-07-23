import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { applyGarageBuild } from '../../../../js/editor-map-patch.js';

function garageObject(childIndex, position, { visible = true, quaternion = [0, 0, 0, 1] } = {}) {
  return {
    op: 'garage-object',
    childIndex,
    position,
    quaternion,
    scale: [1, 1, 1],
    visible,
  };
}

test('garage builds mirror the editable parked car transform to the runtime PSXStyle anchor', () => {
  const root = new THREE.Group();
  const editableCar = new THREE.Group();
  const runtimeCar = new THREE.Group();
  editableCar.userData.editorBuildMirror = 'garage-showroom-car';
  runtimeCar.userData.editorBuildMirror = 'garage-showroom-car';
  runtimeCar.userData.editorBuildQuaternionOffset = [0, -1, 0, 0];
  root.add(editableCar, runtimeCar);
  const editorHeading = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));

  const summary = applyGarageBuild(root, {
    operations: [garageObject(0, [-0.83, 0.05, 0], {
      visible: false,
      quaternion: editorHeading.toArray(),
    })],
  });

  assert.deepEqual(summary, { applied: 1, skipped: 0 });
  assert.deepEqual(editableCar.position.toArray(), [-0.83, 0.05, 0]);
  assert.deepEqual(runtimeCar.position.toArray(), [-0.83, 0.05, 0]);
  assert.equal(editableCar.visible, false);
  assert.equal(runtimeCar.visible, false);
  assert.ok(editableCar.quaternion.angleTo(editorHeading) < 1e-8);
  assert.ok(runtimeCar.quaternion.angleTo(
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0)),
  ) < 1e-8);
});

test('garage builds mark edited follower anchors so runtime refreshes preserve them', () => {
  const root = new THREE.Group();
  const marker = new THREE.Group();
  marker.userData.editorAnchorFollower = 'garage-market';
  root.add(marker);

  applyGarageBuild(root, {
    operations: [garageObject(0, [1.25, -0.38, -0.68])],
  });

  assert.deepEqual(marker.position.toArray(), [1.25, -0.38, -0.68]);
  assert.equal(marker.userData.editorBuildTransformApplied, true);
});
