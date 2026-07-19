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
