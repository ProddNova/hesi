import * as THREE from 'three';

// Custom modeled assets — shared between the game and the HESI world editor.
//
// The editor's Modeler section saves PSX-style low-poly objects (simple
// primitive parts, per-face image textures, optional vertex tweaks, and
// assembled world-asset parts) into data/editor/custom-assets.json. This
// module is the single builder both sides use so a saved object looks the
// same in the editor viewport and in the playable game.
//
// The same document also carries world texture overrides (for example a
// custom repeated road/asphalt image) applied to the generated map materials.

export const CUSTOM_ASSETS_URL = 'data/editor/custom-assets.json';
export const CUSTOM_ASSETS_VERSION = 1;
export const CUSTOM_ASSET_ID_PATTERN = /^custom:[a-z0-9][a-z0-9_-]{0,80}$/i;
export const CUSTOM_TEXTURE_ID_PATTERN = /^tex:[a-z0-9][a-z0-9_-]{0,80}$/i;

// Generated-map materials that accept a repeated texture override. Every key
// exists in HighwayMap._createMaterials(); road surfaces carry world-anchored
// UVs (see applyWorldSurfaceUVs in js/map.js) so one image repeat covers a
// fixed number of metres of asphalt everywhere.
export const WORLD_TEXTURE_SLOTS = Object.freeze({
  road: { label: 'Road asphalt', description: 'Main highway surface (tiled at one fixed world scale)' },
  roadAlt: { label: 'Road asphalt (alt)', description: 'Alternate asphalt used by some routes' },
  roadService: { label: 'Service area asphalt', description: 'Parking-area surface at Tatsumi/Shibaura PA' },
  concrete: { label: 'Concrete', description: 'Concrete walls and structures' },
  barrier: { label: 'Barrier', description: 'Road-edge concrete barriers' },
  building: { label: 'Building', description: 'Untextured background building walls' },
  tunnelWall: { label: 'Tunnel wall', description: 'Tunnel interior walls' },
});

export const PART_KINDS = Object.freeze({
  box: { label: 'Box', faces: ['right', 'left', 'top', 'bottom', 'front', 'back'] },
  cylinder: { label: 'Cylinder', faces: ['side', 'top', 'bottom'] },
  pyramid: { label: 'Pyramid', faces: ['side', 'bottom'] },
  cone: { label: 'Cone', faces: ['side', 'bottom'] },
  wedge: { label: 'Wedge', faces: ['slope', 'bottom', 'back', 'left', 'right'] },
  plane: { label: 'Plane', faces: ['face'] },
  sphere: { label: 'Sphere', faces: ['surface'] },
  // Free-form triangle mesh: explicit vertices + triangles. Created by
  // converting a primitive the first time its topology is edited (right-click
  // vertex add/remove in the modeler); its face names are dynamic — they are
  // carried over from the source primitive so textures survive conversion.
  mesh: { label: 'Mesh', faces: [] },
  asset: { label: 'Assembled asset', faces: [] },
});

export const MESH_MAX_VERTICES = 2000;
export const MESH_MAX_TRIANGLES = 4000;

/**
 * Face (material slot) names of a part. Static per kind for primitives;
 * mesh parts carry their own list (inherited from the primitive they were
 * converted from) and fall back to a single 'surface' slot.
 */
export function partFaceNames(part) {
  if (part?.kind === 'mesh') {
    return Array.isArray(part.faceNames) && part.faceNames.length ? part.faceNames : ['surface'];
  }
  return PART_KINDS[part?.kind]?.faces || [];
}

