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

function componentWorldMatrices(entity, targetTransform) {
  const baseSource = new THREE.Matrix4().fromArray(entity.metadata.sourceWorldMatrix);
  const baseTarget = new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(targetTransform.position),
    new THREE.Quaternion().fromArray(targetTransform.quaternion),
    new THREE.Vector3().fromArray(targetTransform.scale),
  );
  const delta = baseTarget.multiply(baseSource.clone().invert());
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
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      local.decompose(position, quaternion, new THREE.Vector3());
      local.compose(position, quaternion, new THREE.Vector3(0, 0, 0));
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
