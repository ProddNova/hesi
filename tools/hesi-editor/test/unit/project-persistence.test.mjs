import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectPersistence } from '../../src/overrides/project-persistence.js';

function fixture(customAssetStore, options = {}) {
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
    ...options,
  });
}

function withBrowserStorage(values, run) {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const entries = new Map(Object.entries(values));
  globalThis.window = { location: { search: '' } };
  globalThis.localStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
  };
  try { return run(entries); }
  finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocalStorage;
  }
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

test('loading drops overrides for generated entities removed by a world rebuild', () => {
  const persistence = fixture({ texturesById: () => ({ 'tex:0023': { dataUrl: 'data:image/png;base64,AA==' } }) });
  const source = {
    version: 1,
    project: { name: 'Rebuilt road' },
    entityOverrides: {
      'garage-part:0001': { visible: false },
      'barrier:removed-route:0003': { visible: false },
    },
    placedObjects: [],
    groups: [],
    environment: {},
    editorState: {},
  };
  const prepared = persistence.prepareLoadedDocument(source);
  assert.deepEqual(prepared.staleEntityIds, ['barrier:removed-route:0003']);
  assert.deepEqual(Object.keys(prepared.document.entityOverrides), ['garage-part:0001']);
  assert.ok(source.entityOverrides['barrier:removed-route:0003'], 'the server response is not mutated');
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

test('real mode repairs a demo project remembered by older editor versions', () => {
  withBrowserStorage({
    'hesi-editor:current-project': 'data/editor/demo-highway-project.json',
  }, () => {
    const persistence = fixture({ texturesById: () => ({}) });
    assert.equal(persistence.initialPath(), 'data/editor/hesi-world-project.json');
  });
});

test('demo and real modes remember their current projects independently', () => {
  withBrowserStorage({}, (entries) => {
    const real = fixture({ texturesById: () => ({}) });
    const demo = fixture({ texturesById: () => ({}) }, { storageScope: 'demo' });
    real.remember('data/editor/hesi-world-project.json');
    demo.remember('data/editor/demo-highway-project.json');
    assert.equal(entries.get('hesi-editor:current-project'), 'data/editor/hesi-world-project.json');
    assert.equal(entries.get('hesi-editor:current-project:demo'), 'data/editor/demo-highway-project.json');
  });
});
