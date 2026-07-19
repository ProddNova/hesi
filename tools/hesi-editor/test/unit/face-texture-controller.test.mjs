import test from 'node:test';
import assert from 'node:assert/strict';
import { FaceTextureController } from '../../src/interaction/face-texture-controller.js';

test('face assignment persists a dirty texture library before creating its project reference', async () => {
  const events = [];
  const store = {
    dirty: true,
    getTexture: (id) => id === 'tex:0023' ? { dataUrl: 'data:image/png;base64,AA==' } : null,
    save: async () => { events.push('save-library'); store.dirty = false; },
  };
  const controller = new FaceTextureController({ store });
  controller.setStyle = (_entity, slotKey, patch) => {
    events.push(`set-project:${slotKey}:${patch.texture}`);
    return true;
  };

  assert.equal(await controller.assignTexture({}, '0:0', 'tex:0023'), true);
  assert.deepEqual(events, ['save-library', 'set-project:0:0:tex:0023']);
});

test('face assignment refuses an ID absent from the shared texture library', async () => {
  const controller = new FaceTextureController({
    store: { dirty: false, getTexture: () => null },
  });
  await assert.rejects(() => controller.assignTexture({}, '0:0', 'tex:9999'), /no longer in the shared library/);
});
