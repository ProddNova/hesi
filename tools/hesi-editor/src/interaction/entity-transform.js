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
