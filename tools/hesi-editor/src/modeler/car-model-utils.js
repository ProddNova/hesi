import * as THREE from 'three';
import { MESH_MAX_FACES, MESH_MAX_TRIANGLES, MESH_MAX_VERTICES } from '/js/custom-assets.js';

function safeFaceNames(materials) {
  const used = new Set();
  return materials.slice(0, MESH_MAX_FACES).map((material, index) => {
    const base = String(material?.name || `surface ${index + 1}`)
      .replace(/[^a-z0-9_ -]+/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 34) || `surface ${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base.slice(0, 34)} ${suffix}`;
      suffix += 1;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

function materialStyles(materials, faceNames) {
  return Object.fromEntries(faceNames.map((faceName, index) => {
    const material = materials[index] || materials[0];
    const style = {};
    if (material?.color?.getHexString) style.color = `#${material.color.getHexString()}`;
    if (material?.emissive?.getHexString && material.emissive.getHex() !== 0) {
      style.emissive = `#${material.emissive.getHexString()}`;
    }
    // OBJ car bodies contain deliberate open panel edges and stacked detail
    // sheets. Treat them as open meshes so the topology watchdog does not
    // mistake those authored boundaries for cracks in a closed solid.
    style.doubleSide = true;
    return [faceName, style];
  }));
}

function materialIndexAt(groups, corner) {
  for (const group of groups) {
    if (corner >= group.start && corner < group.start + group.count) return group.materialIndex || 0;
  }
  return 0;
}

function transformedPoint(position, index, matrix, target) {
  return target.set(position.getX(index), position.getY(index), position.getZ(index)).applyMatrix4(matrix);
}

/**
 * Turns an already loaded Three.js car into normal Modeler mesh parts.
 *
 * Geometry is baked into the car root's local pose (including the PSX pack's
 * forward-axis correction), welded by position, and split before the document
 * mesh limits. Per-corner UVs and material colours survive the conversion.
 * Instanced wheels are expanded so every wheel can be selected independently.
 */
export function editablePartsFromCarObject(root) {
  if (!root) return [];
  root.updateMatrixWorld(true);
  const sources = [];
  const instanceMatrix = new THREE.Matrix4();
  const bakedMatrix = new THREE.Matrix4();

  root.traverse((child) => {
    if (!child.isMesh || !child.geometry?.getAttribute?.('position')) return;
    if (child.isInstancedMesh) {
      for (let index = 0; index < child.count; index += 1) {
        child.getMatrixAt(index, instanceMatrix);
        sources.push({
          child,
          matrix: bakedMatrix.multiplyMatrices(child.matrixWorld, instanceMatrix).clone(),
          suffix: ` ${index + 1}`,
        });
      }
    } else {
      sources.push({ child, matrix: child.matrixWorld.clone(), suffix: '' });
    }
  });

  const parts = [];
  const point = new THREE.Vector3();
  for (const source of sources) {
    const geometry = source.child.geometry;
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    const index = geometry.index;
    const cornerCount = index ? index.count : position.count;
    const groups = geometry.groups?.length
      ? geometry.groups
      : [{ start: 0, count: cornerCount, materialIndex: 0 }];
    const materials = (Array.isArray(source.child.material) ? source.child.material : [source.child.material])
      .slice(0, MESH_MAX_FACES);
    const faceNames = safeFaceNames(materials.length ? materials : [null]);
    const faces = materialStyles(materials, faceNames);
    let chunkIndex = 0;
    let vertices = [];
    let triangles = [];
    let vertexBySource = new Map();

    const flush = () => {
      if (!triangles.length) return;
      chunkIndex += 1;
      const suffix = chunkIndex > 1 ? ` ${chunkIndex}` : '';
      parts.push({
        kind: 'mesh',
        name: `${source.child.name || 'Car mesh'}${source.suffix}${suffix}`.slice(0, 80),
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        color: '#9aa7b5',
        vertices,
        triangles,
        faceNames: [...faceNames],
        faces: structuredClone(faces),
      });
      vertices = [];
      triangles = [];
      vertexBySource = new Map();
    };

    for (let corner = 0; corner + 2 < cornerCount; corner += 3) {
      const sourceIndices = [0, 1, 2].map((offset) => index ? index.getX(corner + offset) : corner + offset);
      const transformed = sourceIndices.map((sourceIndex) => {
        const value = transformedPoint(position, sourceIndex, source.matrix, point).toArray();
        // Preserve the BufferGeometry index identity. Welding only by equal
        // coordinates collapses separate body panels/detail sheets onto one
        // non-manifold edge (several OBJ triangles can intentionally occupy
        // the same point without belonging to the same surface).
        return { sourceIndex, value, key: String(sourceIndex) };
      });
      const newKeys = new Set(transformed.filter((entry) => !vertexBySource.has(entry.key)).map((entry) => entry.key));
      if (triangles.length >= MESH_MAX_TRIANGLES || vertices.length + newKeys.size > MESH_MAX_VERTICES) flush();

      const triangleVertices = transformed.map((entry) => {
        let vertexIndex = vertexBySource.get(entry.key);
        if (vertexIndex === undefined) {
          vertexIndex = vertices.length;
          vertices.push(entry.value);
          vertexBySource.set(entry.key, vertexIndex);
        }
        return vertexIndex;
      });
      if (new Set(triangleVertices).size !== 3) continue;
      const face = Math.min(materialIndexAt(groups, corner), faceNames.length - 1);
      const triangle = { v: triangleVertices, face };
      if (uv) triangle.uv = sourceIndices.map((sourceIndex) => [uv.getX(sourceIndex), uv.getY(sourceIndex)]);
      triangles.push(triangle);
    }
    flush();
  }
  return parts;
}

export function carDefinitionFromVisual(visual, {
  id,
  label,
  description,
} = {}) {
  const parts = editablePartsFromCarObject(visual);
  if (!parts.length) throw new Error(`${label || 'Car'} contains no editable mesh geometry`);
  return {
    id,
    label: `${label || 'Player car'} custom`,
    description: description || `Editable replacement for ${label || 'the player car'}`,
    layer: 'Vehicles',
    createdAt: new Date().toISOString(),
    parts,
  };
}
