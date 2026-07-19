/**
 * Shared grid-snap state for the map editor.
 *
 * One toggle + step drives every position-producing interaction: the
 * transform gizmo (via TransformManager.setSnaps), click-to-place asset
 * placement, and road centreline point drags/inserts. Pure logic with a
 * change callback so the shell UI, keyboard shortcut, and controllers all
 * observe the same state; nothing here imports three.js or touches the DOM.
 */

export const GRID_SNAP_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10];
export const GRID_SNAP_ROTATE_DEGREES = 15;
export const GRID_SNAP_SCALE = 0.1;

export class GridSnap {
  constructor({ enabled = false, step = 1, onChange = () => {} } = {}) {
    this.enabled = Boolean(enabled);
    this.step = Number(step) > 0 ? Number(step) : 1;
    this.onChange = onChange;
  }

  state() {
    return { enabled: this.enabled, step: this.step };
  }

  setEnabled(enabled) {
    enabled = Boolean(enabled);
    if (enabled === this.enabled) return false;
    this.enabled = enabled;
    this.onChange(this.state());
    return true;
  }

  toggle() {
    return this.setEnabled(!this.enabled) && this.enabled;
  }

  setStep(step) {
    step = Number(step);
    if (!(step > 0) || step === this.step) return false;
    this.step = step;
    this.onChange(this.state());
    return true;
  }

  /** Snaps one scalar to the grid; passthrough while disabled. */
  snapValue(value) {
    if (!this.enabled || !Number.isFinite(value)) return value;
    return Math.round(value / this.step) * this.step;
  }

  /**
   * Snaps a horizontal position to the grid in place. The grid is a plan-view
   * (XZ) lattice: surfaces decide the height, so y is never touched. Accepts
   * any {x, z} object (THREE.Vector3 included) and returns it.
   */
  snapPosition(position) {
    if (!this.enabled || !position) return position;
    position.x = this.snapValue(position.x);
    position.z = this.snapValue(position.z);
    return position;
  }

  /** Gizmo snap set for TransformManager.setSnaps: grid step + fixed angles. */
  gizmoSnaps() {
    return this.enabled
      ? { translate: this.step, rotateDegrees: GRID_SNAP_ROTATE_DEGREES, scale: GRID_SNAP_SCALE }
      : { translate: null, rotateDegrees: null, scale: null };
  }
}
