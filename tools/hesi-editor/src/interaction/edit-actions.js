import * as THREE from 'three';
import { applyEntityTransform, setEntityVisible, snapshotTransform, sourceTransformFor, transformsEqual } from './entity-transform.js';

function clone(value) { return value == null ? value : structuredClone(value); }

export class EditActions {
  constructor({ registry, adapter, assetRegistry, projectState, history, selection, transformManager, onChange = () => {}, onStatus = () => {} }) {
    Object.assign(this, { registry, adapter, assetRegistry, projectState, history, selection, transformManager, onChange, onStatus });
    this.transformClipboard = null;
    this.isolation = null;
  }

  get entity() { return this.selection.selected; }

  setVisibility(visible) {
    const entity = this.entity;
    if (!entity?.object3D) return this._status('Nothing visual is selected');
    const before = !entity.metadata.disabled;
    const after = Boolean(visible);
    if (before === after) return false;
    const previousOverride = this.projectState.getOverride(entity.id);
    const apply = (nextVisible, override) => {
      setEntityVisible(entity, nextVisible);
      entity.metadata.hasOverride = true;
      this.projectState.replaceOverride(entity.id, override);
      if (!entity.generated) this.projectState.updatePlaced(entity.id, { visible: nextVisible });
      this.registry.update(entity.id, { metadata: entity.metadata });
      this.transformManager.setSelection(entity);
      this.onChange(entity);
    };
    const nextOverride = { ...(previousOverride || {}), visible: after };
    this.history.execute({
      label: `${after ? 'Show' : entity.generated ? 'Disable' : 'Hide'} ${entity.name}`,
      redo: () => apply(after, nextOverride),
      undo: () => apply(before, previousOverride),
    });
    return true;
  }

  toggleVisibility() { return this.setVisibility(Boolean(this.entity?.metadata?.disabled)); }

  setLocked(locked) {
    const entity = this.entity;
    if (!entity) return this._status('Nothing is selected');
    const before = Boolean(entity.metadata.locked);
    const after = Boolean(locked);
    if (before === after) return false;
    const previousOverride = this.projectState.getOverride(entity.id);
    const apply = (nextLocked, override) => {
      entity.metadata.locked = nextLocked;
      entity.metadata.hasOverride = true;
      this.projectState.replaceOverride(entity.id, override);
      if (!entity.generated) this.projectState.updatePlaced(entity.id, { locked: nextLocked });
      this.registry.update(entity.id, { metadata: entity.metadata });
      this.transformManager.setSelection(entity);
      this.onChange(entity);
    };
    const nextOverride = { ...(previousOverride || {}), locked: after };
    this.history.execute({
      label: `${after ? 'Lock' : 'Unlock'} ${entity.name}`,
      redo: () => apply(after, nextOverride),
      undo: () => apply(before, previousOverride),
    });
    return true;
  }

  toggleLocked() { return this.setLocked(!this.entity?.metadata?.locked); }

  duplicate() {
    const source = this.entity;
    if (!source) return this._status('Nothing is selected');
    if (!this.assetRegistry.supports(source)) return this._status('Duplicate unavailable: select an individual reusable generated asset');
    const placed = this.assetRegistry.createPlacedEntity(source);
    if (!source.generated) {
      const transform = snapshotTransform(source.object3D);
      transform.position[0] += 2;
      applyEntityTransform(placed, transform);
      placed.metadata.initialTransform = clone(transform);
    }
    return this._addPlacedEntity(placed, `Duplicate ${source.name}`,
      `Created ${placed.name} as ${placed.id} · shared asset ${placed.assetId}`);
  }

  placeAsset(assetId, position) {
    const sourceId = this.assetRegistry.sourceEntityId(assetId);
    const source = sourceId ? this.registry.getById(sourceId) : assetId;
    if (!source) return this._status(`Asset source is unavailable: ${assetId}`);
    let placed;
    try {
      placed = this.assetRegistry.createPlacedEntity(source, { position });
    } catch (error) {
      return this._status(`Cannot place asset: ${error.message}`);
    }
    const label = this.assetRegistry.get(assetId)?.label || placed.name;
    return this._addPlacedEntity(placed, `Place ${label}`,
      `Placed ${placed.name} at ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`);
  }

