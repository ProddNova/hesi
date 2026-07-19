import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { anchorShiftForScale, applyEntityTransform, snapshotTransform, sourceTransformFor, transformsEqual } from './entity-transform.js';

function clone(value) { return value == null ? value : structuredClone(value); }

export class TransformManager {
  constructor({ viewport, history, projectState, registry, onChange = () => {}, onStatus = () => {}, onDraggingChange = () => {} }) {
    this.viewport = viewport;
    this.history = history;
    this.projectState = projectState;
    this.registry = registry;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.onDraggingChange = onDraggingChange;
    this.entity = null;
    this.dragStart = null;
    this.scaleAnchor = null;
    this.dragMode = null;
    this.mode = 'translate';
    this.space = 'world';
    this.axes = { x: true, y: true, z: true };
    this.control = new TransformControls(viewport.camera, viewport.canvas);
    this.control.name = 'Editor transform gizmo';
    this.control.userData.editorHelper = true;
    this.control.visible = false;
    viewport.scene.add(this.control);

    this._onMouseDown = () => {
      if (!this.entity) return;
      if (this.dragStart) this._completeDrag();
      this.dragStart = snapshotTransform(this.entity.object3D);
      this.dragMode = this.mode;
      this.scaleAnchor = this.mode === 'scale' ? this._makeScaleAnchor(this.entity) : null;
      this.viewport.setNavigationBlocked(true, this);
      this.onDraggingChange(true);
    };
    this._onObjectChange = () => {
      if (!this.entity) return;
      this._anchorScaleDrag();
      applyEntityTransform(this.entity, snapshotTransform(this.entity.object3D));
      this.entity.metadata.hasOverride = true;
      this.onChange(this.entity, { live: true });
    };
    this._onMouseUp = () => this._completeDrag();
    this._recoverInterruptedDrag = () => this.finishActiveDrag();
    this.control.addEventListener('mouseDown', this._onMouseDown);
    this.control.addEventListener('objectChange', this._onObjectChange);
    this.control.addEventListener('mouseUp', this._onMouseUp);
    viewport.canvas.addEventListener('pointercancel', this._recoverInterruptedDrag);
    viewport.canvas.addEventListener('lostpointercapture', this._recoverInterruptedDrag);
    window.addEventListener('blur', this._recoverInterruptedDrag);
    this._onVisibilityChange = () => { if (document.hidden) this._recoverInterruptedDrag(); };
    document.addEventListener('visibilitychange', this._onVisibilityChange);
  }

  _completeDrag() {
    this.viewport.setNavigationBlocked(false, this);
    this.onDraggingChange(false);
    this.scaleAnchor = null;
    const entity = this.entity;
    const before = this.dragStart;
    const mode = this.dragMode || this.mode;
    this.dragStart = null;
    this.dragMode = null;
    if (!entity || !before) return false;
    const after = snapshotTransform(entity.object3D);
    if (transformsEqual(before, after)) return false;
    this.commitTransform(before, after, `${mode[0].toUpperCase()}${mode.slice(1)} ${entity.name}`, { alreadyApplied: true });
    return true;
  }

  finishActiveDrag() {
    const active = Boolean(this.dragStart || this.control.dragging);
    if (!active) return false;
    // TransformControls does not recover its state from pointercancel/blur.
    // Its pointerUp method resets dragging/axis and emits the normal mouseUp,
    // so interrupted and ordinary drags share exactly one commit path.
    if (this.control.dragging) this.control.pointerUp(null);
    else this._completeDrag();
    return true;
  }

  // Bounds of the dragged entity expressed in the object's local frame, so a
  // single-axis scale drag can keep the opposite face fixed in world space.
  _makeScaleAnchor(entity) {
    const object = entity?.object3D;
    if (!object) return null;
    object.updateWorldMatrix(true, false);
    const inverse = object.matrixWorld.clone().invert();
    const localBox = new THREE.Box3().makeEmpty();
    const corner = new THREE.Vector3();
    const addGeometry = (geometry, worldMatrix) => {
      if (!geometry) return;
      geometry.computeBoundingBox?.();
      const box = geometry.boundingBox;
      if (!box || box.isEmpty()) return;
      for (let i = 0; i < 8; i += 1) {
        corner.set(
          i & 1 ? box.max.x : box.min.x,
          i & 2 ? box.max.y : box.min.y,
          i & 4 ? box.max.z : box.min.z,
        ).applyMatrix4(worldMatrix).applyMatrix4(inverse);
        localBox.expandByPoint(corner);
      }
    };
    object.traverse?.((child) => {
      if (!child.geometry) return;
      child.updateWorldMatrix(true, false);
      addGeometry(child.geometry, child.matrixWorld);
    });
    // Generated instances use a transform-only proxy. Its source geometry is
    // already expressed in the proxy's local frame.
    if (localBox.isEmpty()) addGeometry(entity.metadata?.instanceMesh?.geometry, object.matrixWorld);
    if (localBox.isEmpty()) return null;
    return { localMin: localBox.min.toArray(), localMax: localBox.max.toArray() };
  }

  // One-sided scaling: set the position from the drag-start position plus the
  // anchor shift (idempotent — safe to run on every objectChange of the drag).
  _anchorScaleDrag() {
    if (!this.scaleAnchor || this.mode !== 'scale' || !this.dragStart) return;
    const axis = { X: 'x', Y: 'y', Z: 'z' }[this.control.axis];
    if (!axis) return; // XYZ center handle keeps symmetric scaling
    const object = this.entity.object3D;
    const shift = anchorShiftForScale(axis, this.dragStart.scale, object.scale.toArray(), this.scaleAnchor.localMin, object.quaternion);
    if (!shift) return;
    const base = this.dragStart.position;
    object.position.set(base[0] + shift[0], base[1] + shift[1], base[2] + shift[2]);
  }

