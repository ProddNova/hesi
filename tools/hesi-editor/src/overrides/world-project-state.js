function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export class WorldProjectState {
  constructor(document = null) {
    this.document = document ? clone(document) : {
      version: 1,
      project: { name: 'HESI Main World' },
      entityOverrides: {},
      placedObjects: [],
      groups: [],
      editorState: {},
    };
    this.listeners = new Set();
  }

  getOverride(id) { return clone(this.document.entityOverrides[id] ?? null); }

  replaceOverride(id, value) {
    if (value == null || !Object.keys(value).length) delete this.document.entityOverrides[id];
    else this.document.entityOverrides[id] = clone(value);
    this._emit({ type: 'override', id });
  }

  patchOverride(id, patch) {
    this.replaceOverride(id, { ...(this.document.entityOverrides[id] || {}), ...clone(patch) });
  }

  getPlaced(id) { return clone(this.document.placedObjects.find((item) => item.id === id) || null); }

  addPlaced(record) {
    if (this.getPlaced(record.id)) throw new Error(`Placed object already exists: ${record.id}`);
    this.document.placedObjects.push(clone(record));
    this._emit({ type: 'placed-add', id: record.id });
  }

  updatePlaced(id, patch) {
    const index = this.document.placedObjects.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.document.placedObjects[index] = { ...this.document.placedObjects[index], ...clone(patch) };
    this._emit({ type: 'placed-update', id });
    return this.getPlaced(id);
  }

  removePlaced(id) {
    const index = this.document.placedObjects.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [record] = this.document.placedObjects.splice(index, 1);
    this._emit({ type: 'placed-remove', id });
    return clone(record);
  }

  toJSON() { return clone(this.document); }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(change) { this.listeners.forEach((listener) => listener(change, this.toJSON())); }
}
