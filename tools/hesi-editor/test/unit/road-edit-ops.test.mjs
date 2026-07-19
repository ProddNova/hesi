import test from 'node:test';
import assert from 'node:assert/strict';
import { deletePoint, findRoute, insertPointAfter, movePoint, nearestSegment } from '../../src/interaction/road-edit-ops.js';

const makeRoute = (points, extras = {}) => ({ id: 'c1_0', name: 'C1 Inner Loop', points, ...extras });

test('movePoint updates x/z, preserves y, and validates the index', () => {
  const route = makeRoute([[10, 4, 20], [30, 6, 40], [50, 8, 60]]);
  const moved = movePoint(route, 1, [33, 44]);
  assert.deepEqual(moved, [33, 6, 44], 'y stays untouched');
  assert.deepEqual(route.points[1], [33, 6, 44]);
  assert.throws(() => movePoint(route, 3, [0, 0]), RangeError);
  assert.throws(() => movePoint(route, -1, [0, 0]), RangeError);
  assert.throws(() => movePoint(route, 1.5, [0, 0]), RangeError);
  assert.throws(() => movePoint(route, 0, [Number.NaN, 0]), TypeError);
});

test('insertPointAfter inserts mid-polyline and appends after the last index', () => {
  const route = makeRoute([[0, 0, 0], [10, 1, 0], [20, 2, 0]]);
  const inserted = insertPointAfter(route, 0, [5, 0.5, 2]);
  assert.deepEqual(inserted, [5, 0.5, 2]);
  assert.deepEqual(route.points.map((point) => point[0]), [0, 5, 10, 20]);
  insertPointAfter(route, route.points.length - 1, [30, 3, 0]);
  assert.deepEqual(route.points.at(-1), [30, 3, 0], 'last index appends');
  assert.equal(route.points.length, 5);
  assert.throws(() => insertPointAfter(route, 5, [0, 0, 0]), RangeError);
});

test('deletePoint removes a point but refuses to shorten a 2-point route', () => {
  const route = makeRoute([[0, 0, 0], [10, 1, 0], [20, 2, 0]]);
  assert.equal(deletePoint(route, 1), true);
  assert.deepEqual(route.points.map((point) => point[0]), [0, 20]);
  assert.equal(deletePoint(route, 0), false, 'refuses at 2 points');
  assert.equal(route.points.length, 2);
  assert.throws(() => deletePoint(route, 7), RangeError);
});

test('nearestSegment picks the closest segment and interpolates y linearly', () => {
  const points = [[0, 0, 0], [100, 10, 0], [100, 20, 100]];
  const segment = nearestSegment(points, 50, 6);
  assert.equal(segment.index, 0);
  assert.deepEqual(segment.point, [50, 5, 0], 'y is the midpoint elevation at t=0.5');
  assert.equal(segment.distance, 6);
  const second = nearestSegment(points, 104, 50);
  assert.equal(second.index, 1);
  assert.deepEqual(second.point, [100, 15, 50]);
  assert.equal(second.distance, 4);
  const clamped = nearestSegment(points, -40, 1);
  assert.equal(clamped.index, 0, 'projection clamps to the segment start');
  assert.deepEqual(clamped.point, [0, 0, 0]);
  assert.equal(nearestSegment([[0, 0, 0]], 0, 0), null, 'needs at least two points');
});

test('findRoute returns the route with the given id', () => {
  const routeData = { routes: [makeRoute([[0, 0, 0], [1, 0, 1]], { id: 'c1_0', name: 'C1 Inner Loop' }), makeRoute([[2, 0, 2], [3, 0, 3]], { id: 'wangan_0', name: 'Wangan Bayshore' })] };
  assert.equal(findRoute(routeData, 'wangan_0').name, 'Wangan Bayshore');
  assert.equal(findRoute(routeData, 'c1_0').id, 'c1_0');
  assert.equal(findRoute(routeData, 'missing'), null);
  assert.equal(findRoute(null, 'c1_0'), null);
});
