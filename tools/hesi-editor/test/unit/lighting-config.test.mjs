import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applySceneLighting,
  createSoftSpotLight,
  localLightConfigFromObject,
  normalizeLocalLight,
} from '../../../../js/lighting-config.js';

test('soft local light turns reach and pool radius into an aimable cloudy spot', () => {
  const config = normalizeLocalLight({
    color: '#ffc080',
    temperature: -0.5,
    intensity: 900,
    range: 18,
    radius: 7,
    softness: 0.84,
    decay: 2,
    irregularity: 0.8,
    seed: 41,
  });
  const root = createSoftSpotLight(config, { editor: true });
  const light = root.userData.localLightObject;
  assert.ok(light?.isSpotLight);
  assert.ok(light.map?.isDataTexture, 'cloud cookie is attached to the spot light');
  assert.equal(light.distance, 18);
  assert.equal(light.intensity, 900);
  assert.equal(light.penumbra, 0.84);
  assert.ok(Math.abs(light.angle - Math.atan2(7, 18)) < 1e-10);
  assert.deepEqual(localLightConfigFromObject(root), config);
  assert.ok(root.userData.localLightCone, 'editor range helper is present');
});

test('master world lighting multiplies an authored local-light baseline reversibly', () => {
  const scene = new THREE.Scene();
  const root = createSoftSpotLight({ intensity: 600, color: '#ffd3a1' });
  scene.add(root);
  const light = root.userData.localLightObject;
  const baseColor = light.color.getHex();
  applySceneLighting(scene, { intensity: 0.5, temperature: 0.4, tint: '#ffffff' });
  assert.equal(light.intensity, 300);
  assert.notEqual(light.color.getHex(), baseColor);
  applySceneLighting(scene, { intensity: 1, temperature: 0, tint: '#ffffff' });
  assert.equal(light.intensity, 600);
  assert.equal(light.color.getHex(), baseColor);
});
