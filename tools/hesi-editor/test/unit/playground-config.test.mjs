import test from 'node:test';
import assert from 'node:assert/strict';
import { blankCustomAssetsDocument, customAssetsDocumentErrors } from '../../../../js/custom-assets.js';
import {
  DEFAULT_CAMERA_TUNING,
  cameraTuningFromDocument,
  normalizeCameraTuning,
  setDocumentCameraTuning,
} from '../../../../js/playground-config.js';

test('playground camera defaults reproduce all three shipped game views', () => {
  const tuning = normalizeCameraTuning();
  assert.deepEqual(tuning, structuredClone(DEFAULT_CAMERA_TUNING));
  assert.equal(tuning.chase.forward, -5.8);
  assert.equal(tuning.hood.forward, 1.65);
  assert.equal(tuning.cockpit.forward, 0.55);
});

test('playground camera values clamp through the shared schema', () => {
  const tuning = normalizeCameraTuning({
    chase: { forward: -99, fov: 500, speedLookAhead: 0.021 },
    hood: { height: 1.4 },
  });
  assert.equal(tuning.chase.forward, -12);
  assert.equal(tuning.chase.fov, 100);
  assert.equal(tuning.chase.speedLookAhead, 0.021);
  assert.equal(tuning.hood.height, 1.4);
  assert.equal(tuning.cockpit.height, DEFAULT_CAMERA_TUNING.cockpit.height);
});

test('camera tuning persists beside Modeler car settings and validates', () => {
  const document = blankCustomAssetsDocument();
  setDocumentCameraTuning(document, { chase: { height: 3.1 } });
  assert.equal(cameraTuningFromDocument(document).chase.height, 3.1);
  assert.deepEqual(customAssetsDocumentErrors(document), []);

  document.runtimeTuning.camera.chase.fov = 999;
  assert.match(customAssetsDocumentErrors(document).join('\n'), /runtimeTuning\.camera\.chase\.fov/);
});
