import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { anchorShiftForScale } from '../../src/interaction/entity-transform.js';

const QUAT_IDENTITY = new THREE.Quaternion();

test('anchorShiftForScale: null for non single-axis handles', () => {
  assert.equal(anchorShiftForScale('xyz', [1, 1, 1], [2, 2, 2], [-1, -1, -1], QUAT_IDENTITY), null);
  assert.equal(anchorShiftForScale('xy', [1, 1, 1], [2, 2, 1], [-1, -1, -1], QUAT_IDENTITY), null);
});

test('anchorShiftForScale: keeps the -Y face fixed when scaling up +Y', () => {
  // Object spans y in [-2, 3] locally; scaling Y 1 → 2 must shift position by
  // (1-2) * (-2) = +2 along local Y so the bottom face stays in place.
  const shift = anchorShiftForScale('y', [1, 1, 1], [1, 2, 1], [-4, -2, -5], QUAT_IDENTITY);
  assert.deepEqual(shift, [0, 2, 0]);
});

test('anchorShiftForScale: shrinking shifts the opposite way', () => {
  // Scaling X 2 → 1 with min.x = -3: (2-1) * (-3) = -3 along local X.
  const shift = anchorShiftForScale('x', [2, 1, 1], [1, 1, 1], [-3, -1, -1], QUAT_IDENTITY);
  assert.deepEqual(shift, [-3, 0, 0]);
});

test('anchorShiftForScale: shift is rotated by the local quaternion', () => {
  // 90° around Z maps local +Y onto world -X.
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  const shift = anchorShiftForScale('y', [1, 1, 1], [1, 2, 1], [0, -2, 0], quaternion);
  assert.ok(Math.abs(shift[0] - -2) < 1e-9, `expected x ≈ -2, got ${shift[0]}`);
  assert.ok(Math.abs(shift[1]) < 1e-9, `expected y ≈ 0, got ${shift[1]}`);
  assert.ok(Math.abs(shift[2]) < 1e-9, `expected z ≈ 0, got ${shift[2]}`);
});

test('anchorShiftForScale: zero when scale did not change', () => {
  assert.deepEqual(anchorShiftForScale('z', [1, 1, 2], [1, 1, 2], [-1, -1, -7], QUAT_IDENTITY), [0, 0, 0]);
});
