import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld } from '../../src/world-adapter.js';

test('representative adapter resolves with high-level read-only entities', async () => {
  const progress = [];
  const adapter = await loadWorld({ mode: 'representative', onProgress: (message) => progress.push(message) });
  assert.equal(adapter.strategy, 'representative');
  assert.equal(adapter.group.isGroup, true);
  assert.equal(adapter.entities.length, 8);
  assert.ok(adapter.entities.every((entity) => entity.object3D && entity.editable === false));
  assert.ok(adapter.entities.some((entity) => entity.layer === 'Roads'));
  assert.ok(progress.length > 0);
  adapter.dispose();
});

test('unknown adapter modes resolve to the safe representative scene', async () => {
  const adapter = await loadWorld({ mode: 'unsupported' });
  assert.equal(adapter.strategy, 'representative');
  adapter.dispose();
});
