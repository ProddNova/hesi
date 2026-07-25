import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  CAR_MODEL_GROUPS,
  TRAFFIC_CAR_TYPES,
  carHeadlightSettings,
  carHitboxSettings,
  carModelTarget,
  carRearLightSettings,
  parseCarModelTarget,
  trafficCarDefinition,
  trafficCarPartSpecs,
} from '../../../../js/car-models.js';
import {
  blankCustomAssetsDocument,
  customAssetsDocumentErrors,
} from '../../../../js/custom-assets.js';
import { VehiclePhysics } from '../../../../js/physics.js';
import { TrafficSystem } from '../../../../js/traffic.js';

test('Cars catalogue exposes every PSX player model and all live traffic classes', () => {
  const targets = CAR_MODEL_GROUPS.flatMap((group) => group.cars.map((car) => carModelTarget(car.scope, car.id)));
  const traffic = targets.filter((target) => target.startsWith('traffic:'));
  const player = targets.filter((target) => target.startsWith('player:'));
  assert.equal(traffic.length, 3);
  assert.equal(player.length, 50);
  assert.equal(new Set(targets).size, targets.length);
  for (const target of targets) assert.ok(parseCarModelTarget(target), target);
  assert.equal(parseCarModelTarget('traffic:bus'), null);
  assert.equal(parseCarModelTarget('player:NotInThePack'), null);
});

test('car model document entries validate shape references and traffic behavior', () => {
  const document = blankCustomAssetsDocument();
  const definition = trafficCarDefinition('car', 'custom:traffic-car');
  document.assets[definition.id] = definition;
  document.carModels[carModelTarget('traffic', 'car')] = {
    assetId: definition.id,
    settings: {
      width: 2.05,
      length: 4.8,
      height: 1.5,
      offsetX: 0.12,
      offsetY: -0.08,
      offsetZ: 0.25,
      minSpeedKmh: 80,
      maxSpeedKmh: 145,
      acceleration: 3.2,
      braking: 9,
      weight: 0.65,
      laneBias: 0.4,
      laneSpread: 0.9,
    },
  };
  assert.deepEqual(customAssetsDocumentErrors(document), []);

  const missing = structuredClone(document);
  missing.carModels['traffic:car'].assetId = 'custom:missing';
  assert.ok(customAssetsDocumentErrors(missing).some((error) => error.includes('missing asset')));

  const invalidSpeed = structuredClone(document);
  invalidSpeed.carModels['traffic:car'].settings.minSpeedKmh = 180;
  invalidSpeed.carModels['traffic:car'].settings.maxSpeedKmh = 100;
  assert.ok(customAssetsDocumentErrors(invalidSpeed).some((error) => error.includes('cannot exceed')));
});

test('player cars accept per-model hitboxes plus complete front/rear light controls', () => {
  const document = blankCustomAssetsDocument();
  const target = CAR_MODEL_GROUPS.find((group) => group.group === 'Player cars').cars[0];
  const key = carModelTarget(target.scope, target.id);
  document.carModels[key] = {
    settings: {
      width: 1.92,
      length: 4.62,
      height: 1.36,
      offsetX: 0.14,
      offsetY: -0.06,
      offsetZ: 0.22,
    },
    headlights: {
      enabled: true,
      color: '#dcecff',
      width: 0.28,
      height: 0.14,
      depth: 0.06,
      spacing: 1.16,
      elevation: 0.68,
      inset: 0.08,
      offsetX: 0.03,
      offsetY: -0.02,
      offsetZ: -0.06,
      temperature: 0.18,
      intensity: 2200,
      range: 58,
      radius: 24,
      softness: 0.82,
      decay: 1.7,
      irregularity: 0.64,
      seed: 42,
      aimX: 0.2,
      aimY: 0.05,
      aimDistance: 36,
    },
    rearLights: {
      enabled: true,
      color: '#ff002a',
      width: 0.3,
      height: 0.16,
      depth: 0.07,
      spacing: 1.24,
      elevation: 0.7,
      inset: 0.05,
      offsetX: -0.08,
      offsetY: 0.04,
      offsetZ: 0.11,
    },
  };
  assert.deepEqual(customAssetsDocumentErrors(document), []);
  assert.deepEqual(carHitboxSettings(key, document), {
    width: 1.92,
    length: 4.62,
    height: 1.36,
    offsetX: 0.14,
    offsetY: -0.06,
    offsetZ: 0.22,
  });
  assert.deepEqual(
    (({ color, intensity, range, radius, offsetX, aimX, aimDistance }) => (
      { color, intensity, range, radius, offsetX, aimX, aimDistance }
    ))(carHeadlightSettings(key, document)),
    {
      color: '#dcecff',
      intensity: 2200,
      range: 58,
      radius: 24,
      offsetX: 0.03,
      aimX: 0.2,
      aimDistance: 36,
    },
  );
  assert.deepEqual(
    (({ color, offsetX, offsetY, offsetZ }) => ({ color, offsetX, offsetY, offsetZ }))(
      carRearLightSettings(key, document),
    ),
    { color: '#ff002a', offsetX: -0.08, offsetY: 0.04, offsetZ: 0.11 },
  );

  const invalid = structuredClone(document);
  invalid.carModels[key].headlights.intensity = 9999;
  assert.ok(customAssetsDocumentErrors(invalid).some((error) => error.includes('headlights.intensity')));
  invalid.carModels[key].headlights.intensity = 2200;
  invalid.carModels[key].headlights.seed = 4.2;
  assert.ok(customAssetsDocumentErrors(invalid).some((error) => error.includes('headlights.seed')));
  invalid.carModels[key].headlights.seed = 42;
  invalid.carModels[key].rearLights.width = 99;
  assert.ok(customAssetsDocumentErrors(invalid).some((error) => error.includes('rearLights.width')));
  invalid.carModels[key].rearLights.width = 0.3;
  invalid.carModels[key].settings.offsetX = 99;
  assert.ok(customAssetsDocumentErrors(invalid).some((error) => error.includes('settings.offsetX')));
});

