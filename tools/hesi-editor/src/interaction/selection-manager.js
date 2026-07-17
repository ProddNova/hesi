import * as THREE from 'three';

function isEditorHelper(object) {
  let current = object;
  while (current) {
    if (current.userData?.editorHelper) return true;
    current = current.parent;
  }
  return false;
}

function isActuallyVisible(object) {
  let current = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

export class SelectionManager {
  constructor({ viewport, registry, adapter, onChange = () => {}, onStatus = () => {} }) {
    this.viewport = viewport;
    this.registry = registry;
    this.adapter = adapter;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.selected = null;
    this.inspectLocked = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._down = null;
    this._lastPick = { x: Infinity, y: Infinity, at: 0, ids: [], index: -1 };
    this.highlight = new THREE.Box3Helper(new THREE.Box3(), 0x56e5ff);
    this.highlight.name = 'Editor selection bounds';
    this.highlight.visible = false;
    this.highlight.userData.editorHelper = true;
    this.highlight.material.depthTest = false;
    this.highlight.material.transparent = true;
    this.highlight.material.opacity = 0.92;
    this.highlight.renderOrder = 10000;
    viewport.scene.add(this.highlight);

    this._onPointerDown = (event) => {
      if (event.button === 0) this._down = { x: event.clientX, y: event.clientY };
    };
    this._onPointerUp = (event) => {
      if (event.button !== 0 || !this._down) return;
      const travel = Math.hypot(event.clientX - this._down.x, event.clientY - this._down.y);
      this._down = null;
      if (travel > 4 || document.pointerLockElement === this.viewport.canvas) return;
      this.pick(event.clientX, event.clientY);
    };
    this._onKeyDown = (event) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
      if (event.code === 'Escape' && document.pointerLockElement !== this.viewport.canvas) this.clear('keyboard');
      if (event.code === 'KeyF') {
        event.preventDefault();
        this.focusSelected();
      }
    };
    viewport.canvas.addEventListener('pointerdown', this._onPointerDown);
    viewport.canvas.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
  }

  setInspectLocked(enabled) { this.inspectLocked = Boolean(enabled); }

  canSelect(entity) {
    if (!entity || !this.registry.isLayerVisible(entity.layer)) return false;
    if (this.registry.isLayerLocked(entity.layer) && !this.inspectLocked) return false;
    if (entity.metadata?.locked && !this.inspectLocked) return false;
    if (entity.metadata?.disabled) return false;
    return true;
  }

  pick(clientX, clientY) {
    const rect = this.viewport.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.viewport.camera);
    const hits = this.raycaster.intersectObject(this.adapter.group, true);
    const candidates = [];
    const seen = new Set();
    for (const hit of hits) {
      if (isEditorHelper(hit.object) || !isActuallyVisible(hit.object)) continue;
      const entity = this.adapter.resolveSelection?.(hit.object, hit.instanceId);
      if (!this.canSelect(entity) || seen.has(entity.id)) continue;
      seen.add(entity.id);
      candidates.push(entity);
    }
    if (!candidates.length) {
      this.clear('viewport');
      this.onStatus('No selectable semantic entity under pointer');
      return null;
    }
    const now = Date.now();
    const sameSpot = Math.hypot(clientX - this._lastPick.x, clientY - this._lastPick.y) < 6 && now - this._lastPick.at < 900;
    const ids = candidates.map((entity) => entity.id);
    const sameHits = sameSpot && ids.length === this._lastPick.ids.length && ids.every((id, index) => id === this._lastPick.ids[index]);
    const index = sameHits ? (this._lastPick.index + 1) % candidates.length : 0;
    this._lastPick = { x: clientX, y: clientY, at: now, ids, index };
    return this.select(candidates[index], { source: 'viewport', overlap: candidates.length, overlapIndex: index });
  }

  select(entityOrId, { source = 'api', overlap = 1, overlapIndex = 0 } = {}) {
    const entity = typeof entityOrId === 'string' ? this.registry.getById(entityOrId) : entityOrId;
    if (!this.canSelect(entity)) {
      this.onStatus(entity ? `${entity.layer} or entity is hidden, disabled, or locked` : 'Entity not found');
      return null;
    }
    this.selected = entity;
    this.refreshHighlight();
    this.onChange(entity, { source });
    this.onStatus(`Selected ${entity.name} · ${entity.id}${overlap > 1 ? ` · hit ${overlapIndex + 1}/${overlap}` : ''}`);
    return entity;
  }

  clear(source = 'api') {
    if (!this.selected) return;
    this.selected = null;
    this.highlight.visible = false;
    this.onChange(null, { source });
  }

  getSelectedBounds() {
    if (!this.selected) return new THREE.Box3();
    const box = this.selected.getWorldBounds?.() || (this.selected.object3D ? new THREE.Box3().setFromObject(this.selected.object3D) : new THREE.Box3());
    return box?.clone?.() || new THREE.Box3();
  }

  refreshHighlight() {
    if (!this.selected) { this.highlight.visible = false; return; }
    const box = this.getSelectedBounds();
    this.highlight.visible = !box.isEmpty();
    if (this.highlight.visible) {
      this.highlight.box.copy(box);
      this.highlight.updateMatrixWorld(true);
    }
  }

  focusSelected() {
    if (!this.selected) { this.onStatus('Nothing selected to focus'); return false; }
    const box = this.getSelectedBounds();
    if (box.isEmpty()) { this.onStatus(`${this.selected.name} has metadata only; no visual bounds to frame`); return false; }
    this.adapter.setChunkMode('nearby', box.getCenter(new THREE.Vector3()));
    const focused = this.viewport.focusOn(box);
    if (focused) this.onStatus(`Focused ${this.selected.name}`);
    return focused;
  }

  dispose() {
    this.viewport.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.viewport.canvas.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    this.highlight.removeFromParent();
    this.highlight.geometry.dispose();
    this.highlight.material.dispose();
  }
}
