import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { applyEntityTransform, snapshotTransform, sourceTransformFor, transformsEqual } from './entity-transform.js';

function clone(value) { return value == null ? value : structuredClone(value); }

export class TransformManager {
  constructor({ viewport, history, projectState, registry, onChange = () => {}, onStatus = () => {} }) {
    this.viewport = viewport;
    this.history = history;
    this.projectState = projectState;
    this.registry = registry;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.entity = null;
    this.dragStart = null;
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
      this.dragStart = snapshotTransform(this.entity.object3D);
      this.viewport.setNavigationBlocked(true);
    };
    this._onObjectChange = () => {
      if (!this.entity) return;
      applyEntityTransform(this.entity, snapshotTransform(this.entity.object3D));
      this.entity.metadata.hasOverride = true;
      this.onChange(this.entity, { live: true });
    };
    this._onMouseUp = () => {
      this.viewport.setNavigationBlocked(false);
      if (!this.entity || !this.dragStart) return;
      const before = this.dragStart;
      const after = snapshotTransform(this.entity.object3D);
      this.dragStart = null;
      if (!transformsEqual(before, after)) this.commitTransform(before, after, `${this.mode[0].toUpperCase()}${this.mode.slice(1)} ${this.entity.name}`, { alreadyApplied: true });
    };
    this.control.addEventListener('mouseDown', this._onMouseDown);
    this.control.addEventListener('objectChange', this._onObjectChange);
    this.control.addEventListener('mouseUp', this._onMouseUp);
  }

  setSelection(entity) {
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
    this.control.removeEventListener('mouseDown', this._onMouseDown);
    this.control.removeEventListener('objectChange', this._onObjectChange);
    this.control.removeEventListener('mouseUp', this._onMouseUp);
    this.setSelection(null);
    this.control.dispose();
    this.control.removeFromParent();
  }
}
