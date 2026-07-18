export const EDITOR_LAYERS = Object.freeze([
  'Roads', 'Road Markings', 'Guardrails', 'Barriers', 'Pillars',
  'Buildings', 'Lamps', 'Signs', 'Props', 'Tunnels', 'Garage',
  'Terrain', 'Lighting', 'Collisions',
]);

function assertEntity(entity, layers) {
  if (!entity || typeof entity !== 'object') throw new TypeError('Entity must be an object');
  if (!entity.id || typeof entity.id !== 'string') throw new TypeError('Entity id must be a non-empty string');
  if (!entity.type || typeof entity.type !== 'string') throw new TypeError(`Entity ${entity.id} needs a type`);
  if (!layers.has(entity.layer)) throw new TypeError(`Entity ${entity.id} uses unknown layer ${entity.layer}`);
  if (!entity.name || typeof entity.name !== 'string') throw new TypeError(`Entity ${entity.id} needs a name`);
}

export function createEntityRegistry({ layers = EDITOR_LAYERS } = {}) {
  const records = new Map();
  const listeners = new Set();
  const layerState = new Map(layers.map((name) => [name, { visible: true, locked: false }]));
  const originalVisibility = new Map();
  let batchDepth = 0;
  let batchChanged = false;
  const emit = (change) => {
    if (batchDepth) { batchChanged = true; return; }
    listeners.forEach((listener) => listener(change));
  };
  const visibilityObjects = (entity) => entity.visibilityObjects?.length
    ? entity.visibilityObjects
    : (entity.object3D ? [entity.object3D] : []);

  const applyLayerVisibility = (layer) => {
    const visible = layerState.get(layer).visible;
    const objects = new Set();
    for (const record of records.values()) {
      if (record.entity.layer === layer) visibilityObjects(record.entity).forEach((object) => objects.add(object));
    }
    objects.forEach((object) => { object.visible = visible; });
  };

  return {
    register(entity) {
      assertEntity(entity, layerState);
      if (records.has(entity.id)) throw new Error(`Duplicate entity id: ${entity.id}`);
      const normalized = {
        ...entity,
        id: entity.id,
        type: entity.type,
        layer: entity.layer,
        name: entity.name,
        object3D: entity.object3D || null,
        source: entity.source || 'unknown',
        editable: Boolean(entity.editable),
        generated: entity.generated !== false,
        assetId: entity.assetId || null,
        parentId: entity.parentId || null,
        metadata: entity.metadata || {},
        visibilityObjects: entity.visibilityObjects || (entity.object3D ? [entity.object3D] : []),
      };
      records.set(normalized.id, { entity: normalized });
      for (const object of visibilityObjects(normalized)) {
        if (!originalVisibility.has(object)) originalVisibility.set(object, object.visible);
        if (!layerState.get(normalized.layer).visible) object.visible = false;
      }
      emit({ type: 'register', id: normalized.id, layer: normalized.layer });
      return normalized;
    },
    getById(id) { return records.get(id)?.entity || null; },
    has(id) { return records.has(id); },
    list() { return [...records.values()].map((record) => record.entity); },
    listByLayer(layer) {
      if (!layerState.has(layer)) return [];
      return [...records.values()].map((record) => record.entity).filter((entity) => entity.layer === layer);
    },
    search(query = '', { layer = null, type = null } = {}) {
      const needle = String(query).trim().toLowerCase();
      return this.list().filter((entity) => {
        if (layer && entity.layer !== layer) return false;
        if (type && entity.type !== type) return false;
        if (!needle) return true;
        return `${entity.id}\n${entity.name}\n${entity.type}`.toLowerCase().includes(needle);
      });
    },
    layers() {
      const counts = new Map(layers.map((name) => [name, 0]));
      for (const record of records.values()) counts.set(record.entity.layer, counts.get(record.entity.layer) + 1);
      return [...layerState].map(([name, state]) => ({ name, visible: state.visible, locked: state.locked, count: counts.get(name) }));
    },
    isLayerVisible(layer) { return layerState.get(layer)?.visible ?? false; },
    isLayerLocked(layer) { return layerState.get(layer)?.locked ?? true; },
    setLayerVisibility(layer, visible) {
      if (!layerState.has(layer)) throw new Error(`Unknown layer: ${layer}`);
      const next = Boolean(visible);
      if (layerState.get(layer).visible === next) return;
      layerState.get(layer).visible = next;
      applyLayerVisibility(layer);
      emit({ type: 'layer-visibility', layer, visible: next });
    },
    toggleLayerVisibility(layer) {
      if (!layerState.has(layer)) throw new Error(`Unknown layer: ${layer}`);
      this.setLayerVisibility(layer, !layerState.get(layer).visible);
      return layerState.get(layer).visible;
    },
    setLayerLocked(layer, locked) {
      if (!layerState.has(layer)) throw new Error(`Unknown layer: ${layer}`);
      const next = Boolean(locked);
      if (layerState.get(layer).locked === next) return;
      layerState.get(layer).locked = next;
      emit({ type: 'layer-lock', layer, locked: next });
    },
    toggleLayerLocked(layer) {
      this.setLayerLocked(layer, !layerState.get(layer)?.locked);
      return layerState.get(layer).locked;
    },
    update(id, patch) {
      const entity = this.getById(id);
      if (!entity) return null;
      Object.assign(entity, patch);
      emit({ type: 'entity-update', id, patch });
      return entity;
    },
    unregister(id) {
      const record = records.get(id);
      if (!record) return null;
      records.delete(id);
      emit({ type: 'unregister', id, layer: record.entity.layer });
      return record.entity;
    },
    batch(callback) {
      batchDepth += 1;
      try { return callback(); }
      finally {
        batchDepth -= 1;
        if (!batchDepth && batchChanged) {
          batchChanged = false;
          listeners.forEach((listener) => listener({ type: 'batch' }));
        }
      }
    },
    clear() {
      originalVisibility.forEach((visible, object) => { object.visible = visible; });
      originalVisibility.clear();
      records.clear();
      for (const state of layerState.values()) { state.visible = true; state.locked = false; }
      emit({ type: 'clear' });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
