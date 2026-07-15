/**
 * Duplicate-safe undo/redo stack over JSON snapshots. DOM-free (also used
 * by the Node test suite).
 */
export class History {
  constructor(limit = 200) {
    this.limit = limit;
    this.stack = [];
    this.index = -1;
  }

  /** Start over with a single baseline snapshot. */
  reset(snapshot) {
    this.stack = [snapshot];
    this.index = 0;
  }

  /** Push a snapshot; identical consecutive snapshots are ignored. */
  push(snapshot) {
    if (this.index >= 0 && this.stack[this.index] === snapshot) return false;
    this.stack.length = this.index + 1; // drop redo tail
    this.stack.push(snapshot);
    if (this.stack.length > this.limit) this.stack.shift();
    this.index = this.stack.length - 1;
    return true;
  }

  get canUndo() { return this.index > 0; }

  get canRedo() { return this.index < this.stack.length - 1; }

  undo() {
    if (!this.canUndo) return null;
    this.index -= 1;
    return this.stack[this.index];
  }

  redo() {
    if (!this.canRedo) return null;
    this.index += 1;
    return this.stack[this.index];
  }
}
