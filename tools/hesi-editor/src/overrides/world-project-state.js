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
      environment: {},
      editorState: {},
    };
    this.listeners = new Set();
  }

  replaceDocument(document) {
    this.document = clone(document);
    this._emit({ type: 'document-replace' });
  }

  getOverride(id) { return clone(this.document.entityOverrides[id] ?? null); }

  updateProject(patch) {
    this.document.project = { ...this.document.project, ...clone(patch) };
    this._emit({ type: 'project-update', patch: clone(patch) });
  }

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
    // Placed entities temporarily use the override store while edit commands
    // are being undone/redone, but their persisted state lives entirely in
    // placedObjects. Never leave an orphan override behind after deletion:
    // project validation correctly treats it as an unknown generated entity.
    delete this.document.entityOverrides[id];
    this._emit({ type: 'placed-remove', id });
    return clone(record);
  }

  getSkybox() { return clone(this.document.environment?.skybox ?? null); }

  replaceSkybox(value) {
    if (!this.document.environment || typeof this.document.environment !== 'object') this.document.environment = {};
    if (value == null) delete this.document.environment.skybox;
    else this.document.environment.skybox = clone(value);
    this._emit({ type: 'skybox' });
  }

  getLighting() { return clone(this.document.environment?.lighting ?? null); }

  replaceLighting(value) {
    if (!this.document.environment || typeof this.document.environment !== 'object') this.document.environment = {};
    if (value == null) delete this.document.environment.lighting;
    else this.document.environment.lighting = clone(value);
    this._emit({ type: 'lighting' });
  }

  toJSON() { return clone(this.document); }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(change) { this.listeners.forEach((listener) => listener(change, this.toJSON())); }
}
