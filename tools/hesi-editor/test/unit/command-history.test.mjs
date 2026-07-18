import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandHistory } from '../../src/interaction/command-history.js';

test('command history executes, undoes, redoes, truncates, and reports dirty state', () => {
  let value = 0;
  const states = [];
  const history = new CommandHistory({ onChange: (state) => states.push(state) });
  history.execute({ label: 'Set one', redo: () => { value = 1; }, undo: () => { value = 0; } });
  assert.equal(value, 1);
  assert.equal(history.undoLabel, 'Set one');
  assert.equal(history.dirty, true);
  assert.equal(history.undo(), true);
  assert.equal(value, 0);
  assert.equal(history.dirty, false);
  assert.equal(history.redo(), true);
  assert.equal(value, 1);
  history.markSaved();
  assert.equal(history.dirty, false);
  history.undo();
  history.execute({ label: 'Set two', redo: () => { value = 2; }, undo: () => { value = 0; } });
  assert.equal(value, 2);
  assert.equal(history.canRedo, false, 'new commands discard the redo branch');
  assert.ok(states.length >= 6);
});

test('already-applied gizmo commands create one history entry without replaying', () => {
  let redoCount = 0;
  const history = new CommandHistory();
  history.execute({ label: 'Drag lamp', redo: () => { redoCount += 1; }, undo: () => {} }, { alreadyApplied: true });
  assert.equal(redoCount, 0);
  assert.equal(history.commands.length, 1);
  history.undo();
  history.redo();
  assert.equal(redoCount, 1);
});
