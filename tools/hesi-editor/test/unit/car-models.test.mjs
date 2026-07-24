import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  CAR_MODEL_GROUPS,
  TRAFFIC_CAR_TYPES,
  carModelTarget,
  parseCarModelTarget,
  trafficCarDefinition,
  trafficCarPartSpecs,
} from '../../../../js/car-models.js';
import {
  blankCustomAssetsDocument,
  customAssetsDocumentErrors,
} from '../../../../js/custom-assets.js';
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
    settings: { width: 2.1, length: 5, height: 1.6, minSpeedKmh: 90, maxSpeedKmh: 150 },
  };

  const result = traffic.applyModelOverrides(document);
  assert.deepEqual(result, { models: 1, settings: 1, active: 1 });
  assert.equal(vehicle.width, 2.1);
  assert.equal(vehicle.length, 5);
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

test('editable traffic lamps replace generated lamps and retain live behavior', () => {
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
  assert.equal(ud.lamps.visible, false);
  assert.equal(ud.generatedTaillamps[0].visible, false);
  assert.equal(ud.taillamps.length, 2);
  assert.ok(ud.taillamps.every((lamp) => lamp.userData.hesiTrafficPartRole === 'taillamp'));
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