test('traffic Modeler definitions are the exact boxes used by live traffic', () => {
  const expectedBodyColors = { car: '#b9c0c9', van: '#e6e8ea', truck: '#4a6274' };
  for (const type of TRAFFIC_CAR_TYPES) {
    const specs = trafficCarPartSpecs(type);
    const definition = trafficCarDefinition(type, `custom:${type.id}`);
    assert.equal(specs.length, 7);
    assert.deepEqual(
      definition.parts.map(({ name, scale, position, color, vehicleRole }) => ({
        name, scale, position, color, role: vehicleRole,
      })),
      specs,
    );
    assert.deepEqual(specs[0].scale, [type.width, type.height, type.length]);
    assert.deepEqual(specs[0].position, [0, type.height * 0.5, 0]);
    assert.equal(specs[0].color, expectedBodyColors[type.id]);
    assert.equal(specs.some((part) => part.name.includes('Wheel')), false);
    assert.equal(specs.some((part) => part.name.includes('Windscreen')), false);
  }
});

test('traffic Modeler overrides rebuild vehicles that are already active', () => {
  const scene = new THREE.Scene();
  const traffic = new TrafficSystem(scene, null, { maxVehicles: 2, count: 0 });
  const vehicle = traffic.pool[0];
  vehicle.active = true;
  vehicle.mesh.visible = true;
  traffic.active.push(vehicle);

  const document = blankCustomAssetsDocument();
  document.assets['custom:traffic-live'] = {
    id: 'custom:traffic-live',
    label: 'Live traffic shape',
    layer: 'Vehicles',
    parts: [{
      kind: 'box',
      name: 'Body',
      position: [0, 0.8, 0],
      rotation: [0, 0, 0],
      scale: [2.1, 1.6, 5],
      color: '#ff3366',
      faces: {},
      vehicleRole: 'body',
    }],
  };
  document.carModels['traffic:car'] = {
    assetId: 'custom:traffic-live',
    settings: {
      width: 2.1,
      length: 5,
      height: 1.6,
      offsetX: 0.2,
      offsetY: 0.1,
      offsetZ: -0.35,
      minSpeedKmh: 90,
      maxSpeedKmh: 150,
    },
  };

  const result = traffic.applyModelOverrides(document);
  assert.deepEqual(result, { models: 1, settings: 1, active: 1 });
  assert.equal(vehicle.width, 2.1);
  assert.equal(vehicle.length, 5);
  assert.equal(vehicle.offsetX, 0.2);
  assert.equal(vehicle.offsetY, 0.1);
  assert.equal(vehicle.offsetZ, -0.35);
  assert.equal(vehicle.mesh.userData.body.visible, false);
  assert.equal(vehicle.mesh.userData.customModelType, 'car');
  assert.ok(vehicle.mesh.userData.customModel?.children.length);
  let customBody = null;
  vehicle.mesh.userData.customModel.traverse((part) => {
    if (!customBody && part.userData?.hesiTrafficPartRole === 'body') customBody = part;
  });
  const customBodyMaterials = Array.isArray(customBody?.material)
    ? customBody.material
    : [customBody?.material];
  assert.ok(customBodyMaterials.every((material) => material?.emissive));
  assert.ok(customBodyMaterials.every((material) => material.emissive.getHex() === 0x000000));

  traffic.applyModelOverrides(blankCustomAssetsDocument());
  assert.equal(vehicle.width, TRAFFIC_CAR_TYPES[0].width);
  assert.equal(vehicle.mesh.userData.body.visible, true);
  assert.equal(vehicle.mesh.userData.customModel, null);
  traffic.dispose();
});

