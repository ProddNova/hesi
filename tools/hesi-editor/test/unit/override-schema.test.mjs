import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProjectValidationError,
  blankProjectDocument,
  parseProjectDocument,
  serializeProjectDocument,
  validateProjectDocument,
} from '../../src/overrides/override-schema.js';
import { toInternalTransform, toPersistedTransform } from '../../src/overrides/project-persistence.js';

test('project serialization is deterministic, key-sorted, rounded, and geometry-free', () => {
  const document = blankProjectDocument('Round trip');
  document.entityOverrides['lamp:z:0002'] = { visible: false };
  document.entityOverrides['lamp:a:0001'] = {
    transform: { position: [1.123456789, -0, 3], rotation: [0, Math.PI / 2, 0], scale: [1, 1, 1] },
  };
  document.placedObjects.push({
    id: 'placed:0002', assetId: 'hesi:lamp', layer: 'Lamps',
    transform: { position: [4, 5, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
  });
  const first = serializeProjectDocument(document);
  const second = serializeProjectDocument(parseProjectDocument(first));
  assert.equal(first, second);
  assert.ok(first.indexOf('lamp:a:0001') < first.indexOf('lamp:z:0002'));
  assert.match(first, /1\.12346/);
  assert.doesNotMatch(first, /geometry|vertices|attributes|materials/);
});

test('schema rejects non-finite transforms, duplicate placed IDs, and unknown references', () => {
  const document = blankProjectDocument();
  document.entityOverrides['lamp:missing'] = {
    transform: { position: [Infinity, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
  document.placedObjects = [
    { id: 'placed:1', assetId: 'asset:missing', layer: 'Lamps', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
    { id: 'placed:1', assetId: 'asset:missing', layer: 'Lamps', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
  ];
  assert.throws(() => validateProjectDocument(document, { entityIds: new Set(['lamp:known']), assetIds: new Set(['asset:known']) }), (error) => {
    assert.ok(error instanceof ProjectValidationError);
    assert.match(error.message, /finite|unknown entity ID|unknown asset ID|duplicate placed object ID/);
    return true;
  });
});

test('persisted Euler transforms round-trip through internal quaternions', () => {
  const persisted = { position: [1, 2, 3], rotation: [0.2, -0.6, 1.1], scale: [1, 2, 1] };
  const roundTrip = toPersistedTransform(toInternalTransform(persisted));
  persisted.position.forEach((value, index) => assert.ok(Math.abs(value - roundTrip.position[index]) < 1e-8));
  persisted.rotation.forEach((value, index) => assert.ok(Math.abs(value - roundTrip.rotation[index]) < 1e-8));
  assert.deepEqual(roundTrip.scale, persisted.scale);
});

test('project schema persists per-face texture styles and checks texture references', () => {
  const document = blankProjectDocument('Textures');
  document.entityOverrides.wall = {
    faceTextures: { '0:4': { texture: 'tex:0001', fit: 'cover', flipX: true } },
  };
  assert.equal(validateProjectDocument(document, {
    entityIds: new Set(['wall']), textureIds: new Set(['tex:0001']),
  }), true);
  const serialized = serializeProjectDocument(document);
  assert.match(serialized, /"faceTextures"/);
  assert.match(serialized, /"fit": "cover"/);
  assert.throws(() => validateProjectDocument(document, {
    entityIds: new Set(['wall']), textureIds: new Set(['tex:9999']),
  }), /missing texture/);
});

test('project schema persists a photographic skybox and validates its image reference', () => {
  const document = blankProjectDocument('Skybox');
  document.environment.skybox = {
    enabled: true,
    texture: 'tex:0042',
    rotation: [0.1, 0.2, 0],
    offset: [0.25, -0.1],
    zoom: 1.4,
    intensity: 0.8,
    flipX: false,
  };
  assert.equal(validateProjectDocument(document, { textureIds: new Set(['tex:0042']) }), true);
  const serialized = serializeProjectDocument(document);
  assert.match(serialized, /"environment"/);
  assert.match(serialized, /"texture": "tex:0042"/);
  assert.throws(() => validateProjectDocument(document, { textureIds: new Set() }), /missing texture tex:0042/);
});

test('project serialization keeps master lighting and world finish settings', () => {
  const document = blankProjectDocument('Lighting persistence');
  document.environment.lighting = {
    intensity: 1.65,
    temperature: -0.4,
    tint: '#ffd2aa',
  };
  document.environment.surfaceGloss = 1.75;
  const parsed = parseProjectDocument(serializeProjectDocument(document));
  assert.deepEqual(parsed.environment.lighting, {
    intensity: 1.65,
    temperature: -0.4,
    tint: '#ffd2aa',
  });
  assert.equal(parsed.environment.surfaceGloss, 1.75);
});

test('project schema round-trips placed soft-light controls', () => {
  const document = blankProjectDocument('Local lights');
  document.placedObjects.push({
    id: 'placed:0001',
    name: 'Garage work light',
    assetId: 'editor:light:soft-spot',
    layer: 'Lighting',
    transform: { position: [2, 7, -3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    light: {
      color: '#ffd3a1',
      temperature: -0.28,
      intensity: 725,
      range: 13,
      radius: 5.5,
      softness: 0.82,
      decay: 1.9,
      irregularity: 0.7,
      seed: 17,
    },
  });
  const parsed = parseProjectDocument(serializeProjectDocument(document));
  assert.deepEqual(parsed.placedObjects[0].light, document.placedObjects[0].light);
  delete document.placedObjects[0].light;
  assert.throws(() => validateProjectDocument(document), /light is required/);
});
