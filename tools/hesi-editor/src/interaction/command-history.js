export class CommandHistory {
  constructor({ limit = 200, onChange = () => {} } = {}) {
    this.limit = limit;
    this.onChange = onChange;
    this.commands = [];
    this.index = 0;
    this.savedIndex = 0;
    this._emit();
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.commands.length; }
  get undoLabel() { return this.canUndo ? this.commands[this.index - 1].label : null; }
  get redoLabel() { return this.canRedo ? this.commands[this.index].label : null; }
  get dirty() { return this.index !== this.savedIndex; }

  execute(command, { alreadyApplied = false } = {}) {
    if (!command?.label || typeof command.redo !== 'function' || typeof command.undo !== 'function') {
      throw new TypeError('Commands need a label, redo, and undo');
    }
    if (this.canRedo) {
      this.commands.splice(this.index);
      if (this.savedIndex > this.index) this.savedIndex = -1;
    }
    if (!alreadyApplied) command.redo();
    this.commands.push(command);
    this.index += 1;
    if (this.commands.length > this.limit) {
      this.commands.shift();
      this.index -= 1;
      this.savedIndex = this.savedIndex < 0 ? -1 : Math.max(-1, this.savedIndex - 1);
    }
    this._emit();
    return command;
  }

  undo() {
    if (!this.canUndo) return false;
    const command = this.commands[this.index - 1];
    command.undo();
    this.index -= 1;
    this._emit();
    return true;
  }

  redo() {
    if (!this.canRedo) return false;
    const command = this.commands[this.index];
    command.redo();
    this.index += 1;
    this._emit();
    return true;
  }

  markSaved() {
    this.savedIndex = this.index;
    this._emit();
  }

  clear() {
    this.commands.length = 0;
    this.index = 0;
    this.savedIndex = 0;
    this._emit();
  }

  state() {
    return {
      canUndo: this.canUndo,
      canRedo: this.canRedo,
      undoLabel: this.undoLabel,
      redoLabel: this.redoLabel,
      dirty: this.dirty,
      index: this.index,
      length: this.commands.length,
    };
  }

  _emit() { this.onChange(this.state()); }
}
