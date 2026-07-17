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
  const layerState = new Map(layers.map((name) => [name, { visible: true }]));
  const emit = (change) => listeners.forEach((listener) => listener(change));

  const applyLayerVisibility = (layer) => {
    const visible = layerState.get(layer).visible;
    for (const record of records.values()) {
      if (record.entity.layer === layer && record.entity.object3D) record.entity.object3D.visible = visible;
    }
  };

  return {
    register(entity) {
      assertEntity(entity, layerState);
      if (records.has(entity.id)) throw new Error(`Duplicate entity id: ${entity.id}`);
      const normalized = Object.freeze({
        id: entity.id,
        type: entity.type,
        layer: entity.layer,
        name: entity.name,
        object3D: entity.object3D || null,
        editable: Boolean(entity.editable),
        source: entity.source || 'unknown',
      });
      records.set(normalized.id, { entity: normalized, originalVisible: normalized.object3D?.visible ?? true });
      if (normalized.object3D) normalized.object3D.visible = layerState.get(normalized.layer).visible;
      emit({ type: 'register', id: normalized.id, layer: normalized.layer });
      return normalized;
    },
    getById(id) { return records.get(id)?.entity || null; },
    list() { return [...records.values()].map((record) => record.entity); },
    listByLayer(layer) {
      if (!layerState.has(layer)) return [];
      return [...records.values()].map((record) => record.entity).filter((entity) => entity.layer === layer);
    },
    layers() {
      return [...layerState].map(([name, state]) => ({
        name,
        visible: state.visible,
        count: [...records.values()].filter((record) => record.entity.layer === name).length,
      }));
    },
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
    clear() {
      for (const record of records.values()) {
        if (record.entity.object3D) record.entity.object3D.visible = record.originalVisible;
      }
      records.clear();
      for (const state of layerState.values()) state.visible = true;
      emit({ type: 'clear' });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
