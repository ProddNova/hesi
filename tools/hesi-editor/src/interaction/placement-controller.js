import * as THREE from 'three';
import { isEditorHelper } from './selection-manager.js';

function isActuallyVisible(object) {
  let current = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

/**
 * Click-to-place mode for new assets. While active, left-click in the viewport
 * raycasts onto real world geometry and places the pending asset there;
 * Escape cancels. Listeners run on `window` in the capture phase so they
 * pre-empt viewport selection, orbit controls, and the transform gizmo.
 */
export class PlacementController {
  constructor({ viewport, adapter, editActions, transformManager, gridSnap = null, onChange = () => {}, onStatus = () => {} }) {
    this.viewport = viewport;
    this.adapter = adapter;
    this.editActions = editActions;
    this.transformManager = transformManager;
    this.gridSnap = gridSnap;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.pending = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this._onPointerDown = (event) => {
      if (!this.pending || event.target !== this.viewport.canvas) return;
      event.preventDefault();
      event.stopPropagation();
    };
    this._onPointerUp = (event) => {
      if (!this.pending || event.target !== this.viewport.canvas || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this._placeAt(event.clientX, event.clientY);
    };
    this._onKeyDown = (event) => {
      if (!this.pending || event.code !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.cancel();
    };
    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('pointerup', this._onPointerUp, { capture: true });
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
  }

  get active() { return Boolean(this.pending); }

  begin(assetId, label) {
    if (this.pending?.assetId === assetId) { this.cancel(); return false; }
    this._end();
    this.transformManager.finishActiveDrag?.();
    this.pending = { assetId, label: label || assetId };
    if (this.viewport.navigationMode === 'fly') this.viewport.setNavigationMode('orbit');
    this.transformManager.control.enabled = false;
    this.onChange(true, this.pending.label);
    this.onStatus(`Placing ${this.pending.label}: click a surface in the world · Esc to cancel`);
    return true;
  }

  cancel() {
    if (!this.pending) return false;
    const { label } = this.pending;
    this._end();
    this.onStatus(`Placement cancelled · ${label}`);
    return true;
  }

  _end() {
    this.pending = null;
    this.transformManager.control.enabled = true;
    this.onChange(false);
  }

  _placeAt(clientX, clientY) {
    const rect = this.viewport.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.viewport.camera);
    const hits = this.raycaster.intersectObject(this.adapter.group, true);
    const hit = hits.find((candidate) => !isEditorHelper(candidate.object) && isActuallyVisible(candidate.object));
    if (!hit) {
      this.onStatus('No world surface under the cursor — click on visible geometry to place');
      return;
    }
    const { assetId } = this.pending;
    // Grid snap applies in plan view only: the clicked surface keeps the height.
    const point = this.gridSnap ? this.gridSnap.snapPosition(hit.point.clone()) : hit.point.clone();
    const placed = this.editActions.placeAsset(assetId, point);
    if (placed) this._end();
  }

  dispose() {
    this._end();
    window.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.removeEventListener('pointerup', this._onPointerUp, { capture: true });
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
  }
}