  setSelection(entity) {
    this.finishActiveDrag();
    if (this.entity?.object3D?.userData?.editorInstanceProxy) this.entity.object3D.removeFromParent();
    this.control.detach();
    this.entity = entity || null;
    const editable = entity?.editable && entity.object3D && !entity.metadata?.locked && !entity.metadata?.disabled;
    this.control.visible = Boolean(editable);
    if (!editable) { this.onChange(entity); return false; }
    sourceTransformFor(entity);
    if (entity.object3D.userData.editorInstanceProxy && !entity.object3D.parent) this.viewport.scene.add(entity.object3D);
    this.control.attach(entity.object3D);
    this.onChange(entity);
    return true;
  }

  setMode(mode) {
    if (!['translate', 'rotate', 'scale'].includes(mode)) return false;
    this.mode = mode;
    this.control.setMode(mode);
    this.onChange(this.entity);
    return true;
  }

  setSpace(space) {
    if (!['local', 'world'].includes(space)) return false;
    this.space = space;
    this.control.setSpace(space);
    this.onChange(this.entity);
    return true;
  }

  setAxes({ x = this.axes.x, y = this.axes.y, z = this.axes.z } = {}) {
    this.axes = { x: Boolean(x), y: Boolean(y), z: Boolean(z) };
    this.control.showX = this.axes.x;
    this.control.showY = this.axes.y;
    this.control.showZ = this.axes.z;
    this.onChange(this.entity);
  }

  setSnaps(snaps = {}) {
    if (Object.hasOwn(snaps, 'translate')) this.control.setTranslationSnap(Number(snaps.translate) > 0 ? Number(snaps.translate) : null);
    if (Object.hasOwn(snaps, 'rotateDegrees')) this.control.setRotationSnap(Number(snaps.rotateDegrees) > 0 ? THREE.MathUtils.degToRad(Number(snaps.rotateDegrees)) : null);
    if (Object.hasOwn(snaps, 'scale')) this.control.setScaleSnap(Number(snaps.scale) > 0 ? Number(snaps.scale) : null);
    this.onChange(this.entity);
  }

  applyNumeric(transform, label = 'Edit transform') {
    if (!this.entity?.editable || this.entity.metadata?.locked) return false;
    const before = snapshotTransform(this.entity.object3D);
    const after = clone(transform);
    if (transformsEqual(before, after)) return false;
    this.commitTransform(before, after, `${label} · ${this.entity.name}`);
    return true;
  }

  applyComponents({ position, rotationDegrees, scale }, label = 'Edit numeric transform') {
    if (!this.entity?.object3D) return false;
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(
      ...rotationDegrees.map((value) => THREE.MathUtils.degToRad(Number(value))),
      this.entity.object3D.rotation.order,
    ));
    return this.applyNumeric({
      position: position.map(Number),
      quaternion: quaternion.toArray(),
      scale: scale.map(Number),
    }, label);
  }

  commitTransform(before, after, label, { alreadyApplied = false } = {}) {
    const entity = this.entity;
    const previousOverride = this.projectState.getOverride(entity.id);
    const apply = (transform, override) => {
      applyEntityTransform(entity, transform);
      entity.metadata.hasOverride = !transformsEqual(transform, sourceTransformFor(entity));
      this.projectState.replaceOverride(entity.id, override);
      if (!entity.generated) this.projectState.updatePlaced(entity.id, { transform: clone(transform) });
      this.registry.update(entity.id, { metadata: entity.metadata });
      this.onChange(entity);
    };
    const nextOverride = { ...(previousOverride || {}), transform: clone(after) };
    this.history.execute({
      label,
      redo: () => apply(after, nextOverride),
      undo: () => apply(before, previousOverride),
    }, { alreadyApplied });
    if (alreadyApplied) {
      entity.metadata.hasOverride = true;
      this.projectState.replaceOverride(entity.id, nextOverride);
      if (!entity.generated) this.projectState.updatePlaced(entity.id, { transform: clone(after) });
      this.registry.update(entity.id, { metadata: entity.metadata });
      this.onChange(entity);
    }
    this.onStatus(label);
  }

  state() {
    return {
      mode: this.mode,
      space: this.space,
      axes: { ...this.axes },
      translateSnap: this.control.translationSnap,
      rotateSnapDegrees: this.control.rotationSnap ? THREE.MathUtils.radToDeg(this.control.rotationSnap) : null,
      scaleSnap: this.control.scaleSnap,
      attached: Boolean(this.control.object),
    };
  }

  dispose() {
    this.finishActiveDrag();
    this.control.removeEventListener('mouseDown', this._onMouseDown);
    this.control.removeEventListener('objectChange', this._onObjectChange);
    this.control.removeEventListener('mouseUp', this._onMouseUp);
    this.viewport.canvas.removeEventListener('pointercancel', this._recoverInterruptedDrag);
    this.viewport.canvas.removeEventListener('lostpointercapture', this._recoverInterruptedDrag);
    window.removeEventListener('blur', this._recoverInterruptedDrag);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this.setSelection(null);
    this.control.dispose();
    this.control.removeFromParent();
  }
}
