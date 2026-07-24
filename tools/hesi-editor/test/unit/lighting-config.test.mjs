import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  applySceneLighting,
  createRuntimeRoadLightRig,
  createSoftSpotLight,
  localLightConfigFromObject,
  normalizeLocalLight,
  updateRuntimeRoadLightRig,
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

test('scene exposure, ambient fill and direct light are independent controls', () => {
  const scene = new THREE.Scene();
  const ambient = new THREE.HemisphereLight(0xffffff, 0x222222, 2);
  const direct = new THREE.DirectionalLight(0xffffff, 3);
  ambient.userData.gameSceneLight = true;
  direct.userData.gameSceneLight = true;
  scene.add(ambient, direct);

  applySceneLighting(scene, {
    exposure: 1.7,
    intensity: 2,
    ambientIntensity: 0.5,
    directIntensity: 1.5,
  });

  assert.equal(scene.userData.hesiLightingConfig.exposure, 1.7);
  assert.equal(ambient.intensity, 2);
  assert.equal(direct.intensity, 9);

  applySceneLighting(scene, {});
  assert.equal(ambient.intensity, 2);
  assert.equal(direct.intensity, 3);
});

test('street-lamp colour independently retints generated heads and road pools', () => {
  const scene = new THREE.Scene();
  const headMaterial = new THREE.MeshBasicMaterial({ color: 0xff8a2e });
  headMaterial.userData.streetLampLight = 'head';
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), headMaterial));

  const poolMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  poolMaterial.userData.streetLampLight = 'pool';
  const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), poolMaterial, 1);
  pool.setColorAt(0, new THREE.Color(0xff8a2e));
  const shippedPoolColour = Array.from(pool.instanceColor.array);
  scene.add(pool);

  applySceneLighting(scene, { streetLampColor: '#55aaff' });
  assert.equal(headMaterial.color.getHexString(), '55aaff');
  assert.equal(poolMaterial.color.getHexString(), '55aaff');
  assert.equal(pool.instanceColor.getX(0), pool.instanceColor.getY(0));
  assert.equal(pool.instanceColor.getY(0), pool.instanceColor.getZ(0));

  applySceneLighting(scene, {});
  assert.equal(headMaterial.color.getHexString(), 'ff8a2e');
  assert.equal(poolMaterial.color.getHexString(), 'ffffff');
  assert.deepEqual(Array.from(pool.instanceColor.array), shippedPoolColour);
});

test('street-lamp intensity and warmth stay independent from the global light', () => {
  const scene = new THREE.Scene();
  const headMaterial = new THREE.MeshBasicMaterial({ color: 0xff8a2e });
  headMaterial.userData.streetLampLight = 'head';
  const poolMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.24 });
  poolMaterial.userData.streetLampLight = 'pool';
  const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), poolMaterial, 1);
  pool.setColorAt(0, new THREE.Color(0xff8a2e));
  const shippedPoolColour = Array.from(pool.instanceColor.array);
  scene.add(
    new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), headMaterial),
    pool,
  );

  applySceneLighting(scene, {
    intensity: 2.5,
    temperature: -1,
    streetLampIntensity: 0.5,
    streetLampTemperature: 0.6,
  });
  assert.notEqual(headMaterial.color.getHexString(), 'ff8a2e');
  assert.equal(poolMaterial.opacity, 0.12);
  assert.deepEqual(Array.from(pool.instanceColor.array), shippedPoolColour);

  applySceneLighting(scene, {});
  assert.equal(headMaterial.color.getHexString(), 'ff8a2e');
  assert.equal(poolMaterial.opacity, 0.24);
});

test('fixed runtime road lights follow nearby fixtures and survive an ultra-dark world', () => {
  const scene = new THREE.Scene();
  const rig = createRuntimeRoadLightRig({ count: 2 });
  scene.add(rig);
  const sources = [
    { position: new THREE.Vector3(80, 9, 0), color: 0xff8a2e },
    { position: new THREE.Vector3(3, 9, 0), color: 0xff8a2e },
    { position: new THREE.Vector3(-5, 6, 0), color: 0xf3f7e8, intensity: 0.8 },
  ];
  assert.equal(updateRuntimeRoadLightRig(rig, sources, new THREE.Vector3(), { force: true }), true);
  const lights = rig.userData.runtimeRoadLights;
  assert.deepEqual(lights.map((light) => light.position.x).sort((a, b) => a - b), [-5, 3]);

  applySceneLighting(scene, {
    intensity: 1.1,
    ambientIntensity: 0,
    directIntensity: 0,
    tint: '#000000',
    streetLampIntensity: 2,
  });
  assert.deepEqual(lights.map((light) => light.intensity).sort((a, b) => a - b), [288, 360]);
  assert.ok(lights.every((light) => light.isPointLight && light.userData.runtimeRoadLight));
});
