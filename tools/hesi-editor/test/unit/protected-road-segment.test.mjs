import test from 'node:test';
import assert from 'node:assert/strict';
import { protectedPointIndices } from '../../src/interaction/road-edit-ops.js';

// A 100 m straight sampled every 10 m: index i sits at x = i * 10.
const straight = () => Array.from({ length: 11 }, (_, index) => [index * 10, 0, 0]);
const tailSegment = (span, anchorX, anchorZ = 0) => ([{
  id: 'ramp_8:merge-tail',
  span,
  anchor: { x: anchorX, y: 0, z: anchorZ },
  reason: 'the merge alignment onto wangan_0 is derived from the host carriageway',
}]);

test('locks the run within `span` of the anchored terminal', () => {
  const locked = protectedPointIndices(straight(), tailSegment(25, 100));
  assert.deepEqual([...locked].sort((a, b) => a - b), [8, 9, 10]);
});

test('finds the terminal by world position, not by point order', () => {
  // Same road, reversed point list: the anchored terminal is now index 0.
  const locked = protectedPointIndices(straight().reverse(), tailSegment(25, 100));
  assert.deepEqual([...locked].sort((a, b) => a - b), [0, 1, 2]);
});

test('a span that would swallow the road locks nothing', () => {
  assert.equal(protectedPointIndices(straight(), tailSegment(500, 100)).size, 0);
  // 11 points, so 9 may be locked and 2 must stay free. A span reaching the
  // 10th point from the terminal locks the whole road and is refused outright.
  assert.equal(protectedPointIndices(straight(), tailSegment(85, 100)).size, 9);
  assert.equal(protectedPointIndices(straight(), tailSegment(90, 100)).size, 0);
});

test('closed routes, missing spans and malformed anchors lock nothing', () => {
  assert.equal(protectedPointIndices(straight(), tailSegment(25, 100), { closed: true }).size, 0);
  assert.equal(protectedPointIndices(straight(), []).size, 0);
  assert.equal(protectedPointIndices(straight(), null).size, 0);
  assert.equal(protectedPointIndices(straight(), [{ span: 25 }]).size, 0);
  assert.equal(protectedPointIndices(straight(), tailSegment(0, 100)).size, 0);
  assert.equal(protectedPointIndices(straight(), tailSegment(Number.NaN, 100)).size, 0);
  assert.equal(protectedPointIndices([[0, 0, 0], [10, 0, 0]], tailSegment(5, 10)).size, 0);
});

test('the span is measured along the polyline, not as a straight chord', () => {
  // An L: 40 m east then 40 m north. The terminal is (40, 0, 40); the point at
  // the corner is 40 m away along the road but only ~40 m as the crow flies,
  // while (0,0,0) is 80 m along the road and ~56 m direct.
  const bend = [[0, 0, 0], [20, 0, 0], [40, 0, 0], [40, 0, 20], [40, 0, 40]];
  const locked = protectedPointIndices(bend, tailSegment(45, 40, 40));
  assert.ok(!locked.has(0), 'the far end is 80 m along the road and stays editable');
  assert.deepEqual([...locked].sort((a, b) => a - b), [2, 3, 4]);
});
