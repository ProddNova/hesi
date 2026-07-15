import { test } from 'node:test';
import assert from 'node:assert/strict';
import { History } from '../public/js/history.mjs';
import { EditorState } from '../public/js/state.mjs';
import { FakeStorage } from './helpers.mjs';

test('History: push/undo/redo with duplicate suppression and redo truncation', () => {
  const h = new History(10);
  h.reset('0');
  assert.equal(h.push('1'), true);
  assert.equal(h.push('1'), false); // duplicate-safe
  h.push('2');
  assert.equal(h.undo(), '1');
  assert.equal(h.undo(), '0');
  assert.equal(h.undo(), null);
  assert.equal(h.redo(), '1');
  h.push('X'); // truncates the '2' redo tail
  assert.equal(h.canRedo, false);
  assert.equal(h.undo(), '1');
});

test('EditorState: add/update/remove ops with undo/redo', () => {
  const st = new EditorState({ storage: new FakeStorage() });
  st.load({ version: 2, routes: {} });
  const op = st.addOp('r1', { op: 'move', anchor: { station: 5, point: [0, 0] }, to: [1, 1] });
  assert.ok(op.id, 'assigns a stable id');
  assert.ok(op.createdAt);
  assert.equal(st.hasOps('r1'), true);
  st.updateOp('r1', op.id, { to: [2, 2] });
  assert.deepEqual(st.findOp('r1', op.id).to, [2, 2]);

  st.undo();
  assert.deepEqual(st.findOp('r1', op.id).to, [1, 1]);
  st.undo();
  assert.equal(st.hasOps('r1'), false);
  st.redo();
  st.redo();
  assert.deepEqual(st.findOp('r1', op.id).to, [2, 2]);

  st.removeOp('r1', op.id);
  assert.equal(st.hasOps('r1'), false);
  assert.equal(st.doc.routes.r1, undefined, 'route entry pruned when empty');
});

test('EditorState: dirty flag, markSaved, draft round-trip', () => {
  const storage = new FakeStorage();
  const st = new EditorState({ storage });
  st.load({ version: 2, routes: {} });
  assert.equal(st.dirty, false);
  st.addOp('r1', { op: 'pin', anchor: { station: 1, point: [0, 0] } });
  assert.equal(st.dirty, true);
  const draft = new EditorState({ storage }).draftLoad();
  assert.ok(draft && draft.doc.routes.r1, 'draft autosaved');
  st.markSaved();
  assert.equal(st.dirty, false);

  st.draftClear();
  assert.equal(st.draftLoad(), null);
});

test('EditorState: removeOpsInRange only removes anchored ops inside the span', () => {
  const st = new EditorState({});
  st.load({ version: 2, routes: {} });
  st.addOp('r1', { op: 'move', anchor: { station: 100, point: [0, 0] }, to: [1, 1] });
  st.addOp('r1', { op: 'move', anchor: { station: 300, point: [0, 0] }, to: [1, 1] });
  st.addOp('r1', { op: 'move', anchor: { station: 900, point: [0, 0] }, to: [1, 1] });
  const n = st.removeOpsInRange('r1', 50, 400);
  assert.equal(n, 2);
  assert.equal(st.opsFor('r1').length, 1);
  assert.equal(st.opsFor('r1')[0].anchor.station, 900);
});

test('EditorState: legacy v1 import becomes v2 with ops preserved', () => {
  const st = new EditorState({});
  st.load({ r9: [{ op: 'move', index: 4, to: [1, 2] }] });
  assert.equal(st.doc.version, 2);
  assert.equal(st.doc.routes.r9.length, 1);
  assert.equal(st.doc.routes.r9[0].index, 4);
});