  _addPlacedEntity(placed, commandLabel, doneMessage) {
    const record = this.assetRegistry.recordFor(placed);
    const add = () => {
      if (!placed.object3D.parent) this.adapter.editorObjectsGroup.add(placed.object3D);
      if (!this.registry.has(placed.id)) this.registry.register(placed);
      this.adapter.registerEditorEntity(placed);
      if (!this.projectState.getPlaced(placed.id)) this.projectState.addPlaced(record);
      this.selection.select(placed, { source: 'place' });
      this.onChange(placed);
    };
    const remove = () => {
      if (this.selection.selected?.id === placed.id) this.selection.clear('undo-place');
      this.registry.unregister(placed.id);
      placed.object3D.removeFromParent();
      this.projectState.removePlaced(placed.id);
      this.onChange(null);
    };
    this.history.execute({ label: commandLabel, redo: add, undo: remove });
    this._status(doneMessage);
    return placed;
  }

  deleteSelected() {
    const entity = this.entity;
    if (!entity) return this._status('Nothing is selected');
    if (entity.generated) return this.setVisibility(false);
    const record = this.projectState.getPlaced(entity.id) || this.assetRegistry.recordFor(entity);
    const remove = () => {
      if (this.selection.selected?.id === entity.id) this.selection.clear('delete');
      this.registry.unregister(entity.id);
      entity.object3D.removeFromParent();
      this.projectState.removePlaced(entity.id);
      this.onChange(null);
    };
    const restore = () => {
      this.adapter.editorObjectsGroup.add(entity.object3D);
      if (!this.registry.has(entity.id)) this.registry.register(entity);
      this.adapter.registerEditorEntity(entity);
      if (!this.projectState.getPlaced(entity.id)) this.projectState.addPlaced(record);
      this.selection.select(entity, { source: 'undo-delete' });
      this.onChange(entity);
    };
    this.history.execute({ label: `Delete ${entity.name}`, redo: remove, undo: restore });
    return true;
  }

  rename(name) {
    const entity = this.entity;
    const nextName = String(name || '').trim();
    if (!entity || !nextName || nextName === entity.name) return false;
    const before = entity.name;
    const previousOverride = this.projectState.getOverride(entity.id);
    const apply = (value, override) => {
      entity.name = value;
      entity.object3D.name = value;
      this.projectState.replaceOverride(entity.id, override);
      if (!entity.generated) this.projectState.updatePlaced(entity.id, { name: value });
      this.registry.update(entity.id, { name: value });
      this.onChange(entity);
    };
    const nextOverride = { ...(previousOverride || {}), name: nextName };
    this.history.execute({ label: `Rename ${before}`, redo: () => apply(nextName, nextOverride), undo: () => apply(before, previousOverride) });
    return true;
  }

  copyTransform() {
    if (!this.entity?.object3D) return this._status('Nothing visual is selected');
    this.transformClipboard = snapshotTransform(this.entity.object3D);
    this._status(`Copied transform from ${this.entity.name}`);
    return true;
  }

  pasteTransform() {
    if (!this.transformClipboard) return this._status('Transform clipboard is empty');
    return this.transformManager.applyNumeric(clone(this.transformClipboard), 'Paste transform');
  }

  async copyId() {
    if (!this.entity) return this._status('Nothing is selected');
    await navigator.clipboard.writeText(this.entity.id);
    this._status(`Copied ID ${this.entity.id}`);
    return true;
  }

