import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRoadRouteOverrides,
  blankRoadRouteOverrides,
  canonicalizeRoadRouteOverrides,
  mergeRoadRouteUpdates,
  serializeRoadRouteOverrides,
} from '../../src/overrides/road-route-schema.js';

const production = () => ({
  meta: { source: 'fixture' },
  routes: [
    { id: 'a', name: 'A', points: [[0, 1, 0], [10, 1, 0], [20, 1, 0]] },
    { id: 'b', name: 'B', points: [[0, 2, 10], [10, 2, 10]] },
  ],
  edges: [{ from: { route: 'a' }, to: { route: 'b' } }],
});

test('road route update source is deterministic and rounds coordinates', () => {
  const merged = mergeRoadRouteUpdates(blankRoadRouteOverrides(), [{
    id: 'a', points: [[0, 1, 0], [10.1234567, 1, -0], [20, 1, 0]],
  }], production());
  assert.deepEqual(merged.routes.a.points[1], [10.12346, 1, 0]);
  assert.equal(serializeRoadRouteOverrides(merged, { production: production() }), serializeRoadRouteOverrides(merged, { production: production() }));
});

test('publishing replaces only named route points and preserves unrelated source data', () => {
  const base = production();
  const overrides = mergeRoadRouteUpdates(blankRoadRouteOverrides(), [{ id: 'a', points: [[0, 1, 0], [12, 1, 0], [20, 1, 0]] }], base);
  const output = applyRoadRouteOverrides(base, overrides);
  assert.deepEqual(output.routes[0].points, [[0, 1, 0], [12, 1, 0], [20, 1, 0]]);
  assert.deepEqual(output.routes[1], base.routes[1]);
  assert.deepEqual(output.edges, base.edges);
  assert.deepEqual(base.routes[0].points, [[0, 1, 0], [10, 1, 0], [20, 1, 0]], 'input is not mutated');
});

test('runtime-generated routes persist separately and publish into production metadata', () => {
  const base = production();
  const points = [[2, 30, 4], [8, 31, 12], [14, 30, 20]];
  const overrides = mergeRoadRouteUpdates(blankRoadRouteOverrides(), [{
    id: 'tatsumi_pa_exit', synthetic: true, points,
  }], base);
  assert.deepEqual(overrides.syntheticRoutes.tatsumi_pa_exit.points, points);
  assert.deepEqual(overrides.routes, {});
  const output = applyRoadRouteOverrides(base, overrides);
  assert.deepEqual(output.routes, base.routes, 'synthetic overrides do not impersonate production routes');
  assert.deepEqual(output.meta.editorRoadOverrides.syntheticRoutes.tatsumi_pa_exit.points, points);
});

test('road route schema rejects malformed, duplicate, and unknown updates readably', () => {
  assert.throws(() => mergeRoadRouteUpdates(blankRoadRouteOverrides(), [{ id: 'missing', points: [[0, 0, 0], [1, 0, 1]] }], production()), /unknown production route/);
  assert.throws(() => mergeRoadRouteUpdates(blankRoadRouteOverrides(), [{ id: '../bad', synthetic: true, points: [[0, 0, 0], [1, 0, 1]] }], production()), /invalid id/);
  assert.throws(() => mergeRoadRouteUpdates(blankRoadRouteOverrides(), [
    { id: 'a', points: [[0, 0, 0], [1, 0, 1]] },
    { id: 'a', points: [[0, 0, 0], [1, 0, 1]] },
  ], production()), /Duplicate road route update/);
  assert.throws(() => canonicalizeRoadRouteOverrides({ version: 1, source: 'data/routes-smoothed.json', routes: { a: { points: [[0, 0, 0], [Number.NaN, 0, 1]] } } }, { production: production() }), /finite number/);
  assert.throws(() => mergeRoadRouteUpdates(blankRoadRouteOverrides(), [{
    id: 'a', points: [[1, 1, 0], [10, 1, 0], [20, 1, 0]],
  }], production()), /cannot move or remove production route endpoints/);
  assert.throws(() => canonicalizeRoadRouteOverrides({
    version: 1,
    source: 'data/routes-smoothed.json',
    routes: { a: { points: [[0, 1, 0], [10, 1, 0]] } },
  }, { production: production() }), /cannot move or remove production route endpoints/);
});
