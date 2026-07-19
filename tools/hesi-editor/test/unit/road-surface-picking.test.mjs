import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoadSurfaceRoute } from '../../src/interaction/selection-manager.js';

const surface = { id: 'road-surface:chunk', type: 'road-surface' };
const serviceSurface = { id: 'service-surface:chunk', type: 'service-road-surface' };
const route = { id: 'road:wangan-0', type: 'road-route', metadata: { routeId: 'wangan_0' } };

test('road surface hits resolve to the nearest semantic route entity', () => {
  const point = { x: 12, y: 40, z: -8 };
  let received = null;
  const adapter = {
    map: {
      getNearestRoute(hitPoint, options) {
        received = { hitPoint, options };
        return { route: { id: 'wangan_0' } };
      },
    },
  };
  const routes = new Map([['wangan_0', route]]);
  assert.equal(resolveRoadSurfaceRoute(surface, point, adapter, routes), route);
  assert.deepEqual(received, { hitPoint: point, options: { maxDistance: 80 } });
  assert.equal(resolveRoadSurfaceRoute(serviceSurface, point, adapter, routes), route);
});

test('road surface resolution safely falls back when no matching route exists', () => {
  const point = { x: 0, y: 0, z: 0 };
  const noRoute = { map: { getNearestRoute: () => null } };
  assert.equal(resolveRoadSurfaceRoute(surface, point, noRoute, new Map()), surface);
  assert.equal(resolveRoadSurfaceRoute({ id: 'lamp', type: 'highway-lamp' }, point, noRoute, new Map()).id, 'lamp');
  assert.equal(resolveRoadSurfaceRoute(surface, null, noRoute, new Map()), surface);
});
