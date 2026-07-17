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
