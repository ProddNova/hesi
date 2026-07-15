import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOverrides, detectVersion, emptyOverrides } from '../lib/schema.mjs';

test('empty v2 document validates', () => {
  const v = validateOverrides(emptyOverrides());
  assert.equal(v.ok, true);
  assert.equal(v.version, 2);
});

test('valid v2 move/insert/delete/pin/smooth ops validate', () => {
  const doc = {
    version: 2,
    routes: {
      r1: [
        { id: 'a', op: 'move', anchor: { station: 100, point: [1, 2], tolerance: 15 }, to: [3, 4], influence: 45, weight: 24, note: 'x', enabled: true },
        { id: 'b', op: 'insert', anchor: { station: 50 }, point: [1, 2, 3] },
        { id: 'c', op: 'delete', anchor: { station: 10, point: [0, 0], tolerance: 6 } },
        { id: 'd', op: 'pin', anchor: { point: [5, 5] }, span: 30 },
        { id: 'e', op: 'smooth', anchor: { station: 200 }, span: 80, factor: 0.2 },
      ],
    },
  };
  const v = validateOverrides(doc, ['r1']);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

test('legacy v1 document validates and is detected', () => {
  const doc = { r1: [{ op: 'move', index: 3, to: [1, 2] }, { op: 'insert', after: 4, point: [1, 2, 3] }, { op: 'delete', index: 0 }] };
  assert.equal(detectVersion(doc), 1);
  const v = validateOverrides(doc, ['r1']);
  assert.equal(v.ok, true);
  assert.equal(v.version, 1);
});

test('rejects unknown op, bad anchor, out-of-range values, unknown route, duplicate ids', () => {
  const doc = {
    version: 2,
    routes: {
      r1: [
        { id: 'a', op: 'warp', anchor: { station: 1 } },
        { id: 'b', op: 'move', anchor: {}, to: [1, 2] },
        { id: 'c', op: 'move', anchor: { station: 1 }, to: [1, 2], influence: -5 },
        { id: 'c', op: 'move', anchor: { station: 1 }, to: [1, 2] },
        { id: 'd', op: 'delete', anchor: { station: 5 } },
        { id: 'e', op: 'smooth', anchor: { station: 1 }, factor: 9 },
      ],
      ghost: [{ id: 'f', op: 'pin', anchor: { station: 0 } }],
    },
  };
  const v = validateOverrides(doc, ['r1']);
  assert.equal(v.ok, false);
  const paths = v.errors.map((e) => e.path).join('\n');
  assert.match(paths, /r1\[0\]\.op/);
  assert.match(paths, /r1\[1\]\.anchor/);
  assert.match(paths, /r1\[2\]\.influence/);
  assert.match(paths, /r1\[3\]\.id/);        // duplicate id
  assert.match(paths, /r1\[4\]\.anchor\.point/); // delete requires point
  assert.match(paths, /r1\[5\]\.factor/);
  assert.match(paths, /ghost/);              // unknown route
});

test('rejects non-finite coordinates', () => {
  const doc = { version: 2, routes: { r1: [{ op: 'move', anchor: { station: 1 }, to: [NaN, 2] }] } };
  const v = validateOverrides(JSON.parse(JSON.stringify(doc).replace('null', 'null')), ['r1']);
  assert.equal(v.ok, false);
});

test('garbage documents are rejected as version 0', () => {
  for (const doc of [null, [], 'x', { version: 2 }, { version: 2, routes: [] }, { a: 1 }]) {
    const v = validateOverrides(doc);
    assert.equal(v.ok, false, JSON.stringify(doc));
  }
});
