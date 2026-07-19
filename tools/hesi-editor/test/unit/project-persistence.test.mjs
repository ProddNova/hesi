import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectPersistence } from '../../src/overrides/project-persistence.js';

function fixture(customAssetStore) {
  const projectState = {
    toJSON: () => ({
      version: 1,
      project: { name: 'Garage textures' },
      entityOverrides: {
        'garage-part:0001': {
          faceTextures: { '0:0': { texture: 'tex:0023', fit: 'cover' } },
        },
      },
      placedObjects: [],
      groups: [],
      editorState: {},
    }),
  };
  return new ProjectPersistence({
    projectState,
    registry: { list: () => [{ id: 'garage-part:0001', generated: true }] },
    assetRegistry: { ids: () => [] },
    customAssetStore,
  });
}

test('project persistence validates face textures against the injected shared library', () => {
  const persistence = fixture({ texturesById: () => ({ 'tex:0023': { dataUrl: 'data:image/png;base64,AA==' } }) });
  assert.ok(persistence.validationOptions().textureIds.has('tex:0023'));
  assert.doesNotThrow(() => persistence.toPersistedDocument());
});

test('project persistence still rejects a genuinely orphaned face texture', () => {
  const persistence = fixture({ texturesById: () => ({}) });
  assert.throws(
    () => persistence.toPersistedDocument(),
    /faceTextures\.0:0\.texture references missing texture tex:0023/,
  );
});

test('project save writes a dirty shared texture library before its referencing document', async () => {
  const events = [];
  const store = {
    dirty: true,
    texturesById: () => ({ 'tex:0023': { dataUrl: 'data:image/png;base64,AA==' } }),
    save: async () => { events.push('save-library'); store.dirty = false; },
  };
  const persistence = fixture(store);
  const originalDocument = persistence.toPersistedDocument.bind(persistence);
  persistence.toPersistedDocument = () => { events.push('validate-project'); return originalDocument(); };
  persistence.write = async () => { events.push('write-project'); return { ok: true }; };

  await persistence.save({ markSaved: false, build: false });
  assert.deepEqual(events, ['save-library', 'validate-project', 'write-project']);
});
