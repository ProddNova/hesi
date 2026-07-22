import * as THREE from 'three';

const EPSILON = 1e-7;

export function snapshotTransform(object) {
  return {
    position: object.position.toArray(),
    quaternion: object.quaternion.toArray(),
    scale: object.scale.toArray(),
  };
}

export function transformsEqual(a, b, epsilon = EPSILON) {
  if (!a || !b) return false;
  return ['position', 'quaternion', 'scale'].every((key) =>
    a[key].length === b[key].length && a[key].every((value, index) => Math.abs(value - b[key][index]) <= epsilon));
}

export function applyTransformToObject(object, transform) {
  object.position.fromArray(transform.position);
  object.quaternion.fromArray(transform.quaternion).normalize();
  object.scale.fromArray(transform.scale);
  object.updateMatrix();
  object.updateMatrixWorld(true);
}

/**
 * Matrix4.decompose cannot derive a rotation from a zero-scale matrix: its
 * normalization divides by zero and leaves the quaternion full of NaNs. The
 * generated map deliberately contains zero-scale tombstones so removing an
 * instance does not renumber every saved editor reference after it. Give
 * those records a finite proxy transform; their lost rotation is immaterial
 * while every scale axis is zero.
 */
export function decomposeFiniteMatrix(matrix, position, quaternion, scale) {
  matrix.decompose(position, quaternion, scale);
  const finite = (values) => values.every(Number.isFinite);
  if (finite(position.toArray()) && finite(quaternion.toArray()) && finite(scale.toArray())) return true;
  const elements = matrix.elements;
  position.set(
    Number.isFinite(elements[12]) ? elements[12] : 0,
    Number.isFinite(elements[13]) ? elements[13] : 0,
    Number.isFinite(elements[14]) ? elements[14] : 0,
  );
  const signedX = matrix.determinant() < 0 ? -1 : 1;
  scale.set(
    signedX * Math.hypot(elements[0], elements[1], elements[2]),
    Math.hypot(elements[4], elements[5], elements[6]),
    Math.hypot(elements[8], elements[9], elements[10]),
  );
  if (!finite(scale.toArray())) scale.set(0, 0, 0);
  quaternion.identity();
  return false;
}

function componentWorldMatrices(entity, targetTransform) {
  const baseSource = new THREE.Matrix4().fromArray(entity.metadata.sourceWorldMatrix);
  const baseTarget = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(targetTransform.position),
    new THREE.Quaternion().fromArray(targetTransform.quaternion),
    new THREE.Vector3().fromArray(targetTransform.scale),
  );
  const determinant = baseSource.determinant();
  let delta;
  if (Number.isFinite(determinant) && Math.abs(determinant) > EPSILON) {
    delta = baseTarget.multiply(baseSource.clone().invert());
  } else {
    // A zero-scale tombstone has no invertible basis. Preserve its component
    // matrices and apply only a possible proxy translation; rotation/scale
    // cannot restore information the zero matrix no longer contains.
    const from = new THREE.Vector3().setFromMatrixPosition(baseSource);
    const to = new THREE.Vector3().fromArray(targetTransform.position);
    delta = new THREE.Matrix4().makeTranslation(to.x - from.x, to.y - from.y, to.z - from.z);
  }
  return entity.metadata.instanceComponents.map((component) => ({
    ...component,
    worldMatrix: delta.clone().multiply(new THREE.Matrix4().fromArray(component.sourceWorldMatrix)),
  }));
}

export function applyEntityTransform(entity, transform, { visible = !entity.metadata?.disabled } = {}) {
  if (!entity?.object3D || !transform) return false;
  applyTransformToObject(entity.object3D, transform);
  const components = entity.metadata?.instanceComponents;
  if (!components?.length) {
    entity.object3D.visible = visible;
    return true;
  }
  for (const component of componentWorldMatrices(entity, transform)) {
    const mesh = component.mesh;
    mesh.updateWorldMatrix(true, false);
    const local = mesh.matrixWorld.clone().invert().multiply(component.worldMatrix);
    if (!visible) {
      // Do not decompose here: a component may already be a zero-scale
      // tombstone, for which Matrix4.decompose creates a NaN quaternion.
      // Rotation is irrelevant at zero scale, so retain only translation.
      const elements = local.elements;
      const x = Number.isFinite(elements[12]) ? elements[12] : 0;
      const y = Number.isFinite(elements[13]) ? elements[13] : 0;
      const z = Number.isFinite(elements[14]) ? elements[14] : 0;
      local.set(
        0, 0, 0, x,
        0, 0, 0, y,
        0, 0, 0, z,
        0, 0, 0, 1,
      );
    }
    mesh.setMatrixAt(component.instanceIndex, local);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox?.();
    mesh.computeBoundingSphere?.();
  }
  return true;
}

export function setEntityVisible(entity, visible) {
  entity.metadata.disabled = !visible;
  return applyEntityTransform(entity, snapshotTransform(entity.object3D), { visible });
}

export function sourceTransformFor(entity) {
  if (!entity.metadata.editorSourceName) entity.metadata.editorSourceName = entity.name;
  if (entity.metadata?.editorSourceTransform) return structuredClone(entity.metadata.editorSourceTransform);
  const source = snapshotTransform(entity.object3D);
  entity.metadata.editorSourceTransform = structuredClone(source);
  return source;
}

/**
 * One-sided gizmo scaling. When a single-axis scale handle is dragged, keep
 * the opposite face of the object's bounds fixed in world space by shifting
 * the position by R·(S0−S1)·a, where `a` is the local-space bounds min corner
 * on that axis and R the object's local rotation (position lives in parent
 * space, so the shift is rotated by the local quaternion only).
 *
 * Returns the position delta [x, y, z] relative to the drag-start position,
 * or null when the axis is not a single axis (e.g. the XYZ center handle,
 * which keeps symmetric scaling).
 */
export function anchorShiftForScale(axis, startScale, nextScale, localBoundsMin, quaternion) {
  const index = { x: 0, y: 1, z: 2 }[axis];
  if (index == null) return null;
  if (!startScale || !nextScale || !localBoundsMin || !quaternion) return null;
  const delta = (startScale[index] - nextScale[index]) * localBoundsMin[index];
  if (!Number.isFinite(delta) || delta === 0) return [0, 0, 0];
  const local = new THREE.Vector3();
  local.setComponent(index, delta);
  return local.applyQuaternion(quaternion).toArray();
}
