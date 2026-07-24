import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSkyboxConfig, skyboxConfigErrors } from '../../../../js/skybox-config.js';
import { CommandHistory } from '../../src/interaction/command-history.js';
import { WorldProjectState } from '../../src/overrides/world-project-state.js';
import { SkyboxController } from '../../src/world/skybox-controller.js';

test('skybox config normalizes editable values and validates texture references', () => {
  const config = normalizeSkyboxConfig({
    enabled: true,
    texture: 'tex:0042',
    rotation: [0.1, 0.2, 0.3],
    offset: [8, -8],
    zoom: 20,
    intensity: 0,
    flipX: true,
  });
  assert.deepEqual(config.offset, [1, -1]);
  assert.equal(config.zoom, 4);
  assert.equal(config.intensity, 0);
  assert.deepEqual(skyboxConfigErrors(config, { textureIds: new Set(['tex:0042']) }), []);
  assert.match(skyboxConfigErrors(config, { textureIds: new Set() }).join('\n'), /missing texture tex:0042/);
});

test('skybox controller previews project state and makes edits undoable', () => {
  const calls = [];
  const projectState = new WorldProjectState();
  const history = new CommandHistory();
  const store = {
    getTexture: (id) => id === 'tex:0001' ? { name: 'night.jpg', dataUrl: 'data:image/jpeg;base64,AA==' } : null,
    texturesById: () => ({ 'tex:0001': { name: 'night.jpg', dataUrl: 'data:image/jpeg;base64,AA==' } }),
  };
  const controller = new SkyboxController({
    viewport: { setSkybox: (config) => calls.push(config) },
    projectState,
    history,
    store,
  });

  controller.setTexture('tex:0001');
  controller.update({ rotation: [0, 1.25, 0], zoom: 1.5 }, 'Move skybox');
  assert.equal(projectState.getSkybox().texture, 'tex:0001');
  assert.deepEqual(projectState.getSkybox().rotation, [0, 1.25, 0]);
  assert.equal(projectState.getSkybox().zoom, 1.5);
  assert.equal(calls.at(-1).enabled, true);
  assert.equal(history.dirty, true);

  history.undo();
  assert.deepEqual(projectState.getSkybox().rotation, [0, 0, 0]);
  controller.dispose();
});
