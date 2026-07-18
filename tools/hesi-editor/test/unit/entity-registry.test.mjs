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
  assert.equal(props.object3D.visible, false, 'registration preserves generator-owned visibility');
  assert.equal(registry.toggleLayerVisibility('Roads'), true);
  assert.equal(roads.object3D.visible, true);
  registry.clear();
  assert.equal(roads.object3D.visible, true);
  assert.equal(props.object3D.visible, false);
  assert.equal(registry.list().length, 0);
});

test('search filters by id, name, and type while layer locking remains explicit', () => {
  const registry = createEntityRegistry();
  registry.register({ ...makeEntity('lamp:wangan-0:0042', 'Lamps'), name: 'Highway lamp 0042', type: 'highway-lamp' });
  registry.register({ ...makeEntity('road:wangan-0', 'Roads'), name: 'Wangan Bayshore', type: 'road-route' });
  assert.equal(registry.search('0042')[0].id, 'lamp:wangan-0:0042');
  assert.equal(registry.search('bayshore')[0].id, 'road:wangan-0');
  assert.equal(registry.search('highway-lamp')[0].layer, 'Lamps');
  assert.equal(registry.isLayerLocked('Lamps'), false);
  assert.equal(registry.toggleLayerLocked('Lamps'), true);
  assert.equal(registry.isLayerLocked('Lamps'), true);
});

test('unregister supports undoable editor-owned entity lifecycles', () => {
  const registry = createEntityRegistry();
  const entity = registry.register(makeEntity('placed:0001', 'Props'));
  assert.equal(registry.unregister(entity.id), entity);
  assert.equal(registry.has(entity.id), false);
  registry.register(entity);
  assert.equal(registry.getById(entity.id).id, entity.id);
  assert.equal(registry.getById(entity.id).object3D, entity.object3D);
});
