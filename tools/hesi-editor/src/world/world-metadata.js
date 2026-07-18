import * as THREE from 'three';

export function triangleCount(object, perInstance = false) {
  const geometry = object?.geometry;
  if (!geometry) return 0;
  const base = Math.floor((geometry.index?.count || geometry.getAttribute('position')?.count || 0) / 3);
  return perInstance ? base : base * (object.isInstancedMesh ? object.count : 1);
}

export function objectRenderMetadata(object, { instance = false, repeatedAssetCount = null } = {}) {
  const meshes = [];
  object?.traverse?.((child) => { if (child.isMesh) meshes.push(child); });
  if (object?.isMesh && !meshes.includes(object)) meshes.push(object);
  const materials = new Set();
  const textures = new Set();
  let triangles = 0;
  for (const mesh of meshes) {
    triangles += triangleCount(mesh, instance);
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
      if (!material) continue;
      materials.add(material.name || material.type || 'unnamed material');
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'alphaMap']) {
        if (material[key]) textures.add(material[key].name || material[key].source?.data?.currentSrc || `${key} texture`);
      }
    }
  }
  return {
    meshCount: meshes.length,
    triangleCount: triangles,
    materialNames: [...materials].sort(),
    textureReferences: [...textures].sort(),
    renderOrder: object?.renderOrder ?? 0,
    castShadow: meshes.some((mesh) => mesh.castShadow),
    receiveShadow: meshes.some((mesh) => mesh.receiveShadow),
    instanced: Boolean(object?.isInstancedMesh || meshes.some((mesh) => mesh.isInstancedMesh)),
    repeatedAssetCount: repeatedAssetCount ?? (object?.isInstancedMesh ? object.count : 1),
    drawCallContribution: object?.isInstancedMesh || instance ? 1 : Math.max(1, meshes.length),
    geometryShared: Boolean(object?.isInstancedMesh || instance),
    materialShared: Boolean(object?.isInstancedMesh || instance),
    lod: 'Unavailable: runtime generator does not expose LOD levels',
  };
}

export function boxForObject(object) {
  if (!object) return new THREE.Box3();
  return new THREE.Box3().setFromObject(object);
}

export function boxForInstance(mesh, instanceIndex) {
  const geometry = mesh.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const matrix = new THREE.Matrix4();
  mesh.getMatrixAt(instanceIndex, matrix);
  mesh.updateWorldMatrix(true, false);
  matrix.premultiply(mesh.matrixWorld);
  return geometry.boundingBox.clone().applyMatrix4(matrix);
}

export function instanceWorldMatrix(mesh, instanceIndex, target = new THREE.Matrix4()) {
  mesh.getMatrixAt(instanceIndex, target);
  mesh.updateWorldMatrix(true, false);
  return target.premultiply(mesh.matrixWorld);
}

export function sourceTransform(object) {
  return {
    position: object.position.toArray(),
    rotation: object.rotation.toArray().slice(0, 3),
    scale: object.scale.toArray(),
  };
}
