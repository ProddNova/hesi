import { applyObjectFaceStyles, objectFaceSlots } from '/js/custom-assets.js';

const clone = (value) => value == null ? value : structuredClone(value);

function compactStyle(style) {
  if (!style?.texture) return null;
  return {
    texture: style.texture,
    ...(style.fit === 'cover' ? { fit: 'cover' } : {}),
    ...(style.flipX ? { flipX: true } : {}),
    ...(style.flipY ? { flipY: true } : {}),
  };
}

/** Owns per-face texture edits made from the Map Editor inspector. */
export class FaceTextureController {
  constructor({ registry, projectState, history, store, onChange = () => {}, onTexturesChanged = () => {}, onStatus = () => {} }) {
    Object.assign(this, { registry, projectState, history, store, onChange, onTexturesChanged, onStatus });
  }

  slots(entity) { return objectFaceSlots(entity?.object3D); }

  styles(entity) { return clone(entity?.metadata?.faceTextures || {}); }

  setStyle(entity, slotKey, patch) {
    if (!entity?.object3D) return this._status('Select a rendered object before assigning a texture');
    if (!this.slots(entity).some((slot) => slot.key === slotKey)) return this._status('That face is no longer available on the selected object');
    const before = this.styles(entity);
    const after = clone(before);
    const next = compactStyle({ ...(after[slotKey] || {}), ...clone(patch) });
    if (next) after[slotKey] = next;
    else delete after[slotKey];
    if (JSON.stringify(before) === JSON.stringify(after)) return false;
    this.history.execute({
      label: `${next ? 'Texture face' : 'Clear face texture'} · ${entity.name}`,
      redo: () => this._apply(entity, after),
      undo: () => this._apply(entity, before),
    });
    return true;
  }

  async assignTexture(entity, slotKey, textureId) {
    const changed = this.setStyle(entity, slotKey, { texture: textureId });
    if (changed && textureId && this.store.dirty) await this.store.save();
    return changed;
  }

  async assignFile(entity, slotKey, file) {
    if (!file) return false;
    const textureId = await this.store.addTextureFile(file);
    this.onTexturesChanged();
    const changed = await this.assignTexture(entity, slotKey, textureId);
    if (!changed) return false;
    this.onStatus(`Texture ${file.name} assigned to ${entity.name} · save the map project to keep the face assignment`);
    return true;
  }

  syncEntity(entity) {
    if (!entity?.object3D) return;
    applyObjectFaceStyles(entity.object3D, entity.metadata?.faceTextures || {}, this.store.texturesById());
  }

  _apply(entity, styles) {
    const nextStyles = clone(styles || {});
    if (entity.generated) {
      const override = this.projectState.getOverride(entity.id) || {};
      if (Object.keys(nextStyles).length) override.faceTextures = nextStyles;
      else delete override.faceTextures;
      this.projectState.replaceOverride(entity.id, Object.keys(override).length ? override : null);
      entity.metadata.hasOverride = Boolean(Object.keys(override).length);
    } else {
      this.projectState.updatePlaced(entity.id, { faceTextures: nextStyles });
    }
    entity.metadata.faceTextures = nextStyles;
    applyObjectFaceStyles(entity.object3D, nextStyles, this.store.texturesById());
    this.registry.update(entity.id, { metadata: entity.metadata });
    this.onChange(entity);
  }

  _status(message) { this.onStatus(message); return false; }
}