test('hitbox offsets move wall sweeps and traffic contact centers', () => {
  const physics = new VehiclePhysics({
    width: 1.8,
    length: 4.4,
    height: 1.4,
    collisionOffsetX: 1,
    collisionOffsetY: 0.5,
    collisionOffsetZ: 2,
  });
  let sweep = null;
  physics._resolveRoadBounds({
    sweep: (from, to) => {
      sweep = { from: from.toArray(), to: to.toArray() };
      return null;
    },
  }, new THREE.Vector3(10, 2, 20), new THREE.Vector3(11, 2, 21));
  assert.deepEqual(sweep, {
    from: [11, 2.5, 22],
    to: [12, 2.5, 23],
  });
  assert.equal(physics.getState().collisionOffsetZ, 2);

  const traffic = new TrafficSystem(new THREE.Scene(), null, { maxVehicles: 1, count: 0 });
  const document = blankCustomAssetsDocument();
  document.carModels['traffic:car'] = { settings: { offsetX: 5 } };
  traffic.applyModelOverrides(document);
  const vehicle = traffic.pool[0];
  vehicle.active = true;
  vehicle.spawnGrace = 0;
  vehicle.position.set(0, 0, 0);
  vehicle.previousPosition.set(0, 0, 0);
  traffic.active.push(vehicle);
  const player = traffic._normalizePlayer({
    position: new THREE.Vector3(),
    previousPosition: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    heading: 0,
    width: 1.8,
    length: 4.4,
    height: 1.4,
  });
  traffic._events = [];
  traffic._checkPlayerInteraction(vehicle, player, null);
  assert.equal(traffic._events.length, 0, 'offset traffic hitbox no longer overlaps the player');
  vehicle.offsetX = 0;
  traffic._checkPlayerInteraction(vehicle, player, null);
  assert.equal(traffic._events.length, 1, 'centred hitbox overlaps the player');
  traffic.dispose();
});

test('traffic configured lights stay unlit and retain live braking over custom bodies', () => {
  const traffic = new TrafficSystem(new THREE.Scene(), null, { maxVehicles: 1, count: 0 });
  const vehicle = traffic.pool[0];
  vehicle.active = true;
  vehicle.mesh.visible = true;
  traffic.active.push(vehicle);

  const document = blankCustomAssetsDocument();
  const definition = trafficCarDefinition('car', 'custom:exact-traffic-car');
  document.assets[definition.id] = definition;
  document.carModels['traffic:car'] = { assetId: definition.id };
  traffic.applyModelOverrides(document);

  const ud = vehicle.mesh.userData;
  assert.equal(ud.body.visible, false);
  assert.equal(ud.lamps.visible, true);
  assert.ok(ud.lamps.material.isMeshBasicMaterial);
  assert.equal(ud.generatedTaillamps[0].visible, true);
  assert.equal(ud.taillamps.length, 1);
  assert.ok(ud.taillamps[0].material.isMeshBasicMaterial);
  assert.equal(ud.taillamps[0].material.toneMapped, false);
  const customTailParts = [];
  const customHeadParts = [];
  ud.customModel.traverse((part) => {
    if (part.userData?.hesiTrafficPartRole === 'taillamp') customTailParts.push(part);
    if (part.userData?.hesiTrafficPartRole === 'headlamp') customHeadParts.push(part);
  });
  assert.ok(customTailParts.length >= 2);
  assert.ok(customTailParts.every((part) => part.visible === false));
  assert.ok(customHeadParts.length >= 2);
  assert.ok(customHeadParts.every((part) => part.visible === false));
  assert.ok(ud.indicators.every((indicator) => (
    indicator.meshes.every((mesh) => mesh.userData.hesiTrafficPartRole?.startsWith('indicator-'))
  )));

  const customTailMaterial = ud.taillamps[0].material;
  traffic._setLights(vehicle, true);
  assert.notEqual(ud.taillamps[0].material, customTailMaterial);
  traffic._setLights(vehicle, false);
  assert.equal(ud.taillamps[0].material, customTailMaterial);

  vehicle.indicator = -1;
  traffic.time = 0;
  traffic._setLights(vehicle, false);
  assert.ok(ud.indicators[0].meshes.every((mesh) => mesh.visible));
  assert.ok(ud.indicators[1].meshes.every((mesh) => !mesh.visible));
  traffic.dispose();
});
