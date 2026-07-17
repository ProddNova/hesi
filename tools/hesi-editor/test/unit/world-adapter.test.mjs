import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorld, localToGps } from '../../src/world-adapter.js';

test('demo adapter loads only when explicitly requested', async () => {
  const progress = [];
  const adapter = await loadWorld({ mode: 'demo', onProgress: (message) => progress.push(message) });
  assert.equal(adapter.strategy, 'demo');
  assert.equal(adapter.isRealWorld, false);
  assert.equal(adapter.group.isGroup, true);
  assert.ok(adapter.entities.length >= 4);
  assert.ok(adapter.entities.every((entity) => entity.object3D && entity.editable === false));
  assert.ok(adapter.entities.some((entity) => entity.layer === 'Roads'));
  assert.match(adapter.warning, /Explicit demo mode/);
  assert.ok(progress.length > 0);
  adapter.dispose();
});

test('inverse local projection round-trips known origin and finite offsets', () => {
  const origin = { lat: 35.68, lon: 139.77 };
  assert.deepEqual(localToGps(origin, 0, 0), origin);
  const gps = localToGps(origin, 1000, -500);
  assert.ok(Number.isFinite(gps.lat) && Number.isFinite(gps.lon));
  assert.ok(gps.lat < origin.lat);
  assert.ok(gps.lon > origin.lon);
  assert.equal(localToGps(null, 0, 0), null);
});
