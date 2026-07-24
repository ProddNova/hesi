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
      faceTextures: { '0:0': { texture: 'tex:0001', fit: 'cover', flipY: true } },
    }],
  };
  assert.equal(validateBuildDocument(build), true);
  build.operations[0].faceTextures['bad-slot'] = { texture: 'nope' };
  assert.throws(() => validateBuildDocument(build), BuildValidationError);
});

test('build schema carries validated skybox environment settings', () => {
  const build = {
    version: 1,
    scene: 'highway',
    generatedAt: new Date(0).toISOString(),
    project: { name: 'Night panorama', path: 'data/editor/hesi-world-project.json' },
    environment: {
      skybox: {
        enabled: true, texture: 'tex:0007', rotation: [0, 1, 0], offset: [0, 0],
        zoom: 1, intensity: 1.2, flipX: false,
      },
    },
    operations: [],
  };
  assert.equal(validateBuildDocument(build), true);
  build.environment.skybox.zoom = 99;
  assert.throws(() => validateBuildDocument(build), BuildValidationError);
});

test('build schema validates a persisted cloudy local light', () => {
  const build = {
    version: 1,
    scene: 'garage',
    generatedAt: new Date(0).toISOString(),
    project: { name: 'Garage lights', path: 'data/editor/garage-project.json' },
    environment: {},
    operations: [{
      op: 'place-light',
      name: 'Workbench glow',
      position: [3, 7, -2],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      visible: true,
      light: {
        color: '#ffd0a0',
        temperature: -0.45,
        intensity: 800,
        range: 14,
        radius: 6,
        softness: 0.82,
        decay: 1.8,
        irregularity: 0.72,
        seed: 23,
      },
    }],
  };
  assert.equal(validateBuildDocument(build), true);
  build.operations[0].light.irregularity = 0;
  assert.throws(() => validateBuildDocument(build), /irregularity/);
});
