import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BuildValidationError,
  buildDraftSignature,
  validateBuildDocument,
} from '../../src/overrides/build-schema.js';

test('draft signatures are deterministic across key order and rounded persisted values', () => {
  const first = { project: { name: 'Draft' }, values: { z: 2, a: 1.1234561 } };
  const reordered = { values: { a: 1.1234564, z: 2 }, project: { name: 'Draft' } };
  assert.equal(buildDraftSignature(first), buildDraftSignature(reordered));
  assert.match(buildDraftSignature(first), /^fnv1a32:[0-9a-f]{8}$/);
  assert.notEqual(buildDraftSignature(first), buildDraftSignature({ ...first, values: { z: 3, a: 1.1234561 } }));
});

test('build schema accepts valid draft fingerprints and rejects malformed ones', () => {
  const build = {
    version: 1,
    scene: 'highway',
    generatedAt: new Date(0).toISOString(),
    project: {
      name: 'Draft',
      path: 'data/editor/hesi-world-project.json',
      draftSignature: buildDraftSignature({ project: { name: 'Draft' } }),
    },
    operations: [],
  };
  assert.equal(validateBuildDocument(build), true);
  build.project.draftSignature = 'not-a-signature';
  assert.throws(() => validateBuildDocument(build), BuildValidationError);
});

test('build operations validate persisted face texture styles', () => {
  const build = {
    version: 1,
    scene: 'garage',
    generatedAt: new Date(0).toISOString(),
    project: { name: 'Garage textures', path: 'data/editor/garage-project.json' },
    operations: [{
      op: 'garage-object', childIndex: 0,
      position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], visible: true,
      faceTextures: { '0:0': { texture: 'tex:0001', fit: 'cover', flipY: true, zoom: 3, pan: [-0.5, 1] } },
    }],
  };
  assert.equal(validateBuildDocument(build), true);
  build.operations[0].faceTextures['0:0'].zoom = 40;
  assert.throws(() => validateBuildDocument(build), BuildValidationError);
  build.operations[0].faceTextures['0:0'].zoom = 3;
  build.operations[0].faceTextures['0:0'].pan = [0, 1.5];
  assert.throws(() => validateBuildDocument(build), BuildValidationError);
  build.operations[0].faceTextures['0:0'].pan = [-0.5, 1];
  build.operations[0].faceTextures['bad-slot'] = { texture: 'nope' };
  assert.throws(() => validateBuildDocument(build), BuildValidationError);
});