export function blankCustomAssetsDocument() {
  return { version: CUSTOM_ASSETS_VERSION, assets: {}, textures: {}, worldTextures: {} };
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function finiteVector(value, length) {
  return Array.isArray(value) && value.length === length && value.every((item) => Number.isFinite(item));
}

/** Validates a whole custom-assets document. Returns a list of error strings. */
export function customAssetsDocumentErrors(document) {
  const errors = [];
  if (!isRecord(document)) return ['root must be an object'];
  if (document.version !== CUSTOM_ASSETS_VERSION) errors.push(`version must be ${CUSTOM_ASSETS_VERSION}`);
  if (!isRecord(document.assets)) errors.push('assets must be an object');
  if (!isRecord(document.textures)) errors.push('textures must be an object');
  if (document.worldTextures !== undefined && !isRecord(document.worldTextures)) errors.push('worldTextures must be an object');
  if (errors.length) return errors;
  for (const [id, texture] of Object.entries(document.textures)) {
    if (FORBIDDEN_KEYS.has(id) || !CUSTOM_TEXTURE_ID_PATTERN.test(id)) errors.push(`invalid texture id: ${id}`);
    if (!isRecord(texture) || typeof texture.dataUrl !== 'string' || !texture.dataUrl.startsWith('data:image/')) {
      errors.push(`textures.${id}.dataUrl must be a data:image/... URL`);
    }
  }
  for (const [slot, textureId] of Object.entries(document.worldTextures || {})) {
    if (!Object.hasOwn(WORLD_TEXTURE_SLOTS, slot)) errors.push(`unknown world texture slot: ${slot}`);
    else if (textureId !== null && !document.textures[textureId]) errors.push(`worldTextures.${slot} references missing texture ${textureId}`);
  }
  for (const [id, asset] of Object.entries(document.assets)) {
    if (FORBIDDEN_KEYS.has(id) || !CUSTOM_ASSET_ID_PATTERN.test(id)) { errors.push(`invalid asset id: ${id}`); continue; }
    if (!isRecord(asset)) { errors.push(`assets.${id} must be an object`); continue; }
    if (typeof asset.label !== 'string' || !asset.label.trim() || asset.label.length > 120) errors.push(`assets.${id}.label is invalid`);
    if (!Array.isArray(asset.parts) || !asset.parts.length) { errors.push(`assets.${id}.parts must be a non-empty array`); continue; }
    if (asset.parts.length > 200) errors.push(`assets.${id} exceeds 200 parts`);
    asset.parts.forEach((part, index) => {
      const path = `assets.${id}.parts[${index}]`;
      if (!isRecord(part)) { errors.push(`${path} must be an object`); return; }
      if (!Object.hasOwn(PART_KINDS, part.kind)) { errors.push(`${path}.kind is unknown: ${part.kind}`); return; }
      for (const key of ['position', 'rotation', 'scale']) {
        if (part[key] !== undefined && !finiteVector(part[key], 3)) errors.push(`${path}.${key} must contain 3 finite numbers`);
      }
      if (part.kind === 'asset') {
        if (typeof part.assetRef !== 'string' || !part.assetRef.trim()) errors.push(`${path}.assetRef is required`);
        if (part.components !== undefined) {
          if (!Array.isArray(part.components)) errors.push(`${path}.components must be an array`);
          else part.components.forEach((component, componentIndex) => {
            if (!isRecord(component) || typeof component.materialKey !== 'string' || !finiteVector(component.matrix, 16)) {
              errors.push(`${path}.components[${componentIndex}] must have materialKey and a 16-number matrix`);
            }
          });
        }
      } else {
        if (part.kind === 'mesh') {
          const vertexCount = Array.isArray(part.vertices) ? part.vertices.length : 0;
          if (!Array.isArray(part.vertices) || vertexCount < 3 || vertexCount > MESH_MAX_VERTICES) {
            errors.push(`${path}.vertices must be an array of 3-${MESH_MAX_VERTICES} points`);
          } else if (!part.vertices.every((vertex) => finiteVector(vertex, 3))) {
            errors.push(`${path}.vertices entries must contain 3 finite numbers`);
          }
          if (!Array.isArray(part.triangles) || !part.triangles.length || part.triangles.length > MESH_MAX_TRIANGLES) {
            errors.push(`${path}.triangles must be an array of 1-${MESH_MAX_TRIANGLES} triangles`);
          } else {
            const faceCount = partFaceNames(part).length;
            part.triangles.forEach((triangle, triangleIndex) => {
              const triPath = `${path}.triangles[${triangleIndex}]`;
              if (!isRecord(triangle) || !Array.isArray(triangle.v) || triangle.v.length !== 3
                || !triangle.v.every((vertex) => Number.isInteger(vertex) && vertex >= 0 && vertex < vertexCount)) {
                errors.push(`${triPath}.v must be 3 vertex indices`);
                return;
              }
              if (new Set(triangle.v).size !== 3) errors.push(`${triPath}.v must reference 3 distinct vertices`);
              if (triangle.face !== undefined && (!Number.isInteger(triangle.face) || triangle.face < 0 || triangle.face >= faceCount)) {
                errors.push(`${triPath}.face must index into the part's face names`);
              }
              if (triangle.uv !== undefined && (!Array.isArray(triangle.uv) || triangle.uv.length !== 3
                || !triangle.uv.every((uv) => finiteVector(uv, 2)))) {
                errors.push(`${triPath}.uv must be 3 [u, v] pairs`);
              }
            });
          }
          if (part.faceNames !== undefined && (!Array.isArray(part.faceNames) || !part.faceNames.length
            || part.faceNames.length > 16
            || new Set(part.faceNames).size !== part.faceNames.length
            || !part.faceNames.every((name) => typeof name === 'string' && /^[a-z0-9_ -]{1,40}$/i.test(name)))) {
            errors.push(`${path}.faceNames must be short unique names`);
          }
        }
        if (part.faces !== undefined && !isRecord(part.faces)) errors.push(`${path}.faces must be an object`);
        for (const [face, style] of Object.entries(part.faces || {})) {
          if (!partFaceNames(part).includes(face)) errors.push(`${path}.faces.${face} is not a face of ${part.kind}`);
          if (!isRecord(style)) errors.push(`${path}.faces.${face} must be an object`);
          else if (style.texture !== undefined && style.texture !== null && !document.textures[style.texture]) {
            errors.push(`${path}.faces.${face}.texture references missing texture ${style.texture}`);
          }
        }
        if (part.vertexOffsets !== undefined) {
          if (!Array.isArray(part.vertexOffsets)) errors.push(`${path}.vertexOffsets must be an array`);
          else part.vertexOffsets.forEach((entry, entryIndex) => {
            if (!isRecord(entry) || !Number.isInteger(entry.i) || entry.i < 0 || !finiteVector(entry.o, 3)) {
              errors.push(`${path}.vertexOffsets[${entryIndex}] must be { i, o:[x,y,z] }`);
            }
          });
        }
        if (part.segments !== undefined && (!Number.isInteger(part.segments) || part.segments < 3 || part.segments > 32)) {
          errors.push(`${path}.segments must be an integer between 3 and 32`);
        }
        if (part.subdivisions !== undefined && (!Number.isInteger(part.subdivisions) || part.subdivisions < 1 || part.subdivisions > 8)) {
          errors.push(`${path}.subdivisions must be an integer between 1 and 8`);
        }
        if (part.color !== undefined && !/^#[0-9a-f]{6}$/i.test(String(part.color))) errors.push(`${path}.color must be #rrggbb`);
      }
    });
  }
  return errors;
}

export async function fetchCustomAssetsDocument(url = CUSTOM_ASSETS_URL) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    const document = await response.json();
    const errors = customAssetsDocumentErrors(document);
    if (errors.length) {
      console.warn('[custom-assets] ignoring invalid document:', errors.slice(0, 5).join(' · '));
      return null;
    }
    return document;
  } catch {
    return null; // offline / file:// / nothing saved yet — all normal
  }
}

