import test from 'node:test';
import assert from 'node:assert/strict';
import { GRID_SNAP_ROTATE_DEGREES, GRID_SNAP_SCALE, GRID_SNAP_STEPS, GridSnap } from '../../src/interaction/grid-snap.js';

test('grid snap starts disabled and passes values through untouched', () => {
  const snap = new GridSnap();
  assert.deepEqual(snap.state(), { enabled: false, step: 1 });
  assert.equal(snap.snapValue(3.37), 3.37);
  const point = { x: 1.26, y: 4.5, z: -7.81 };
  assert.equal(snap.snapPosition(point), point);
  assert.deepEqual(point, { x: 1.26, y: 4.5, z: -7.81 });
  assert.deepEqual(snap.gizmoSnaps(), { translate: null, rotateDegrees: null, scale: null });
});

test('enabled grid snap rounds scalars and XZ positions to the step, never Y', () => {
  const snap = new GridSnap({ enabled: true, step: 0.5 });
  assert.equal(snap.snapValue(3.37), 3.5);
  assert.equal(snap.snapValue(-1.26), -1.5);
  const point = snap.snapPosition({ x: 1.26, y: 4.53, z: -7.81 });
  assert.deepEqual(point, { x: 1.5, y: 4.53, z: -8 });
  assert.deepEqual(snap.gizmoSnaps(), { translate: 0.5, rotateDegrees: GRID_SNAP_ROTATE_DEGREES, scale: GRID_SNAP_SCALE });
});

test('toggle and step changes notify subscribers exactly once per real change', () => {
  const seen = [];
  const snap = new GridSnap({ onChange: (state) => seen.push(state) });
  assert.equal(snap.toggle(), true);
  assert.equal(snap.setEnabled(true), false, 'no-op enable does not notify');
  assert.equal(snap.setStep(2), true);
  assert.equal(snap.setStep(2), false, 'no-op step does not notify');
  assert.equal(snap.setStep(0), false, 'zero step rejected');
  assert.equal(snap.setStep(-1), false, 'negative step rejected');
  assert.equal(snap.toggle(), false);
  assert.deepEqual(seen, [
    { enabled: true, step: 1 },
    { enabled: true, step: 2 },
    { enabled: false, step: 2 },
  ]);
});

test('the advertised step presets are usable and sorted', () => {
  const snap = new GridSnap({ enabled: true });
  for (const step of GRID_SNAP_STEPS) {
    assert.ok(snap.setStep(step) || snap.step === step);
    assert.equal(snap.snapValue(step * 3), step * 3);
  }
  const sorted = [...GRID_SNAP_STEPS].sort((a, b) => a - b);
  assert.deepEqual(GRID_SNAP_STEPS, sorted);
});

test('snapping is stable for values already on the grid (no drift)', () => {
  const snap = new GridSnap({ enabled: true, step: 0.25 });
  for (const value of [-10, -0.75, 0, 0.25, 12.5]) {
    assert.equal(snap.snapValue(snap.snapValue(value)), snap.snapValue(value));
  }
});
