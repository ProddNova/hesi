import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
const SPEEDS = Object.freeze({ slow: 8, normal: 45, fast: 180 });

export class FlyCameraController {
  constructor(camera, canvas, { onChange = () => {} } = {}) {
    this.camera = camera;
    this.canvas = canvas;
    this.onChange = onChange;
    this.enabled = false;
    this.blocked = false;
    this.speed = SPEEDS.normal;
    this.speedPreset = 'normal';
    this.keys = new Set();
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();

    this._onKeyDown = (event) => {
      if (!this.enabled || this.blocked || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ShiftLeft', 'ShiftRight', 'CapsLock'].includes(event.code)) {
        this.keys.add(event.code);
        event.preventDefault();
      }
    };
    this._onKeyUp = (event) => this.keys.delete(event.code);
    this._onBlur = () => this.clearInput();
    this._onMouseMove = (event) => {
      if (!this.enabled || this.blocked || document.pointerLockElement !== this.canvas) return;
      this.euler.setFromQuaternion(this.camera.quaternion);
      this.euler.y -= event.movementX * 0.0022;
      this.euler.x = THREE.MathUtils.clamp(this.euler.x - event.movementY * 0.0022, -Math.PI * 0.495, Math.PI * 0.495);
      this.camera.quaternion.setFromEuler(this.euler);
    };
    this._onCanvasClick = () => {
      if (!this.enabled || this.blocked || document.pointerLockElement === this.canvas) return;
      try { this.canvas.requestPointerLock?.(); } catch { /* Browser may deny an untrusted request. */ }
    };
    this._onWheel = (event) => {
      if (!this.enabled || this.blocked) return;
      event.preventDefault();
      this.setSpeed(this.speed * (event.deltaY < 0 ? 1.18 : 1 / 1.18));
    };
    this._onPointerLock = () => this._emit();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLock);
    canvas.addEventListener('click', this._onCanvasClick);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
  }

  _emit() {
    this.onChange({
      enabled: this.enabled,
      locked: document.pointerLockElement === this.canvas,
      speed: this.speed,
      speedPreset: this.speedPreset,
    });
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.keys.clear();
    if (!this.enabled && document.pointerLockElement === this.canvas) document.exitPointerLock?.();
    this._emit();
  }

  setBlocked(blocked) {
    this.blocked = Boolean(blocked);
    if (this.blocked) this.clearInput();
  }

  clearInput() { this.keys.clear(); }

  setSpeed(value, preset = null) {
    const number = Number(value);
    if (!Number.isFinite(number)) return false;
    this.speed = THREE.MathUtils.clamp(number, 1, 600);
    this.speedPreset = preset || Object.entries(SPEEDS).find(([, speed]) => Math.abs(speed - this.speed) < 0.001)?.[0] || 'custom';
    this._emit();
    return true;
  }

  setSpeedPreset(preset) {
    if (!(preset in SPEEDS)) return false;
    return this.setSpeed(SPEEDS[preset], preset);
  }

  update(deltaSeconds) {
    if (!this.enabled || this.blocked || deltaSeconds <= 0) return;
    this.camera.getWorldDirection(this._forward);
    this._forward.y = 0;
    if (this._forward.lengthSq() < 1e-8) this._forward.set(0, 0, -1);
    this._forward.normalize();
    this._right.crossVectors(this._forward, UP).normalize();
    this._move.set(0, 0, 0);
    if (this.keys.has('KeyW')) this._move.add(this._forward);
    if (this.keys.has('KeyS')) this._move.sub(this._forward);
    if (this.keys.has('KeyD')) this._move.add(this._right);
    if (this.keys.has('KeyA')) this._move.sub(this._right);
    if (this.keys.has('KeyE') || this.keys.has('Space')) this._move.y += 1;
    // CapsLock descends: Ctrl combos are browser-reserved, so Ctrl cannot own
    // vertical movement reliably.
    if (this.keys.has('KeyQ') || this.keys.has('CapsLock')) this._move.y -= 1;
    if (this._move.lengthSq()) {
      const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 4 : 1;
      this.camera.position.addScaledVector(this._move.normalize(), this.speed * boost * deltaSeconds);
    }
  }

  dispose() {
    this.setEnabled(false);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLock);
    this.canvas.removeEventListener('click', this._onCanvasClick);
    this.canvas.removeEventListener('wheel', this._onWheel);
  }
}

export { SPEEDS as FLY_SPEED_PRESETS };
