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

test('garage builds move the shared runtime PSXStyle anchor directly', () => {
  const root = new THREE.Group();
  const legacyCarAnchor = new THREE.Group();
  const runtimeCar = new THREE.Group();
  root.add(legacyCarAnchor, runtimeCar);
  const editorHeading = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0));

  const summary = applyGarageBuild(root, {
    operations: [garageObject(1, [1.2, 0.05, -0.4], {
      quaternion: editorHeading.toArray(),
    })],
  });

  assert.deepEqual(summary, { applied: 1, skipped: 0 });
  assert.deepEqual(legacyCarAnchor.position.toArray(), [0, 0, 0]);
  assert.deepEqual(runtimeCar.position.toArray(), [1.2, 0.05, -0.4]);
  assert.equal(runtimeCar.visible, true);
  assert.ok(runtimeCar.quaternion.angleTo(editorHeading) < 1e-8);
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

test('garage builds recreate authored cloudy spot lights', () => {
  const root = new THREE.Group();
  const summary = applyGarageBuild(root, {
    operations: [{
      op: 'place-light',
      name: 'Workbench light',
      position: [3, 7, -2],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      visible: true,
      light: {
        color: '#ffd0a0',
        temperature: -0.4,
        intensity: 850,
        range: 15,
        radius: 6,
        softness: 0.8,
        decay: 1.9,
        irregularity: 0.75,
        seed: 8,
      },
    }],
  });
  assert.deepEqual(summary, { applied: 1, skipped: 0 });
  const placed = root.getObjectByName('Workbench light');
  assert.ok(placed);
  assert.deepEqual(placed.position.toArray(), [3, 7, -2]);
  assert.equal(placed.userData.localLightObject.intensity, 850);
  assert.ok(placed.userData.localLightObject.map?.isDataTexture);
});
