import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityRegistry, EDITOR_LAYERS } from '../../src/entity-registry.js';

function makeEntity(id, layer = 'Roads') {
  return {
    id,
    type: 'fixture',
    layer,
    name: `Entity ${id}`,
    object3D: { visible: true },
    editable: false,
    source: 'test',
  };
}

test('registers, retrieves, and lists entities by stable id and layer', () => {
  const registry = createEntityRegistry();
  const entity = registry.register(makeEntity('roads:test'));
  assert.equal(registry.getById('roads:test'), entity);
  assert.deepEqual(registry.listByLayer('Roads'), [entity]);
  assert.equal(registry.getById('missing'), null);
  assert.throws(() => registry.register(makeEntity('roads:test')), /Duplicate entity id/);
});

test('declares all checkpoint layers even when empty', () => {
  const registry = createEntityRegistry();
  assert.deepEqual(registry.layers().map((layer) => layer.name), [...EDITOR_LAYERS]);
  assert.ok(registry.layers().every((layer) => layer.count === 0));
});

test('layer visibility affects loaded objects and clear restores original visibility', () => {
  const registry = createEntityRegistry();
  const roads = makeEntity('roads:test');
  const props = makeEntity('props:test', 'Props');
  props.object3D.visible = false;
  registry.register(roads);
  registry.register(props);
  registry.setLayerVisibility('Roads', false);
  assert.equal(roads.object3D.visible, false);
  assert.equal(props.object3D.visible, true, 'registration follows current visible layer state');
  assert.equal(registry.toggleLayerVisibility('Roads'), true);
  assert.equal(roads.object3D.visible, true);
  registry.clear();
  assert.equal(roads.object3D.visible, true);
  assert.equal(props.object3D.visible, false);
  assert.equal(registry.list().length, 0);
});