// ---------------------------------------------------------------------------
// Geometry builders. Every primitive is unit sized (1 m) and centered so part
// scale gives the final dimensions. Groups are ordered exactly as the face
// names in PART_KINDS so faces[i] maps to material index i.
// ---------------------------------------------------------------------------

function wedgeGeometry() {
  // Right triangular prism: vertical back at z=-0.5, slope from the bottom
  // front edge up to the top back edge. Unit box footprint.
  const x = 0.5, y = 0.5, z = 0.5;
  const positions = [];
  const uvs = [];
  const groups = [];
  let offset = 0;
  const face = (points, uv) => {
    for (let index = 2; index < points.length; index += 1) {
      positions.push(...points[0], ...points[index - 1], ...points[index]);
      uvs.push(...uv[0], ...uv[index - 1], ...uv[index]);
    }
    const count = (points.length - 2) * 3;
    groups.push({ start: offset, count });
    offset += count;
  };
  // slope (front incline), bottom, back, left, right — same order as PART_KINDS
  face([[-x, -y, z], [x, -y, z], [x, y, -z], [-x, y, -z]], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  face([[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  face([[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]], [[0, 0], [1, 0], [1, 1], [0, 1]]);
  face([[-x, -y, -z], [-x, -y, z], [-x, y, -z]], [[0, 0], [1, 0], [0, 1]]);
  face([[x, -y, z], [x, -y, -z], [x, y, -z]], [[0, 0], [1, 0], [1, 1]]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  for (let index = 0; index < groups.length; index += 1) geometry.addGroup(groups[index].start, groups[index].count, index);
  geometry.computeVertexNormals();
  return geometry;
}

function singleGroup(geometry) {
  geometry.clearGroups();
  geometry.addGroup(0, geometry.index ? geometry.index.count : geometry.getAttribute('position').count, 0);
  return geometry;
}

// Planar fallback UVs for hand-authored mesh triangles that carry no stored
// uv: project along the triangle's dominant normal axis. Unit primitives are
// centered, so +0.5 keeps a unit face inside 0..1.
function triangleFallbackUv(a, b, c) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const normal = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ].map(Math.abs);
  const dominant = normal.indexOf(Math.max(...normal));
  const [uAxis, vAxis] = dominant === 0 ? [2, 1] : (dominant === 1 ? [0, 2] : [0, 1]);
  return [a, b, c].map((vertex) => [vertex[uAxis] + 0.5, vertex[vAxis] + 0.5]);
}

/**
 * Non-indexed geometry for a kind:'mesh' part: triangles grouped per face
 * name (material slot) in `partFaceNames` order, with stored per-corner UVs
 * (barycentric-interpolated through edits, so textures stay continuous).
 */
function meshGeometry(part) {
  if (!Array.isArray(part.vertices) || !Array.isArray(part.triangles)) return null;
  const faceCount = partFaceNames(part).length;
  const positions = [];
  const uvs = [];
  const groups = [];
  for (let group = 0; group < faceCount; group += 1) {
    const start = positions.length / 3;
    for (const triangle of part.triangles) {
      if ((triangle.face || 0) !== group) continue;
      const corners = triangle.v.map((index) => part.vertices[index]);
      if (corners.some((corner) => !finiteVector(corner, 3))) continue;
      const uv = Array.isArray(triangle.uv) && triangle.uv.length === 3
        ? triangle.uv
        : triangleFallbackUv(...corners);
      for (let k = 0; k < 3; k += 1) {
        positions.push(...corners[k]);
        uvs.push(uv[k][0], uv[k][1]);
      }
    }
    const count = positions.length / 3 - start;
    if (count) groups.push({ start, count, materialIndex: group });
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  for (const group of groups) geometry.addGroup(group.start, group.count, group.materialIndex);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Builds the base geometry for a primitive part with one material group per
 * named face (see PART_KINDS). Low segment counts keep the PSX look.
 * `part.subdivisions` (1–8) splits faces/heights into extra editable vertices.
 */
export function partGeometry(part) {
  const segments = Number.isInteger(part.segments) ? part.segments : null;
  const subdivisions = Number.isInteger(part.subdivisions) ? Math.min(8, Math.max(1, part.subdivisions)) : 1;
  switch (part.kind) {
    case 'box': {
      // BoxGeometry group order is px,nx,py,ny,pz,nz = right,left,top,bottom,front,back.
      return new THREE.BoxGeometry(1, 1, 1, subdivisions, subdivisions, subdivisions);
    }
    case 'cylinder': {
      const geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, segments || 8, subdivisions);
      return geometry; // groups: side, top, bottom
    }
    case 'pyramid': {
      return new THREE.ConeGeometry(0.5, 1, 4, subdivisions); // groups: side, bottom
    }
    case 'cone': {
      return new THREE.ConeGeometry(0.5, 1, segments || 8, subdivisions);
    }
    case 'wedge': {
      return wedgeGeometry();
    }
    case 'plane': {
      return singleGroup(new THREE.PlaneGeometry(1, 1, subdivisions, subdivisions));
    }
    case 'sphere': {
      return singleGroup(new THREE.SphereGeometry(0.5, segments || 8, Math.max(3, Math.round((segments || 8) * 0.75))));
    }
    case 'mesh': {
      return meshGeometry(part);
    }
    default:
      return null;
  }
}

/**
 * Deterministic vertex welding: BufferGeometry duplicates corner vertices per
 * face, but the modeler edits *logical* corners. Returns each unique welded
 * position (in first-appearance order) and, per attribute entry, the welded
 * index it belongs to.
 */
export function weldedVertices(geometry) {
  const attribute = geometry.getAttribute('position');
  const map = new Map();
  const welded = [];
  const weldIndexOf = new Array(attribute.count);
  for (let index = 0; index < attribute.count; index += 1) {
    const x = attribute.getX(index), y = attribute.getY(index), z = attribute.getZ(index);
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let weldIndex = map.get(key);
    if (weldIndex === undefined) {
      weldIndex = welded.length;
      map.set(key, weldIndex);
      welded.push([x, y, z]);
    }
    weldIndexOf[index] = weldIndex;
  }
  return { welded, weldIndexOf };
}

/** Applies stored per-welded-vertex offsets in place, then refreshes normals. */
export function applyVertexOffsets(geometry, vertexOffsets) {
  if (!Array.isArray(vertexOffsets) || !vertexOffsets.length) return geometry;
  const attribute = geometry.getAttribute('position');
  const { weldIndexOf } = weldedVertices(geometry);
  const offsets = new Map(vertexOffsets.map((entry) => [entry.i, entry.o]));
  for (let index = 0; index < attribute.count; index += 1) {
    const offset = offsets.get(weldIndexOf[index]);
    if (!offset) continue;
    attribute.setXYZ(index, attribute.getX(index) + offset[0], attribute.getY(index) + offset[1], attribute.getZ(index) + offset[2]);
  }
  attribute.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

// ---------------------------------------------------------------------------
// Mesh conversion and manual vertex management
// ---------------------------------------------------------------------------

/**
 * Converts a primitive part into an equivalent kind:'mesh' part so its
 * topology becomes editable (right-click vertex add/remove in the modeler).
 *
 * The mesh vertices are the primitive's welded corners IN WELD ORDER — the
 * same index space the modeler's vertex handles use — with any stored
 * `vertexOffsets` baked in. Triangles keep their material group (face name)
 * and their exact source UVs, so textures survive the conversion. Planes are
 * rendered double-sided via their kind; a converted plane keeps that through
 * the `doubleSide` face-style flag instead. Returns the new part (the input
 * is not mutated), the part itself when it is already a mesh, or null for
 * kinds without editable geometry (assembled assets).
 */
export function convertPartToMesh(part) {
  if (!part || part.kind === 'asset') return null;
  if (part.kind === 'mesh') return part;
  const geometry = partGeometry(part);
  if (!geometry) return null;
  const { welded, weldIndexOf } = weldedVertices(geometry);
  const offsets = new Map((part.vertexOffsets || []).map((entry) => [entry.i, entry.o]));
  const vertices = welded.map((vertex, index) => {
    const offset = offsets.get(index);
    return offset ? [vertex[0] + offset[0], vertex[1] + offset[1], vertex[2] + offset[2]] : [...vertex];
  });
  const uvAttribute = geometry.getAttribute('uv');
  const index = geometry.index;
  const cornerCount = index ? index.count : geometry.getAttribute('position').count;
  const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: cornerCount, materialIndex: 0 }];
  const triangles = [];
  for (const group of groups) {
    for (let corner = group.start; corner + 2 < group.start + group.count; corner += 3) {
      const corners = [corner, corner + 1, corner + 2].map((entry) => index ? index.getX(entry) : entry);
      const v = corners.map((entry) => weldIndexOf[entry]);
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue; // welded-degenerate (cone tips)
      const triangle = { v, face: group.materialIndex || 0 };
      if (uvAttribute) triangle.uv = corners.map((entry) => [uvAttribute.getX(entry), uvAttribute.getY(entry)]);
      triangles.push(triangle);
    }
  }
  geometry.dispose();
  if (vertices.length < 3 || !triangles.length) return null;
  const faceNames = [...PART_KINDS[part.kind].faces];
  const faces = structuredClone(part.faces || {});
  if (part.kind === 'plane') {
    for (const name of faceNames) faces[name] = { ...(faces[name] || {}), doubleSide: true };
  }
  return {
    kind: 'mesh',
    name: part.name || PART_KINDS[part.kind].label,
    position: [...(part.position || [0, 0, 0])],
    rotation: [...(part.rotation || [0, 0, 0])],
    scale: [...(part.scale || [1, 1, 1])],
    color: part.color || '#9aa7b5',
    vertices,
    triangles,
    faceNames,
    faces,
  };
}

const TRI_A = new THREE.Vector3();
const TRI_B = new THREE.Vector3();
const TRI_C = new THREE.Vector3();
const TRI_POINT = new THREE.Vector3();
const TRI_CLOSEST = new THREE.Vector3();
const TRI_BARY = new THREE.Vector3();
const TRIANGLE = new THREE.Triangle();

const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Adds a vertex to a kind:'mesh' part at the given part-local point (an
 * [x, y, z] triple, e.g. a viewport raycast hit mapped through worldToLocal).
 *
 * The nearest triangle decides how: a hit near one of its edges splits that
 * edge — including EVERY triangle sharing it, keeping the mesh watertight —
 * while an interior hit fans the triangle into three around the new vertex.
 * Stored UVs are interpolated (linearly on edges, barycentrically inside), so
 * face textures stay continuous. Returns { vertexIndex, split: 'edge'|'face' }
 * or null when nothing could be added.
 */
export function meshInsertVertexAtPoint(part, point, { edgeEpsilon = 0.12 } = {}) {
  if (part?.kind !== 'mesh' || !finiteVector(point, 3)) return null;
  if (!Array.isArray(part.vertices) || !Array.isArray(part.triangles)) return null;
  if (part.vertices.length >= MESH_MAX_VERTICES || part.triangles.length + 2 > MESH_MAX_TRIANGLES) return null;
  TRI_POINT.fromArray(point);
  let best = null;
  part.triangles.forEach((triangle, triangleIndex) => {
    const [a, b, c] = triangle.v.map((vertex) => part.vertices[vertex]);
    if (!finiteVector(a, 3) || !finiteVector(b, 3) || !finiteVector(c, 3)) return;
    TRIANGLE.set(TRI_A.fromArray(a), TRI_B.fromArray(b), TRI_C.fromArray(c));
    TRIANGLE.closestPointToPoint(TRI_POINT, TRI_CLOSEST);
    const distance = TRI_CLOSEST.distanceTo(TRI_POINT);
    if (best && distance >= best.distance) return;
    TRIANGLE.getBarycoord(TRI_CLOSEST, TRI_BARY);
    best = { triangleIndex, distance, closest: TRI_CLOSEST.toArray(), bary: TRI_BARY.toArray() };
  });
  if (!best) return null;
  const triangle = part.triangles[best.triangleIndex];
  const weights = best.bary;
  const smallest = weights.indexOf(Math.min(...weights));
  if (weights[smallest] < edgeEpsilon) {
    // Near an edge: split the edge opposite the smallest-weight corner in
    // every triangle that shares it.
    const endA = triangle.v[(smallest + 1) % 3];
    const endB = triangle.v[(smallest + 2) % 3];
    const wA = weights[(smallest + 1) % 3];
    const wB = weights[(smallest + 2) % 3];
    const t = wB / Math.max(wA + wB, 1e-9); // parameter along endA -> endB
    const vertexIndex = part.vertices.length;
    part.vertices.push(lerp3(part.vertices[endA], part.vertices[endB], t));
    const nextTriangles = [];
    for (const candidate of part.triangles) {
      const cornerA = candidate.v.indexOf(endA);
      const cornerB = candidate.v.indexOf(endB);
      if (cornerA === -1 || cornerB === -1) { nextTriangles.push(candidate); continue; }
      // Split candidate (p, q, r) on the shared edge: the new vertex replaces
      // one edge end per half, preserving the original winding.
      const uvNew = candidate.uv ? lerp2(candidate.uv[cornerA], candidate.uv[cornerB], t) : null;
      for (const replaceCorner of [cornerB, cornerA]) {
        const half = { v: [...candidate.v], face: candidate.face || 0 };
        half.v[replaceCorner] = vertexIndex;
        if (candidate.uv) {
          half.uv = candidate.uv.map((uv) => [...uv]);
          half.uv[replaceCorner] = [...uvNew];
        }
        nextTriangles.push(half);
      }
    }
    if (nextTriangles.length > MESH_MAX_TRIANGLES) { part.vertices.pop(); return null; }
    part.triangles = nextTriangles;
    return { vertexIndex, split: 'edge' };
  }
  // Interior: fan the triangle into three around the new vertex.
  const vertexIndex = part.vertices.length;
  part.vertices.push([...best.closest]);
  const uvNew = triangle.uv
    ? [0, 1].map((axis) => triangle.uv[0][axis] * weights[0]
      + triangle.uv[1][axis] * weights[1] + triangle.uv[2][axis] * weights[2])
    : null;
  const fan = [0, 1, 2].map((corner) => {
    const next = (corner + 1) % 3;
    const half = { v: [triangle.v[corner], triangle.v[next], vertexIndex], face: triangle.face || 0 };
    if (triangle.uv) half.uv = [triangle.uv[corner].slice(), triangle.uv[next].slice(), [...uvNew]];
    return half;
  });
  part.triangles.splice(best.triangleIndex, 1, ...fan);
  return { vertexIndex, split: 'face' };
}

/**
 * Removes one vertex from a kind:'mesh' part: triangles using it are dropped
 * and vertices left unreferenced are compacted away. Refuses (returns false,
 * mesh untouched) when the removal would leave fewer than 3 vertices or no
 * triangles at all.
 */
export function meshRemoveVertex(part, vertexIndex) {
  if (part?.kind !== 'mesh' || !Number.isInteger(vertexIndex)) return false;
  if (!Array.isArray(part.vertices) || !part.vertices[vertexIndex]) return false;
  const kept = part.triangles.filter((triangle) => !triangle.v.includes(vertexIndex));
  if (!kept.length) return false;
  const used = new Set();
  for (const triangle of kept) for (const vertex of triangle.v) used.add(vertex);
  if (used.size < 3) return false;
  const remap = new Map([...used].sort((a, b) => a - b).map((oldIndex, newIndex) => [oldIndex, newIndex]));
  part.vertices = [...remap.keys()].map((oldIndex) => part.vertices[oldIndex]);
  part.triangles = kept.map((triangle) => ({ ...triangle, v: triangle.v.map((vertex) => remap.get(vertex)) }));
  // Offsets index the old welded topology; they no longer apply.
  delete part.vertexOffsets;
  return true;
}

// ---------------------------------------------------------------------------
// Textures and materials
// ---------------------------------------------------------------------------

const textureCache = new Map();

/** PSX-flavoured texture from a stored data URL: nearest filtering, sRGB, repeat wrap. */
export function textureFromDataUrl(dataUrl, { repeat = null } = {}) {
  const key = `${dataUrl}|${repeat ? repeat.join(',') : ''}`;
  if (textureCache.has(key)) return textureCache.get(key);
  // Outside the browser (node tests) there is no image decoding: hand back a
  // bare texture object so material wiring stays testable.
  const texture = typeof document === 'undefined' ? new THREE.Texture() : new THREE.TextureLoader().load(dataUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  if (repeat) texture.repeat.set(repeat[0], repeat[1]);
  textureCache.set(key, texture);
  return texture;
}

function faceMaterial(part, faceName, texturesById) {
  const style = part.faces?.[faceName] || {};
  const color = style.color || part.color || '#9aa7b5';
  const parameters = {
    color: new THREE.Color(color),
    fog: true,
    name: `custom:${part.kind}:${faceName}`,
  };
  const textureRecord = style.texture ? texturesById?.[style.texture] : null;
  if (textureRecord?.dataUrl) {
    parameters.map = textureFromDataUrl(textureRecord.dataUrl, {
      repeat: finiteVector(style.repeat, 2) ? style.repeat : null,
    });
    parameters.color = new THREE.Color('#ffffff');
  }
  if (part.kind === 'plane' || style.doubleSide) parameters.side = THREE.DoubleSide;
  const material = new THREE.MeshLambertMaterial(parameters);
  if (style.emissive) material.emissive = new THREE.Color(style.emissive);
  return material;
}

/**
 * Builds one part as a THREE.Object3D, or null when the part cannot be built.
 * `resolveAssetPart(part)` must return a THREE.Object3D for kind:'asset' parts
 * (the editor resolves through its live asset registry; the game rebuilds from
 * the baked components via donor meshes).
 */
export function buildPartObject(part, texturesById, { resolveAssetPart = () => null } = {}) {
  let node = null;
  if (part.kind === 'asset') {
    node = resolveAssetPart(part);
    if (!node) return null;
  } else {
    const geometry = partGeometry(part);
    if (!geometry) return null;
    applyVertexOffsets(geometry, part.vertexOffsets);
    const materials = partFaceNames(part).map((faceName) => faceMaterial(part, faceName, texturesById));
    node = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
  }
  node.name = part.name || PART_KINDS[part.kind].label;
  if (finiteVector(part.position, 3)) node.position.fromArray(part.position);
  if (finiteVector(part.rotation, 3)) node.rotation.set(part.rotation[0], part.rotation[1], part.rotation[2]);
  if (finiteVector(part.scale, 3)) node.scale.fromArray(part.scale);
  return node;
}

/**
 * Builds a full custom asset (all parts) as a THREE.Group anchored at the
 * asset origin. Never throws: unresolvable parts are skipped and counted.
 */
export function buildCustomAssetGroup(assetDefinition, texturesById, { resolveAssetPart = () => null } = {}) {
  const root = new THREE.Group();
  root.name = assetDefinition.label || assetDefinition.id || 'Custom object';
  let skipped = 0;
  for (const part of assetDefinition.parts || []) {
    const node = buildPartObject(part, texturesById, { resolveAssetPart });
    if (node) root.add(node);
    else skipped += 1;
  }
  root.userData.customAssetId = assetDefinition.id || null;
  root.userData.customAssetSkippedParts = skipped;
  return root;
}

/**
 * Applies saved world texture overrides (road asphalt, concrete, ...) onto the
 * generated map's material set. Materials keep working with no overrides.
 */
export function applyWorldTextureOverrides(materials, document) {
  const summary = { applied: 0, skipped: 0 };
  if (!materials || !isRecord(document?.worldTextures)) return summary;
  for (const [slot, textureId] of Object.entries(document.worldTextures)) {
    const material = materials[slot];
    const textureRecord = textureId ? document.textures?.[textureId] : null;
    if (!material || !Object.hasOwn(WORLD_TEXTURE_SLOTS, slot) || !textureRecord?.dataUrl) { summary.skipped += 1; continue; }
    const repeat = finiteVector(textureRecord.repeat, 2) ? textureRecord.repeat : null;
    material.map = textureFromDataUrl(textureRecord.dataUrl, { repeat });
    // The image now carries the surface colour; a dark tint would multiply it away.
    material.color?.set?.('#ffffff');
    material.needsUpdate = true;
    summary.applied += 1;
  }
  return summary;
}