  resetSelected() {
    const entity = this.entity;
    if (!entity) return this._status('Nothing is selected');
    const beforeTransform = entity.object3D ? snapshotTransform(entity.object3D) : null;
    const afterTransform = entity.object3D
      ? clone(entity.generated ? sourceTransformFor(entity) : entity.metadata.initialTransform)
      : null;
    const before = {
      transform: beforeTransform,
      visible: !entity.metadata.disabled,
      locked: Boolean(entity.metadata.locked),
      name: entity.name,
      override: this.projectState.getOverride(entity.id),
    };
    const originalName = entity.generated
      ? (entity.metadata.editorSourceName || entity.name)
      : (entity.metadata.initialName || entity.name);
    entity.metadata.editorSourceName = originalName;
    const apply = (state) => {
      if (state.transform) applyEntityTransform(entity, state.transform, { visible: state.visible });
      entity.metadata.disabled = !state.visible;
      entity.metadata.locked = state.locked;
      entity.metadata.hasOverride = Boolean(state.override);
      entity.name = state.name;
      this.projectState.replaceOverride(entity.id, state.override);
      if (!entity.generated) this.projectState.updatePlaced(entity.id, {
        transform: clone(state.transform), visible: state.visible, locked: state.locked, name: state.name,
      });
      this.registry.update(entity.id, { name: state.name, metadata: entity.metadata });
      this.transformManager.setSelection(entity);
      this.onChange(entity);
    };
    const reset = { transform: afterTransform, visible: true, locked: false, name: originalName, override: null };
    if (transformsEqual(before.transform, reset.transform) && before.visible && !before.locked && before.name === originalName && !before.override) return false;
    this.history.execute({ label: `Reset overrides · ${entity.name}`, redo: () => apply(reset), undo: () => apply(before) });
    return true;
  }

  isolateSelected() {
    const entity = this.entity;
    if (!entity?.object3D) return this._status('Nothing visual is selected');
    this.exitIsolation();
    const visibility = new Map();
    this.adapter.group.traverse((object) => {
      if (!object.isMesh && !object.isLine && !object.isPoints) return;
      visibility.set(object, object.visible);
      object.visible = false;
    });
    const instanceBackups = [];
    const selectedComponents = entity.metadata.instanceComponents || [];
    if (selectedComponents.length) {
      for (const component of selectedComponents) {
        const mesh = component.mesh;
        if (!instanceBackups.some((item) => item.mesh === mesh)) {
          instanceBackups.push({ mesh, matrices: mesh.instanceMatrix.array.slice() });
          const matrix = new THREE.Matrix4();
          const position = new THREE.Vector3();
          const quaternion = new THREE.Quaternion();
          for (let index = 0; index < mesh.count; index += 1) {
            mesh.getMatrixAt(index, matrix);
            matrix.decompose(position, quaternion, new THREE.Vector3());
            matrix.compose(position, quaternion, new THREE.Vector3(0, 0, 0));
            mesh.setMatrixAt(index, matrix);
          }
        }
        const backup = instanceBackups.find((item) => item.mesh === mesh);
        const matrix = new THREE.Matrix4().fromArray(backup.matrices, component.instanceIndex * 16);
        mesh.setMatrixAt(component.instanceIndex, matrix);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = true;
      }
    } else {
      for (const object of entity.visibilityObjects || [entity.object3D]) {
        object.traverse?.((child) => { if (child.isMesh || child.isLine || child.isPoints) child.visible = true; });
        if (object.isMesh || object.isLine || object.isPoints) object.visible = true;
        let parent = object.parent;
        while (parent && parent !== this.adapter.group.parent) { parent.visible = true; parent = parent.parent; }
      }
    }
    this.isolation = { visibility, instanceBackups };
    this._status(`Isolated ${entity.name}`);
    this.onChange(entity);
    return true;
  }

  exitIsolation() {
    if (!this.isolation) return false;
    this.isolation.visibility.forEach((visible, object) => { object.visible = visible; });
    for (const { mesh, matrices } of this.isolation.instanceBackups) {
      mesh.instanceMatrix.array.set(matrices);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox?.();
      mesh.computeBoundingSphere?.();
    }
    this.isolation = null;
    this._status('Exited isolation');
    this.onChange(this.entity);
    return true;
  }

  revealAll() {
    this.exitIsolation();
    for (const layer of this.registry.layers()) this.registry.setLayerVisibility(layer.name, true);
    for (const entity of this.registry.list()) {
      if (!entity.metadata.disabled) continue;
      setEntityVisible(entity, true);
      const override = this.projectState.getOverride(entity.id) || {};
      this.projectState.replaceOverride(entity.id, { ...override, visible: true });
      if (!entity.generated) this.projectState.updatePlaced(entity.id, { visible: true });
      this.registry.update(entity.id, { metadata: entity.metadata });
    }
    this.onChange(this.entity);
    this._status('Revealed all layers and disabled entities');
    return true;
  }

  _status(message) { this.onStatus(message); return false; }
}
