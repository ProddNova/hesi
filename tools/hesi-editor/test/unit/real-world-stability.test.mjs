import test from 'node:test';
import assert from 'node:assert/strict';
import { HighwayMap } from '../../../../js/map.js';
import { discoverHesiEntities } from '../../src/world/entity-discovery.js';
import { EDITOR_LAYERS } from '../../src/entity-registry.js';

function buildIdentitySnapshot() {
  const map = new HighwayMap({ quality: 'low', applyFog: false });
  try {
    const discovery = discoverHesiEntities(map);
    return {
      ids: discovery.entities.map((entity) => entity.id),
      layers: discovery.layerCounts,
      gameplayStarted: Boolean(globalThis.shutoko),
    };
  } finally {
    map.dispose();
  }
}

test('two independent real-world builds produce identical stable entity IDs and layer counts', { timeout: 60000 }, () => {
  const first = buildIdentitySnapshot();
  const second = buildIdentitySnapshot();
  assert.deepEqual(second.ids, first.ids);
  assert.deepEqual(second.layers, first.layers);
  assert.equal(new Set(first.ids).size, first.ids.length, 'all generated IDs are unique');
  assert.ok(first.ids.includes('lamp:wangan-0:0042'), 'known real Wangan lamp ID is discoverable');
  assert.ok(EDITOR_LAYERS.every((layer) => first.layers[layer] > 0), 'every truthful semantic layer is populated');
  assert.equal(first.gameplayStarted, false);
  assert.equal(second.gameplayStarted, false);
});
