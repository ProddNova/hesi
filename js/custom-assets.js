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

function validFaceProjection(value) {
  return isRecord(value)
    && finiteVector(value.origin, 3)
    && finiteVector(value.uvOrigin, 2)
    && finiteVector(value.uVector, 3)
    && finiteVector(value.vVector, 3)
    && Number.isFinite(value.surfaceAspect)
    && value.surfaceAspect > 0;
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
          else {
            if (style.texture !== undefined && style.texture !== null && !document.textures[style.texture]) {
              errors.push(`${path}.faces.${face}.texture references missing texture ${style.texture}`);
            }
            if (style.fit !== undefined && !['stretch', 'cover'].includes(style.fit)) {
              errors.push(`${path}.faces.${face}.fit must be stretch or cover`);
            }
            for (const key of ['flipX', 'flipY']) {
              if (style[key] !== undefined && typeof style[key] !== 'boolean') errors.push(`${path}.faces.${face}.${key} must be boolean`);
            }
            if (style.repeat !== undefined && !finiteVector(style.repeat, 2)) errors.push(`${path}.faces.${face}.repeat must contain 2 finite numbers`);
            if (style.projection !== undefined && !validFaceProjection(style.projection)) {
              errors.push(`${path}.faces.${face}.projection must describe a finite planar texture projection`);
            }
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
  applyVertexOffsets(geometry, part.vertexOffsets);
  applyPartFaceProjections(geometry, part);
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
const OPPOSITE_RAY = new THREE.Ray();
const OPPOSITE_ORIGIN = new THREE.Vector3();
const OPPOSITE_DIRECTION = new THREE.Vector3();
const OPPOSITE_NORMAL = new THREE.Vector3();
const OPPOSITE_HIT = new THREE.Vector3();

const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * Adds a vertex to a kind:'mesh' part at the given part-local point (an
 * [x, y, z] triple, e.g. a viewport raycast hit mapped through worldToLocal).
 *
 * The nearest triangle decides how: a hit near one of its edges splits that
 * edge — including EVERY triangle sharing it, keeping the mesh watertight —
 * while an interior hit fans the triangle into three around the new vertex.
 * A hit (almost) on an existing corner snaps to it (split: 'corner', nothing
 * inserted). Stored UVs are interpolated (linearly on edges, barycentrically
 * inside), so face textures stay continuous. Returns
 * { vertexIndex, split: 'edge'|'face'|'corner' } or null when nothing could
 * be added.
 */
function meshInsertSingleVertexAtPoint(part, point, { edgeEpsilon = 0.12, cornerEpsilon = 0.05, faceIndex = null } = {}) {
  if (part?.kind !== 'mesh' || !finiteVector(point, 3)) return null;
  if (!Array.isArray(part.vertices) || !Array.isArray(part.triangles)) return null;
  if (part.vertices.length >= MESH_MAX_VERTICES || part.triangles.length + 2 > MESH_MAX_TRIANGLES) return null;
  const best = closestMeshTriangle(part, point, faceIndex);
  if (!best) return null;
  const triangle = best.triangle;
  const weights = best.bary;
  const largest = weights.indexOf(Math.max(...weights));
  if (weights[largest] >= 1 - cornerEpsilon) {
    // (Almost) on an existing corner: reuse that vertex instead of stacking a
    // degenerate sliver next to it.
    return { vertexIndex: triangle.v[largest], split: 'corner' };
  }
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

function closestMeshTriangle(part, point, faceIndex = null) {
  TRI_POINT.fromArray(point);
  let best = null;
  part.triangles.forEach((triangle, triangleIndex) => {
    if (Number.isInteger(faceIndex) && (triangle.face || 0) !== faceIndex) return;
    const [a, b, c] = triangle.v.map((vertex) => part.vertices[vertex]);
    if (!finiteVector(a, 3) || !finiteVector(b, 3) || !finiteVector(c, 3)) return;
    TRIANGLE.set(TRI_A.fromArray(a), TRI_B.fromArray(b), TRI_C.fromArray(c));
    TRIANGLE.closestPointToPoint(TRI_POINT, TRI_CLOSEST);
    const distance = TRI_CLOSEST.distanceTo(TRI_POINT);
    if (best && distance >= best.distance) return;
    TRIANGLE.getBarycoord(TRI_CLOSEST, TRI_BARY);
    best = { triangle, triangleIndex, distance, closest: TRI_CLOSEST.toArray(), bary: TRI_BARY.toArray() };
  });
  return best;
}

function oppositeMeshTriangle(part, source) {
  const [a, b, c] = source.triangle.v.map((vertex) => part.vertices[vertex]);
  TRIANGLE.set(TRI_A.fromArray(a), TRI_B.fromArray(b), TRI_C.fromArray(c));
  TRIANGLE.getNormal(OPPOSITE_NORMAL);
  if (OPPOSITE_NORMAL.lengthSq() < 1e-12) return null;

  const extent = part.vertices.reduce((largest, vertex) => Math.max(
    largest, Math.abs(vertex[0]), Math.abs(vertex[1]), Math.abs(vertex[2]),
  ), 1);
  const minimumDistance = extent * 1e-6;
  let best = null;
  for (const directionSign of [1, -1]) {
    OPPOSITE_ORIGIN.fromArray(source.closest);
    OPPOSITE_DIRECTION.copy(OPPOSITE_NORMAL).multiplyScalar(directionSign);
    OPPOSITE_RAY.set(OPPOSITE_ORIGIN, OPPOSITE_DIRECTION);
    part.triangles.forEach((triangle, triangleIndex) => {
      if (triangle === source.triangle) return;
      const [candidateA, candidateB, candidateC] = triangle.v.map((vertex) => part.vertices[vertex]);
      if (!finiteVector(candidateA, 3) || !finiteVector(candidateB, 3) || !finiteVector(candidateC, 3)) return;
      const intersection = OPPOSITE_RAY.intersectTriangle(
        TRI_A.fromArray(candidateA), TRI_B.fromArray(candidateB), TRI_C.fromArray(candidateC), false, OPPOSITE_HIT,
      );
      if (!intersection) return;
      const distance = intersection.distanceTo(OPPOSITE_ORIGIN);
      // A second triangle can share the clicked edge at distance zero; it is
      // still part of the near surface, not the opposing face.
      if (distance <= minimumDistance || (best && distance >= best.distance)) return;
      TRIANGLE.set(TRI_A.fromArray(candidateA), TRI_B.fromArray(candidateB), TRI_C.fromArray(candidateC));
      TRIANGLE.getBarycoord(intersection, TRI_BARY);
      best = {
        triangle, triangleIndex, distance,
        closest: intersection.toArray(), bary: TRI_BARY.toArray(),
      };
    });
  }
  return best;
}

const meshEdgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;

/**
 * Clips segment a→b (2D) against a triangle given as three 2D points.
 * Returns the [t0, t1] parameter interval of the segment inside the triangle,
 * or null when they do not overlap. Winding of the triangle does not matter.
 */
function clipSegmentByTriangle2(a, b, corners) {
  let [p0, p1, p2] = corners;
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (area === 0) return null;
  if (area < 0) [p1, p2] = [p2, p1];
  const ordered = [p0, p1, p2];
  let t0 = 0;
  let t1 = 1;
  for (let index = 0; index < 3; index += 1) {
    const p = ordered[index];
    const q = ordered[(index + 1) % 3];
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const da = ex * (a[1] - p[1]) - ey * (a[0] - p[0]);
    const db = ex * (b[1] - p[1]) - ey * (b[0] - p[0]);
    if (da < 0 && db < 0) return null;
    if (da < 0) t0 = Math.max(t0, da / (da - db));
    else if (db < 0) t1 = Math.min(t1, da / (da - db));
  }
  return t1 > t0 ? [t0, t1] : null;
}

/**
 * Ear-clips one simple polygon (vertex indices in CCW order, 2D positions via
 * `points`). Returns the triangles as index triples, or null when the polygon
 * is degenerate.
 */
function earClipPolygon(indices, points) {
  if (indices.length < 3) return [];
  const p = (vertex) => points.get(vertex);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  let span = 0;
  for (const vertex of indices) {
    span = Math.max(span, Math.abs(p(vertex)[0]), Math.abs(p(vertex)[1]));
  }
  const areaEpsilon = Math.max(span * span, 1e-12) * 1e-9;
  const remaining = [...indices];
  const result = [];
  let guard = remaining.length * remaining.length + 16;
  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const previous = remaining[(index + remaining.length - 1) % remaining.length];
      const current = remaining[index];
      const next = remaining[(index + 1) % remaining.length];
      const a = p(previous), b = p(current), c = p(next);
      if (cross(a, b, c) <= areaEpsilon) continue; // reflex or degenerate corner
      let blocked = false;
      for (const other of remaining) {
        if (other === previous || other === current || other === next) continue;
        const q = p(other);
        if (cross(a, b, q) >= -areaEpsilon && cross(b, c, q) >= -areaEpsilon && cross(c, a, q) >= -areaEpsilon) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      result.push([previous, current, next]);
      remaining.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (remaining.length === 3) {
    if (cross(p(remaining[0]), p(remaining[1]), p(remaining[2])) <= areaEpsilon) return null;
    result.push([...remaining]);
  }
  return result;
}

/**
 * Inserts a real edge between vertexA and vertexB inside one planar material
 * face by retriangulating only the corridor of triangles the connecting
 * segment actually crosses. Triangles of the face outside the corridor — and
 * any custom vertices they carry — stay untouched.
 */
function insertChordAcrossFace(part, face, vertexA, vertexB) {
  const faceTriangles = [];
  part.triangles.forEach((triangle, index) => {
    if ((triangle.face || 0) === face) faceTriangles.push({ triangle, index });
  });
  if (faceTriangles.some(({ triangle }) => triangle.v.includes(vertexA) && triangle.v.includes(vertexB))) return true;

  // Projection basis from the first non-degenerate face triangle. With
  // v = n × u the face triangles project counter-clockwise.
  let basis = null;
  for (const { triangle } of faceTriangles) {
    const [a, b, c] = triangle.v.map((vertex) => part.vertices[vertex]);
    if (![a, b, c].every((corner) => finiteVector(corner, 3))) continue;
    const origin = new THREE.Vector3().fromArray(a);
    const u = new THREE.Vector3().fromArray(b).sub(origin);
    const ac = new THREE.Vector3().fromArray(c).sub(origin);
    const normal = u.clone().cross(ac);
    if (normal.lengthSq() < 1e-12) continue;
    normal.normalize();
    u.normalize();
    basis = { origin, normal, u, v: normal.clone().cross(u) };
    break;
  }
  if (!basis) return false;

  // 2D positions of every face vertex; a bent (non-planar) face cannot take a
  // straight chord, so refuse it.
  const points = new Map();
  let extent = 1;
  for (const { triangle } of faceTriangles) {
    for (const vertex of triangle.v) {
      if (points.has(vertex)) continue;
      const position = part.vertices[vertex];
      if (!finiteVector(position, 3)) return false;
      extent = Math.max(extent, Math.abs(position[0]), Math.abs(position[1]), Math.abs(position[2]));
      const delta = new THREE.Vector3().fromArray(position).sub(basis.origin);
      if (Math.abs(delta.dot(basis.normal)) > extent * 1e-5) return false;
      points.set(vertex, [delta.dot(basis.u), delta.dot(basis.v)]);
    }
  }
  if (!points.has(vertexA) || !points.has(vertexB)) return false;
  const a2 = points.get(vertexA);
  const b2 = points.get(vertexB);
  const segmentLength = Math.hypot(b2[0] - a2[0], b2[1] - a2[1]);
  if (segmentLength < extent * 1e-6) return false;

  // Corridor: face triangles the open segment actually passes through.
  const corridor = faceTriangles.filter(({ triangle }) => {
    const span = clipSegmentByTriangle2(a2, b2, triangle.v.map((vertex) => points.get(vertex)));
    return span && (span[1] - span[0]) * segmentLength > extent * 1e-6;
  });
  if (!corridor.length) return false;

  // Boundary loop of the corridor region (edges used by exactly one corridor
  // triangle).
  const edges = new Map();
  for (const { triangle } of corridor) {
    triangle.v.forEach((vertex, corner) => {
      const next = triangle.v[(corner + 1) % 3];
      const key = meshEdgeKey(vertex, next);
      const edge = edges.get(key) || { count: 0, vertices: [vertex, next] };
      edge.count += 1;
      edges.set(key, edge);
    });
  }
  const boundary = new Map();
  for (const { count, vertices: [a, b] } of edges.values()) {
    if (count !== 1) continue;
    if (!boundary.has(a)) boundary.set(a, []);
    if (!boundary.has(b)) boundary.set(b, []);
    boundary.get(a).push(b);
    boundary.get(b).push(a);
  }
  if (!boundary.has(vertexA) || !boundary.has(vertexB)) return false;
  const loop = [vertexA];
  let previous = -1;
  let current = vertexA;
  let closed = false;
  while (loop.length <= boundary.size) {
    const neighbours = boundary.get(current);
    if (!neighbours || neighbours.length !== 2) break;
    const next = neighbours[0] === previous ? neighbours[1] : neighbours[0];
    if (next === vertexA) { closed = true; break; }
    if (loop.includes(next)) break;
    loop.push(next);
    previous = current;
    current = next;
  }
  if (!closed || !loop.includes(vertexB)) return false;
  // A vertex strictly inside the corridor would be silently discarded by the
  // retriangulation — never do that.
  const onLoop = new Set(loop);
  for (const { triangle } of corridor) {
    if (triangle.v.some((vertex) => !onLoop.has(vertex))) return false;
  }

  // Orient the loop counter-clockwise (matching the face winding), then split
  // it at the chord into the two polygons on either side.
  let area = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const p = points.get(loop[index]);
    const q = points.get(loop[(index + 1) % loop.length]);
    area += p[0] * q[1] - q[0] * p[1];
  }
  if (area < 0) loop.splice(0, loop.length, vertexA, ...loop.slice(1).reverse());
  const splitAt = loop.indexOf(vertexB);
  const chains = [loop.slice(0, splitAt + 1), [...loop.slice(splitAt), vertexA]];

  const uvByVertex = new Map();
  for (const { triangle } of faceTriangles) {
    if (!triangle.uv) continue;
    triangle.v.forEach((vertex, corner) => {
      if (!uvByVertex.has(vertex)) uvByVertex.set(vertex, triangle.uv[corner]);
    });
  }
  const replacements = [];
  for (const chain of chains) {
    const fan = earClipPolygon(chain, points);
    if (!fan) return false;
    for (const vertices of fan) {
      const triangle = { v: vertices, face };
      if (vertices.every((vertex) => uvByVertex.has(vertex))) {
        triangle.uv = vertices.map((vertex) => uvByVertex.get(vertex).slice());
      }
      replacements.push(triangle);
    }
  }
  if (!replacements.some((triangle) => triangle.v.includes(vertexA) && triangle.v.includes(vertexB))) return false;
  const corridorIndices = new Set(corridor.map(({ index }) => index));
  const kept = part.triangles.filter((_, index) => !corridorIndices.has(index));
  if (kept.length + replacements.length > MESH_MAX_TRIANGLES) return false;
  part.triangles = [...kept, ...replacements];
  return true;
}

/**
 * Makes a real mesh edge between two new vertices when they lie on the same
 * planar material face. This turns opposite roof apexes into one continuous
 * ridge instead of leaving two unrelated points, and — because only the
 * crossed triangles are retriangulated — works even on faces that already
 * carry custom vertices elsewhere.
 */
function connectMeshVerticesAcrossFace(part, vertexA, vertexB) {
  const facesAtA = new Set(part.triangles
    .filter((triangle) => triangle.v.includes(vertexA))
    .map((triangle) => triangle.face || 0));
  const facesAtB = new Set(part.triangles
    .filter((triangle) => triangle.v.includes(vertexB))
    .map((triangle) => triangle.face || 0));
  for (const face of facesAtA) {
    if (!facesAtB.has(face)) continue;
    if (insertChordAcrossFace(part, face, vertexA, vertexB)) return true;
  }
  return false;
}

/**
 * Adds a custom mesh vertex and, on a closed mesh, mirrors it where the
 * clicked face normal meets the opposite surface. If the two insertions share
 * the boundary of a planar face, that face receives a real edge joining them.
 * Open meshes retain the original single-point behaviour.
 */
export function meshInsertVertexAtPoint(part, point, {
  edgeEpsilon = 0.12, faceIndex = null, mirrorOpposite = true,
} = {}) {
  if (part?.kind !== 'mesh' || !finiteVector(point, 3)) return null;
  if (!Array.isArray(part.vertices) || !Array.isArray(part.triangles)) return null;
  const source = closestMeshTriangle(part, point, faceIndex);
  if (!source) return null;
  const opposite = mirrorOpposite ? oppositeMeshTriangle(part, source) : null;
  if (part.vertices.length + (opposite ? 2 : 1) > MESH_MAX_VERTICES) return null;

  // Pair insertion is atomic: failure on the far side restores the untouched
  // topology instead of leaving exactly the one-sided apex this prevents.
  const originalVertices = part.vertices.map((vertex) => [...vertex]);
  const originalTriangles = part.triangles.map((triangle) => ({
    ...triangle,
    v: [...triangle.v],
    ...(triangle.uv ? { uv: triangle.uv.map((uv) => [...uv]) } : {}),
  }));
  const added = meshInsertSingleVertexAtPoint(part, point, { edgeEpsilon, faceIndex });
  if (!added) return null;
  if (!opposite) return added;

  const oppositeAdded = meshInsertSingleVertexAtPoint(part, opposite.closest, {
    edgeEpsilon,
    faceIndex: opposite.triangle.face || 0,
  });
  if (!oppositeAdded) {
    part.vertices = originalVertices;
    part.triangles = originalTriangles;
    return null;
  }
  const connected = connectMeshVerticesAcrossFace(part, added.vertexIndex, oppositeAdded.vertexIndex);
  return {
    ...added,
    oppositeVertexIndex: oppositeAdded.vertexIndex,
    oppositeSplit: oppositeAdded.split,
    connected,
  };
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

/**
 * Structural invariants of a kind:'mesh' part. Editing operations must keep
 * every vertex referenced, every triangle non-degenerate, and — on closed
 * meshes (no doubleSide face) — every edge shared by exactly two triangles.
 * Returns human-readable issue strings; an empty array means the topology is
 * sound. Diagnostic only: rendering tolerates broken meshes, but they shear
 * apart the moment a vertex moves.
 */
export function meshTopologyIssues(part) {
  if (part?.kind !== 'mesh') return [];
  const issues = [];
  const vertices = Array.isArray(part.vertices) ? part.vertices : [];
  const triangles = Array.isArray(part.triangles) ? part.triangles : [];
  const referenced = new Set();
  const edges = new Map();
  triangles.forEach((triangle, index) => {
    const v = triangle?.v;
    if (!Array.isArray(v) || v.length !== 3 || v.some((entry) => !Number.isInteger(entry) || entry < 0 || entry >= vertices.length)) {
      issues.push(`triangle ${index} has invalid vertex indices [${v}]`);
      return;
    }
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
      issues.push(`triangle ${index} is degenerate [${v}]`);
      return;
    }
    for (let corner = 0; corner < 3; corner += 1) {
      referenced.add(v[corner]);
      const a = v[corner], b = v[(corner + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  });
  vertices.forEach((vertex, index) => {
    if (!referenced.has(index)) issues.push(`vertex ${index} [${vertex}] is orphaned (no triangle uses it)`);
  });
  const open = Object.values(part.faces || {}).some((face) => face?.doubleSide);
  for (const [key, count] of edges) {
    if (count > 2) issues.push(`edge ${key} is shared by ${count} triangles (overlapping surface)`);
    else if (count === 1 && !open) issues.push(`edge ${key} is a boundary crack (used by one triangle on a closed mesh)`);
  }
  return issues;
}

/**
 * Moves an entire named face of a part by `delta` (part-local metres before
 * the part scale): every vertex belonging to that material face translates
 * together, so a box top can be pulled upward or a roof slid sideways in one
 * gesture. Mesh parts move their vertices directly; primitives accumulate the
 * move into `vertexOffsets` (staying non-destructive), keyed by the same
 * welded indices the modeler's vertex handles use. Returns true when at least
 * one vertex moved.
 */
export function translatePartFace(part, faceName, delta) {
  if (!part || part.kind === 'asset' || !finiteVector(delta, 3)) return false;
  const materialIndex = partFaceNames(part).indexOf(faceName);
  if (materialIndex < 0) return false;
  if (part.kind === 'mesh') {
    const targets = new Set();
    for (const triangle of part.triangles || []) {
      if ((triangle.face || 0) !== materialIndex) continue;
      for (const vertex of triangle.v) targets.add(vertex);
    }
    if (!targets.size) return false;
    for (const vertex of targets) {
      const position = part.vertices[vertex];
      if (!finiteVector(position, 3)) continue;
      part.vertices[vertex] = [position[0] + delta[0], position[1] + delta[1], position[2] + delta[2]];
    }
    return true;
  }
  const geometry = partGeometry(part);
  if (!geometry) return false;
  const { weldIndexOf } = weldedVertices(geometry);
  const index = geometry.index;
  const cornerCount = index ? index.count : geometry.getAttribute('position').count;
  const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: cornerCount, materialIndex: 0 }];
  const targets = new Set();
  for (const group of groups) {
    if ((group.materialIndex || 0) !== materialIndex) continue;
    for (let corner = group.start; corner < group.start + group.count; corner += 1) {
      targets.add(weldIndexOf[index ? index.getX(corner) : corner]);
    }
  }
  geometry.dispose();
  if (!targets.size) return false;
  const offsets = new Map((part.vertexOffsets || []).map((entry) => [entry.i, entry.o]));
  for (const weldIndex of targets) {
    const offset = offsets.get(weldIndex) || [0, 0, 0];
    offsets.set(weldIndex, [offset[0] + delta[0], offset[1] + delta[1], offset[2] + delta[2]]);
  }
  part.vertexOffsets = [...offsets.entries()]
    .map(([i, o]) => ({ i, o }))
    .filter((entry) => entry.o.some((value) => Math.abs(value) > 1e-9));
  if (!part.vertexOffsets.length) delete part.vertexOffsets;
  return true;
}

// ---------------------------------------------------------------------------
// Opposite-face cloning
// ---------------------------------------------------------------------------

const OPPOSITE_FACE_NAMES = Object.freeze({
  front: 'back', back: 'front', left: 'right', right: 'left', top: 'bottom', bottom: 'top',
});

/**
 * Name of the geometric opposite of `faceName` on this part (box front↔back,
 * left↔right, top↔bottom; cylinder top↔bottom; wedge left↔right — mesh parts
 * inherit the pairs of the primitive they came from), or null when the part
 * has no such pair (cones, planes, spheres, assembled assets).
 */
export function oppositePartFace(part, faceName) {
  const names = partFaceNames(part);
  const target = OPPOSITE_FACE_NAMES[faceName];
  return target && names.includes(faceName) && names.includes(target) ? target : null;
}

const roundedPositionKey = (position) => `${Math.round(position[0] * 1e3)},${Math.round(position[1] * 1e3)},${Math.round(position[2] * 1e3)}`;

/** Dominant separation axis and mirror-plane coordinate between two point sets. */
function mirrorPlaneBetween(sourcePoints, targetPoints) {
  if (!sourcePoints.length || !targetPoints.length) return null;
  const centroid = (points) => points
    .reduce((sum, point) => [sum[0] + point[0], sum[1] + point[1], sum[2] + point[2]], [0, 0, 0])
    .map((value) => value / points.length);
  const sourceCentroid = centroid(sourcePoints);
  const targetCentroid = centroid(targetPoints);
  const diff = [0, 1, 2].map((axis) => targetCentroid[axis] - sourceCentroid[axis]);
  const magnitudes = diff.map(Math.abs);
  const axis = magnitudes.indexOf(Math.max(...magnitudes));
  if (magnitudes[axis] < 1e-5) return null;
  return { axis, plane: (sourceCentroid[axis] + targetCentroid[axis]) / 2 };
}

/**
 * Mirrors the source face's vertex edits onto the opposite face of a
 * primitive part. Correspondence goes through the unedited base geometry
 * (primitives are symmetric across the axis separating an opposite pair), so
 * the clone is exact: every pulled vertex of the source lands mirrored on the
 * target, and target vertices whose source counterpart is unedited reset.
 * Returns the mirror plane, or null when the clone is not possible.
 */
function mirrorPrimitiveFaceOffsets(part, sourceName, targetName) {
  const names = partFaceNames(part);
  const sourceIndex = names.indexOf(sourceName);
  const targetIndex = names.indexOf(targetName);
  if (sourceIndex < 0 || targetIndex < 0) return null;
  const geometry = partGeometry(part);
  if (!geometry) return null;
  let welded, sourceWelds, targetWelds;
  try {
    const weldInfo = weldedVertices(geometry);
    welded = weldInfo.welded;
    const { weldIndexOf } = weldInfo;
    const index = geometry.index;
    const cornerCount = index ? index.count : geometry.getAttribute('position').count;
    const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: cornerCount, materialIndex: 0 }];
    const weldsOfGroup = (materialIndex) => {
      const set = new Set();
      for (const group of groups) {
        if ((group.materialIndex || 0) !== materialIndex) continue;
        for (let corner = group.start; corner < group.start + group.count; corner += 1) {
          set.add(weldIndexOf[index ? index.getX(corner) : corner]);
        }
      }
      return set;
    };
    sourceWelds = weldsOfGroup(sourceIndex);
    targetWelds = weldsOfGroup(targetIndex);
  } finally {
    geometry.dispose();
  }
  const mirror = mirrorPlaneBetween(
    [...sourceWelds].map((weldIndex) => welded[weldIndex]),
    [...targetWelds].map((weldIndex) => welded[weldIndex]),
  );
  if (!mirror) return null;
  const { axis, plane } = mirror;
  const targetByKey = new Map([...targetWelds].map((weldIndex) => [roundedPositionKey(welded[weldIndex]), weldIndex]));
  const offsets = new Map((part.vertexOffsets || []).map((entry) => [entry.i, entry.o]));
  const next = new Map(offsets);
  for (const sourceWeld of sourceWelds) {
    const mirroredBase = [...welded[sourceWeld]];
    mirroredBase[axis] = 2 * plane - mirroredBase[axis];
    const targetWeld = targetByKey.get(roundedPositionKey(mirroredBase));
    if (targetWeld === undefined) return null; // base topology not symmetric — no exact clone
    const offset = offsets.get(sourceWeld);
    if (offset && offset.some((value) => Math.abs(value) > 1e-9)) {
      const mirroredOffset = [...offset];
      mirroredOffset[axis] = -mirroredOffset[axis];
      next.set(targetWeld, mirroredOffset);
    } else {
      next.delete(targetWeld);
    }
  }
  part.vertexOffsets = [...next.entries()]
    .map(([i, o]) => ({ i, o }))
    .filter((entry) => entry.o.some((value) => Math.abs(value) > 1e-9));
  if (!part.vertexOffsets.length) delete part.vertexOffsets;
  return mirror;
}

/**
 * Rebuilds the opposite face of a kind:'mesh' part as an exact mirrored copy
 * of the source face: vertices only the old target face used are dropped, the
 * source triangles (including any added vertices) are mirrored across the
 * plane separating the two faces, boundary vertices re-weld to the surviving
 * mesh where positions line up, and per-corner UVs are carried over so the
 * texture mapping clones too. Returns the mirror plane, or null on failure.
 */
function mirrorMeshFaceGeometry(part, sourceName, targetName) {
  const names = partFaceNames(part);
  const sourceIndex = names.indexOf(sourceName);
  const targetIndex = names.indexOf(targetName);
  if (sourceIndex < 0 || targetIndex < 0) return null;
  const vertices = Array.isArray(part.vertices) ? part.vertices : [];
  const triangles = Array.isArray(part.triangles) ? part.triangles : [];
  const sourceTriangles = triangles.filter((triangle) => (triangle.face || 0) === sourceIndex);
  const targetTriangles = triangles.filter((triangle) => (triangle.face || 0) === targetIndex);
  const otherTriangles = triangles.filter((triangle) => (triangle.face || 0) !== targetIndex);
  if (!sourceTriangles.length || !targetTriangles.length) return null;
  const usedBy = (list) => {
    const set = new Set();
    for (const triangle of list) for (const vertex of triangle.v) set.add(vertex);
    return set;
  };
  const sourceVerts = usedBy(sourceTriangles);
  const targetVerts = usedBy(targetTriangles);
  const survivors = usedBy(otherTriangles);
  const nonSourceVerts = usedBy(triangles.filter((triangle) => (triangle.face || 0) !== sourceIndex));
  // The mirror plane sits halfway between the two faces' boundary rings (the
  // vertices each face shares with the rest of the mesh), so a bulged or
  // hand-edited source face still lands exactly on the opposite side's frame.
  const sourceBoundary = [...sourceVerts].filter((vertex) => nonSourceVerts.has(vertex));
  const targetBoundary = [...targetVerts].filter((vertex) => survivors.has(vertex));
  const sourceBoundaryPoints = (sourceBoundary.length ? sourceBoundary : [...sourceVerts]).map((vertex) => vertices[vertex]);
  const targetBoundaryPoints = (targetBoundary.length ? targetBoundary : [...targetVerts]).map((vertex) => vertices[vertex]);
  const mirror = mirrorPlaneBetween(sourceBoundaryPoints, targetBoundaryPoints);
  if (!mirror) return null;
  const { axis } = mirror;
  // Boundary rings can carry hand-pulled vertices (a roof apex, a notch), so a
  // centroid-based plane skews and nothing re-welds. Take the median of the
  // planes implied by nearest boundary pairs instead: frame vertices outvote
  // the odd sculpted one.
  const across = [0, 1, 2].filter((entry) => entry !== axis);
  const impliedPlanes = sourceBoundaryPoints.map((source) => {
    let best = null;
    let bestDistance = Infinity;
    for (const target of targetBoundaryPoints) {
      const distance = Math.hypot(source[across[0]] - target[across[0]], source[across[1]] - target[across[1]]);
      if (distance < bestDistance) { bestDistance = distance; best = target; }
    }
    return (source[axis] + best[axis]) / 2;
  }).sort((a, b) => a - b);
  const middle = impliedPlanes.length >> 1;
  const plane = impliedPlanes.length % 2
    ? impliedPlanes[middle]
    : (impliedPlanes[middle - 1] + impliedPlanes[middle]) / 2;
  mirror.plane = plane;
  const keptOldIndices = [...survivors].sort((a, b) => a - b);
  const remap = new Map(keptOldIndices.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const newVertices = keptOldIndices.map((oldIndex) => [...vertices[oldIndex]]);
  const mirroredPosition = new Map([...sourceVerts].map((oldIndex) => {
    const position = [...vertices[oldIndex]];
    position[axis] = 2 * plane - position[axis];
    return [oldIndex, position];
  }));
  // Surviving vertices of the OLD target face (its boundary ring, plus any
  // vertex other faces keep alive — e.g. a ridge chord's far apex) are stale
  // geometry the clone replaces. Pair each with its nearest mirrored source
  // vertex and reuse that index, moving it into the mirrored position, so the
  // adjacent faces follow the clone instead of keeping edges to orphan points.
  const staleTargets = [...targetVerts].filter((oldIndex) => survivors.has(oldIndex));
  const candidatePairs = [];
  for (const [sourceIndex, position] of mirroredPosition) {
    for (const targetIndex of staleTargets) {
      const target = vertices[targetIndex];
      const distance = Math.hypot(position[0] - target[0], position[1] - target[1], position[2] - target[2]);
      candidatePairs.push([distance, sourceIndex, targetIndex]);
    }
  }
  candidatePairs.sort((a, b) => a[0] - b[0]);
  const matchedTarget = new Map();
  const takenTargets = new Set();
  for (const [, sourceIndex, targetIndex] of candidatePairs) {
    if (matchedTarget.has(sourceIndex) || takenTargets.has(targetIndex)) continue;
    matchedTarget.set(sourceIndex, targetIndex);
    takenTargets.add(targetIndex);
  }
  for (const [sourceIndex, targetIndex] of matchedTarget) {
    // A vertex both faces share stays put (it mirrors onto itself); everything
    // else snaps to the mirrored source position.
    if (sourceVerts.has(targetIndex)) continue;
    newVertices[remap.get(targetIndex)] = mirroredPosition.get(sourceIndex);
  }
  const byPosition = new Map();
  const mirroredIndex = new Map();
  const mirrorVertex = (oldIndex) => {
    let index = mirroredIndex.get(oldIndex);
    if (index !== undefined) return index;
    const matched = matchedTarget.get(oldIndex);
    if (matched !== undefined) {
      index = remap.get(matched);
    } else {
      const position = mirroredPosition.get(oldIndex);
      const key = roundedPositionKey(position);
      index = byPosition.get(key);
      if (index === undefined) {
        index = newVertices.length;
        newVertices.push(position);
        byPosition.set(key, index);
      }
    }
    mirroredIndex.set(oldIndex, index);
    return index;
  };
  const newTriangles = otherTriangles.map((triangle) => ({ ...triangle, v: triangle.v.map((vertex) => remap.get(vertex)) }));
  for (const triangle of sourceTriangles) {
    // Reversed winding keeps the mirrored copy facing outward.
    const v = [mirrorVertex(triangle.v[0]), mirrorVertex(triangle.v[2]), mirrorVertex(triangle.v[1])];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    const copy = { v, face: targetIndex };
    if (Array.isArray(triangle.uv) && triangle.uv.length === 3) {
      copy.uv = [triangle.uv[0], triangle.uv[2], triangle.uv[1]].map((uv) => [...uv]);
    }
    newTriangles.push(copy);
  }
  if (newTriangles.length === otherTriangles.length) return null; // every mirrored triangle degenerated
  if (newVertices.length > MESH_MAX_VERTICES || newTriangles.length > MESH_MAX_TRIANGLES) return null;
  // A mirrored triangle that degenerated may have been the only user of a
  // freshly added vertex; compact so no orphan handle floats in the part.
  const usedVertices = new Set();
  for (const triangle of newTriangles) for (const vertex of triangle.v) usedVertices.add(vertex);
  if (usedVertices.size !== newVertices.length) {
    const compact = new Map([...usedVertices].sort((a, b) => a - b).map((oldIndex, newIndex) => [oldIndex, newIndex]));
    for (const triangle of newTriangles) triangle.v = triangle.v.map((vertex) => compact.get(vertex));
    const compactVertices = [...compact.keys()].map((oldIndex) => newVertices[oldIndex]);
    newVertices.length = 0;
    newVertices.push(...compactVertices);
  }
  part.vertices = newVertices;
  part.triangles = newTriangles;
  delete part.vertexOffsets; // offsets indexed the old topology
  return mirror;
}

/**
 * Clones `faceName` onto the geometric opposite face of the part, making the
 * opposite an exact mirror image: vertex shape (pulled faces, added mesh
 * vertices), texture, colour, fit, flips — the whole face style. Primitives
 * mirror their vertex offsets; mesh parts get the opposite face's topology
 * rebuilt as a mirror of the source. Returns the target face name, or null
 * when the part has no opposite pair or the clone failed.
 */
export function clonePartFaceToOpposite(part, faceName) {
  if (!part || part.kind === 'asset') return null;
  const targetName = oppositePartFace(part, faceName);
  if (!targetName) return null;
  const mirror = part.kind === 'mesh'
    ? mirrorMeshFaceGeometry(part, faceName, targetName)
    : mirrorPrimitiveFaceOffsets(part, faceName, targetName);
  if (!mirror) return null;
  const style = part.faces?.[faceName] ? structuredClone(part.faces[faceName]) : null;
  if (style) {
    if (validFaceProjection(style.projection)) {
      // Mirror the captured cover projection so the image sits on the same
      // spot of the cloned face instead of re-centering.
      style.projection.origin[mirror.axis] = 2 * mirror.plane - style.projection.origin[mirror.axis];
      style.projection.uVector[mirror.axis] = -style.projection.uVector[mirror.axis];
      style.projection.vVector[mirror.axis] = -style.projection.vVector[mirror.axis];
    } else if (style.fit === 'cover') {
      delete style.projection;
      const projection = capturePartFaceProjection(part, targetName);
      if (projection) style.projection = projection;
    }
    part.faces = part.faces || {};
    part.faces[targetName] = style;
  } else if (part.faces) {
    delete part.faces[targetName];
  }
  return targetName;
}

// ---------------------------------------------------------------------------
// Face splitting and shared projections
// ---------------------------------------------------------------------------

const MAX_FACE_NAMES = 16; // mirrors customAssetsDocumentErrors

const triangleNormal = (a, b, c) => {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const length = Math.hypot(...n);
  return length > 1e-12 ? n.map((value) => value / length) : null;
};

/**
 * Splits one material face of a kind:'mesh' part into its flat regions:
 * connected runs of (nearly) coplanar triangles become separate named faces —
 * "top", "top 2", "top 3" — each stylable on its own. Custom apexes carve a
 * box face into several visual planes; this turns them into real faces. The
 * first region keeps the original name and every new face inherits the
 * original style. Returns { ok: true, faces } with the region face names, or
 * { ok: false, reason } when the face is already a single plane or the part
 * would exceed the face-name budget.
 */
export function splitPartFaceByPlanarRegions(part, faceName, { toleranceDegrees = 6 } = {}) {
  if (part?.kind !== 'mesh') return { ok: false, reason: 'only editable meshes can split faces' };
  const names = partFaceNames(part);
  const materialIndex = names.indexOf(faceName);
  if (materialIndex < 0) return { ok: false, reason: `no face named "${faceName}"` };
  const owned = [];
  part.triangles.forEach((triangle, index) => {
    if ((triangle.face || 0) === materialIndex) owned.push(index);
  });
  if (owned.length < 2) return { ok: false, reason: 'this face is a single flat surface' };
  const normals = new Map(owned.map((index) => {
    const [a, b, c] = part.triangles[index].v.map((vertex) => part.vertices[vertex]);
    return [index, triangleNormal(a, b, c)];
  }));
  const byEdge = new Map();
  for (const index of owned) {
    const { v } = part.triangles[index];
    for (let corner = 0; corner < 3; corner += 1) {
      const key = meshEdgeKey(v[corner], v[(corner + 1) % 3]);
      if (!byEdge.has(key)) byEdge.set(key, []);
      byEdge.get(key).push(index);
    }
  }
  const minDot = Math.cos(toleranceDegrees * Math.PI / 180);
  const regionOf = new Map();
  const regions = [];
  for (const seed of owned) {
    if (regionOf.has(seed)) continue;
    const region = [];
    const queue = [seed];
    regionOf.set(seed, regions.length);
    while (queue.length) {
      const current = queue.pop();
      region.push(current);
      const currentNormal = normals.get(current);
      const { v } = part.triangles[current];
      for (let corner = 0; corner < 3; corner += 1) {
        for (const neighbour of byEdge.get(meshEdgeKey(v[corner], v[(corner + 1) % 3])) || []) {
          if (regionOf.has(neighbour)) continue;
          const neighbourNormal = normals.get(neighbour);
          if (!currentNormal || !neighbourNormal) continue;
          const dot = currentNormal[0] * neighbourNormal[0] + currentNormal[1] * neighbourNormal[1] + currentNormal[2] * neighbourNormal[2];
          if (dot < minDot) continue;
          regionOf.set(neighbour, regions.length);
          queue.push(neighbour);
        }
      }
    }
    regions.push(region);
  }
  if (regions.length < 2) return { ok: false, reason: 'this face is a single flat surface' };
  if (names.length + regions.length - 1 > MAX_FACE_NAMES) {
    return { ok: false, reason: `splitting needs ${regions.length} faces but a part can hold at most ${MAX_FACE_NAMES}` };
  }
  const taken = new Set(names);
  const regionNames = [faceName];
  for (let region = 1, suffix = 2; region < regions.length; region += 1, suffix += 1) {
    let candidate = `${faceName} ${suffix}`;
    while (taken.has(candidate)) { suffix += 1; candidate = `${faceName} ${suffix}`; }
    taken.add(candidate);
    regionNames.push(candidate);
  }
  part.faceNames = [...names, ...regionNames.slice(1)];
  regions.forEach((region, order) => {
    const face = part.faceNames.indexOf(regionNames[order]);
    for (const index of region) part.triangles[index].face = face;
  });
  const style = part.faces?.[faceName];
  if (style) {
    part.faces = part.faces || {};
    for (const name of regionNames.slice(1)) part.faces[name] = structuredClone(style);
  }
  return { ok: true, faces: regionNames };
}

/**
 * One texture plane spanning several faces at once: captures the UV plane of
 * the largest face of the group, then rescales it so the union of all the
 * faces maps exactly onto the [0,1]² image square. Storing the SAME returned
 * projection on every face of the group (fit 'cover') spreads one image
 * continuously across them — edges line up because every face samples the
 * same plane. Returns null when no plane can be derived.
 */
export function captureUnionFaceProjection(part, faceNames) {
  if (!part || part.kind === 'asset' || !Array.isArray(faceNames) || faceNames.length < 1) return null;
  const names = partFaceNames(part);
  const wanted = new Set(faceNames.map((name) => names.indexOf(name)));
  wanted.delete(-1);
  if (!wanted.size) return null;
  const geometry = partGeometry(part);
  if (!geometry) return null;
  applyVertexOffsets(geometry, part.vertexOffsets);
  try {
    const position = geometry.getAttribute('position');
    if (!position) return null;
    const index = geometry.index;
    const cornerCount = index ? index.count : position.count;
    const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: cornerCount, materialIndex: 0 }];
    const point = (corner) => {
      const vertex = index ? index.getX(corner) : corner;
      return [position.getX(vertex), position.getY(vertex), position.getZ(vertex)];
    };
    // Largest face (by area) anchors the projection plane.
    let largest = null;
    let largestArea = -1;
    for (const materialIndex of wanted) {
      let area = 0;
      for (const group of groups.filter((entry) => (entry.materialIndex || 0) === materialIndex)) {
        for (let corner = group.start; corner + 2 < group.start + group.count; corner += 3) {
          const [a, b, c] = [point(corner), point(corner + 1), point(corner + 2)];
          const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          area += Math.hypot(
            u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0],
          ) / 2;
        }
      }
      if (area > largestArea) { largestArea = area; largest = materialIndex; }
    }
    const base = capturePartFaceProjection(part, names[largest]);
    if (!base) return null;
    // Project along the area-weighted average normal of the whole group — a
    // sheet draped over the fold — so no face of the group is edge-on to the
    // image plane, and inherit the largest face's u/v orientation.
    const normal = [0, 0, 0];
    for (const group of groups.filter((entry) => wanted.has(entry.materialIndex || 0))) {
      for (let corner = group.start; corner + 2 < group.start + group.count; corner += 3) {
        const [a, b, c] = [point(corner), point(corner + 1), point(corner + 2)];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        normal[0] += (u[1] * v[2] - u[2] * v[1]) / 2;
        normal[1] += (u[2] * v[0] - u[0] * v[2]) / 2;
        normal[2] += (u[0] * v[1] - u[1] * v[0]) / 2;
      }
    }
    const normalLength = Math.hypot(...normal);
    if (normalLength < 1e-9) return null;
    const unit = normal.map((value) => value / normalLength);
    const flatten = (vector) => {
      const along = vector[0] * unit[0] + vector[1] * unit[1] + vector[2] * unit[2];
      const flat = [vector[0] - along * unit[0], vector[1] - along * unit[1], vector[2] - along * unit[2]];
      const length = Math.hypot(...flat);
      return length > 1e-6 ? flat.map((value) => value / length) : null;
    };
    const uVector = flatten(base.uVector);
    const vVector = flatten(base.vVector) || (uVector && [
      unit[1] * uVector[2] - unit[2] * uVector[1],
      unit[2] * uVector[0] - unit[0] * uVector[2],
      unit[0] * uVector[1] - unit[1] * uVector[0],
    ]);
    if (!uVector || !vVector) return null;
    const origin = base.origin;
    const uu = uVector[0] ** 2 + uVector[1] ** 2 + uVector[2] ** 2;
    const vv = vVector[0] ** 2 + vVector[1] ** 2 + vVector[2] ** 2;
    const uvDot = uVector[0] * vVector[0] + uVector[1] * vVector[1] + uVector[2] * vVector[2];
    const determinant = uu * vv - uvDot * uvDot;
    if (Math.abs(determinant) < 1e-12) return null;
    let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
    for (const group of groups.filter((entry) => wanted.has(entry.materialIndex || 0))) {
      for (let corner = group.start; corner < group.start + group.count; corner += 1) {
        const p = point(corner);
        const delta = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];
        const du = delta[0] * uVector[0] + delta[1] * uVector[1] + delta[2] * uVector[2];
        const dv = delta[0] * vVector[0] + delta[1] * vVector[1] + delta[2] * vVector[2];
        const u = (du * vv - dv * uvDot) / determinant;
        const v = (dv * uu - du * uvDot) / determinant;
        uMin = Math.min(uMin, u); uMax = Math.max(uMax, u);
        vMin = Math.min(vMin, v); vMax = Math.max(vMax, v);
      }
    }
    const uSpan = uMax - uMin;
    const vSpan = vMax - vMin;
    if (!(uSpan > 1e-6) || !(vSpan > 1e-6)) return null;
    return {
      origin: [
        origin[0] + uMin * uVector[0] + vMin * vVector[0],
        origin[1] + uMin * uVector[1] + vMin * vVector[1],
        origin[2] + uMin * uVector[2] + vMin * vVector[2],
      ],
      uvOrigin: [0, 0],
      uVector: uVector.map((value) => value * uSpan),
      vVector: vVector.map((value) => value * vSpan),
      surfaceAspect: (uSpan * Math.sqrt(uu)) / (vSpan * Math.sqrt(vv)),
    };
  } finally {
    geometry.dispose();
  }
}

// ---------------------------------------------------------------------------
// Textures and materials
// ---------------------------------------------------------------------------

const textureCache = new Map();

/**
 * UV transform used by face textures. `cover` preserves the image aspect and
 * samples a centred sub-rectangle, so the mesh itself clips the excess when a
 * rectangular face is reshaped into a triangle or another silhouette.
 */
export function faceTextureTransform({
  fit = 'stretch', imageAspect = 1, surfaceAspect = 1, repeat = null, flipX = false, flipY = false,
} = {}) {
  const safeImageAspect = Number.isFinite(imageAspect) && imageAspect > 0 ? imageAspect : 1;
  const safeSurfaceAspect = Number.isFinite(surfaceAspect) && surfaceAspect > 0 ? surfaceAspect : 1;
  const scale = finiteVector(repeat, 2) ? [...repeat] : [1, 1];
  const offset = [0, 0];
  if (fit === 'cover') {
    scale[0] = 1;
    scale[1] = 1;
    if (safeImageAspect > safeSurfaceAspect) scale[0] = safeSurfaceAspect / safeImageAspect;
    else if (safeImageAspect < safeSurfaceAspect) scale[1] = safeImageAspect / safeSurfaceAspect;
    offset[0] = (1 - scale[0]) * 0.5;
    offset[1] = (1 - scale[1]) * 0.5;
  }
  if (flipX) { offset[0] += scale[0]; scale[0] *= -1; }
  if (flipY) { offset[1] += scale[1]; scale[1] *= -1; }
  return { repeat: scale, offset };
}

/** PSX-flavoured texture from a stored data URL, with per-face crop and flip. */
export function textureFromDataUrl(dataUrl, {
  repeat = null, fit = 'stretch', surfaceAspect = 1, flipX = false, flipY = false,
} = {}) {
  const key = JSON.stringify([dataUrl, repeat, fit, Number(surfaceAspect).toFixed(5), Boolean(flipX), Boolean(flipY)]);
  if (textureCache.has(key)) return textureCache.get(key);
  // Outside the browser (node tests) there is no image decoding: hand back a
  // bare texture object so material wiring stays testable.
  const configure = (texture) => {
    const image = texture.image;
    const width = image?.naturalWidth || image?.videoWidth || image?.width || 1;
    const height = image?.naturalHeight || image?.videoHeight || image?.height || 1;
    const transform = faceTextureTransform({ fit, imageAspect: width / Math.max(height, 1), surfaceAspect, repeat, flipX, flipY });
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    texture.wrapS = fit === 'cover' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    texture.wrapT = fit === 'cover' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    texture.repeat.set(...transform.repeat);
    texture.offset.set(...transform.offset);
    texture.needsUpdate = true;
  };
  const texture = typeof document === 'undefined'
    ? new THREE.Texture()
    : new THREE.TextureLoader().load(dataUrl, configure);
  configure(texture);
  textureCache.set(key, texture);
  return texture;
}

function geometryMaterialAspect(geometry, materialIndex = 0, scale = [1, 1, 1]) {
  const position = geometry?.getAttribute?.('position');
  const uv = geometry?.getAttribute?.('uv');
  if (!position || !uv) return 1;
  const index = geometry.index;
  const cornerCount = index ? index.count : position.count;
  const groups = geometry.groups?.length ? geometry.groups : [{ start: 0, count: cornerCount, materialIndex: 0 }];
  let uLength = 0, vLength = 0, weightSum = 0;
  const point = (corner) => {
    const vertex = index ? index.getX(corner) : corner;
    return new THREE.Vector3(position.getX(vertex) * Math.abs(scale[0] ?? 1), position.getY(vertex) * Math.abs(scale[1] ?? 1), position.getZ(vertex) * Math.abs(scale[2] ?? 1));
  };
  for (const group of groups.filter((entry) => (entry.materialIndex || 0) === materialIndex)) {
    for (let corner = group.start; corner + 2 < group.start + group.count; corner += 3) {
      const vertices = [corner, corner + 1, corner + 2].map((entry) => index ? index.getX(entry) : entry);
      const p0 = point(corner), p1 = point(corner + 1), p2 = point(corner + 2);
      const e1 = p1.sub(p0), e2 = p2.sub(p0);
      const du1 = uv.getX(vertices[1]) - uv.getX(vertices[0]);
      const dv1 = uv.getY(vertices[1]) - uv.getY(vertices[0]);
      const du2 = uv.getX(vertices[2]) - uv.getX(vertices[0]);
      const dv2 = uv.getY(vertices[2]) - uv.getY(vertices[0]);
      const determinant = du1 * dv2 - du2 * dv1;
      if (Math.abs(determinant) < 1e-8) continue;
      const dPdu = e1.clone().multiplyScalar(dv2).addScaledVector(e2, -dv1).multiplyScalar(1 / determinant);
      const dPdv = e1.clone().multiplyScalar(-du2).addScaledVector(e2, du1).multiplyScalar(1 / determinant);
      const weight = Math.abs(determinant);
      uLength += dPdu.length() * weight;
      vLength += dPdv.length() * weight;
      weightSum += weight;
    }
  }
  if (!weightSum || vLength < 1e-8) return 1;
  return Math.min(1000, Math.max(0.001, uLength / vLength));
}

/**
 * Captures the current UV plane of one face. A cover texture keeps this plane
 * after later vertex edits, so reshaping the mesh reveals/crops the same image
 * instead of pulling the image along with every moved vertex.
 */
export function capturePartFaceProjection(part, faceName) {
  if (!part || part.kind === 'asset') return null;
  const materialIndex = partFaceNames(part).indexOf(faceName);
  if (materialIndex < 0) return null;
  const geometry = partGeometry(part);
  if (!geometry) return null;
  applyVertexOffsets(geometry, part.vertexOffsets);
  try {
    const position = geometry.getAttribute('position');
    const uv = geometry.getAttribute('uv');
    if (!position || !uv) return null;
    const index = geometry.index;
    const cornerCount = index ? index.count : position.count;
    const groups = geometry.groups?.length
      ? geometry.groups
      : [{ start: 0, count: cornerCount, materialIndex: 0 }];
    const point = (corner) => {
      const vertex = index ? index.getX(corner) : corner;
      return new THREE.Vector3(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
    };
    for (const group of groups.filter((entry) => (entry.materialIndex || 0) === materialIndex)) {
      for (let corner = group.start; corner + 2 < group.start + group.count; corner += 3) {
        const vertices = [corner, corner + 1, corner + 2].map((entry) => index ? index.getX(entry) : entry);
        const p0 = point(corner), p1 = point(corner + 1), p2 = point(corner + 2);
        const e1 = p1.clone().sub(p0), e2 = p2.clone().sub(p0);
        const du1 = uv.getX(vertices[1]) - uv.getX(vertices[0]);
        const dv1 = uv.getY(vertices[1]) - uv.getY(vertices[0]);
        const du2 = uv.getX(vertices[2]) - uv.getX(vertices[0]);
        const dv2 = uv.getY(vertices[2]) - uv.getY(vertices[0]);
        const determinant = du1 * dv2 - du2 * dv1;
        if (Math.abs(determinant) < 1e-8) continue;
        const uVector = e1.clone().multiplyScalar(dv2).addScaledVector(e2, -dv1).multiplyScalar(1 / determinant);
        const vVector = e1.clone().multiplyScalar(-du2).addScaledVector(e2, du1).multiplyScalar(1 / determinant);
        if (uVector.clone().cross(vVector).lengthSq() < 1e-12) continue;
        return {
          origin: p0.toArray(),
          uvOrigin: [uv.getX(vertices[0]), uv.getY(vertices[0])],
          uVector: uVector.toArray(),
          vVector: vVector.toArray(),
          surfaceAspect: geometryMaterialAspect(geometry, materialIndex, part.scale || [1, 1, 1]),
        };
      }
    }
    return null;
  } finally {
    geometry.dispose();
  }
}

/** Reprojects cover-textured faces through their captured, fixed UV planes. */
export function applyPartFaceProjections(geometry, part) {
  const position = geometry?.getAttribute?.('position');
  const uv = geometry?.getAttribute?.('uv');
  if (!position || !uv || !part) return geometry;
  const index = geometry.index;
  const cornerCount = index ? index.count : position.count;
  const groups = geometry.groups?.length
    ? geometry.groups
    : [{ start: 0, count: cornerCount, materialIndex: 0 }];
  let changed = false;
  partFaceNames(part).forEach((faceName, materialIndex) => {
    const style = part.faces?.[faceName];
    const projection = style?.projection;
    if (style?.fit !== 'cover' || !validFaceProjection(projection)) return;
    const origin = new THREE.Vector3().fromArray(projection.origin);
    const uVector = new THREE.Vector3().fromArray(projection.uVector);
    const vVector = new THREE.Vector3().fromArray(projection.vVector);
    const uu = uVector.dot(uVector), uvDot = uVector.dot(vVector), vv = vVector.dot(vVector);
    const determinant = uu * vv - uvDot * uvDot;
    if (Math.abs(determinant) < 1e-12) return;
    for (const group of groups.filter((entry) => (entry.materialIndex || 0) === materialIndex)) {
      for (let corner = group.start; corner < group.start + group.count; corner += 1) {
        const vertex = index ? index.getX(corner) : corner;
        const delta = new THREE.Vector3(
          position.getX(vertex) - origin.x,
          position.getY(vertex) - origin.y,
          position.getZ(vertex) - origin.z,
        );
        const du = delta.dot(uVector), dv = delta.dot(vVector);
        const u = (du * vv - dv * uvDot) / determinant;
        const v = (dv * uu - du * uvDot) / determinant;
        uv.setXY(vertex, projection.uvOrigin[0] + u, projection.uvOrigin[1] + v);
        changed = true;
      }
    }
  });
  if (changed) uv.needsUpdate = true;
  return geometry;
}

function faceMaterial(part, faceName, texturesById, surfaceAspect = 1) {
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
      fit: style.fit === 'cover' ? 'cover' : 'stretch',
      surfaceAspect,
      flipX: Boolean(style.flipX),
      flipY: Boolean(style.flipY),
    });
    parameters.color = new THREE.Color('#ffffff');
    // PSX-style cutout: pixels erased to transparency in the texture editor
    // punch through instead of rendering as opaque black.
    parameters.alphaTest = 0.5;
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
    applyPartFaceProjections(geometry, part);
    const materials = partFaceNames(part).map((faceName, materialIndex) => faceMaterial(
      part,
      faceName,
      texturesById,
      part.faces?.[faceName]?.fit === 'cover' && validFaceProjection(part.faces[faceName].projection)
        ? part.faces[faceName].projection.surfaceAspect
        : geometryMaterialAspect(geometry, materialIndex, part.scale || [1, 1, 1]),
    ));
    node = new THREE.Mesh(geometry, materials.length === 1 ? materials[0] : materials);
  }
  node.name = part.name || PART_KINDS[part.kind].label;
  if (finiteVector(part.position, 3)) node.position.fromArray(part.position);
  if (finiteVector(part.rotation, 3)) node.rotation.set(part.rotation[0], part.rotation[1], part.rotation[2]);
  if (finiteVector(part.scale, 3)) node.scale.fromArray(part.scale);
  return node;
}

const GEOMETRY_FACE_NAMES = Object.freeze({
  BoxGeometry: ['right', 'left', 'top', 'bottom', 'front', 'back'],
  CylinderGeometry: ['side', 'top', 'bottom'],
  ConeGeometry: ['side', 'bottom'],
  PlaneGeometry: ['face'],
  SphereGeometry: ['surface'],
});

function objectMeshes(root) {
  const meshes = [];
  root?.traverse?.((object) => { if (object.isMesh && !object.isInstancedMesh) meshes.push(object); });
  if (root?.isMesh && !root.isInstancedMesh && !meshes.includes(root)) meshes.unshift(root);
  return meshes;
}

function meshMaterialIndices(mesh) {
  const fromGroups = [...new Set((mesh.geometry?.groups || []).map((group) => group.materialIndex || 0))];
  if (fromGroups.length) return fromGroups.sort((a, b) => a - b);
  if (Array.isArray(mesh.material)) return mesh.material.map((_, index) => index);
  return [0];
}

/** Enumerates stable mesh/material face slots for the Map Editor inspector. */
export function objectFaceSlots(root) {
  const meshes = objectMeshes(root);
  const slots = [];
  meshes.forEach((mesh, meshIndex) => {
    const indices = meshMaterialIndices(mesh);
    const knownNames = GEOMETRY_FACE_NAMES[mesh.geometry?.type];
    const meshLabel = mesh.name || mesh.geometry?.name || `Mesh ${meshIndex + 1}`;
    const baseMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const materialIndex of indices) {
      const material = baseMaterials[materialIndex] || baseMaterials[0] || null;
      slots.push({
        key: `${meshIndex}:${materialIndex}`,
        meshIndex,
        materialIndex,
        mesh,
        meshLabel,
        faceName: knownNames?.[materialIndex] || material?.name || `face ${materialIndex + 1}`,
        materialName: material?.name || material?.type || 'material',
      });
    }
  });
  return slots;
}

const FACE_MATERIAL_STATE = '__hesiFaceMaterialState';

function restoreMeshFaceMaterials(mesh) {
  const state = mesh.userData?.[FACE_MATERIAL_STATE];
  if (!state) return;
  const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of current) if (material && !state.materials.includes(material)) material.dispose?.();
  mesh.material = state.wasArray ? state.materials : state.materials[0];
  delete mesh.userData[FACE_MATERIAL_STATE];
}

/** Restores the generated/original materials after removing Map Editor styles. */
export function clearObjectFaceStyles(root) {
  for (const mesh of objectMeshes(root)) restoreMeshFaceMaterials(mesh);
}

/** Applies persisted Map Editor texture styles to individual material/face slots. */
export function applyObjectFaceStyles(root, faceStyles = {}, texturesById = {}) {
  const meshes = objectMeshes(root);
  for (const mesh of meshes) restoreMeshFaceMaterials(mesh);
  if (!isRecord(faceStyles) || !Object.keys(faceStyles).length) return 0;
  root?.updateWorldMatrix?.(true, true);
  let applied = 0;
  meshes.forEach((mesh, meshIndex) => {
    const entries = Object.entries(faceStyles).filter(([key, style]) => key.startsWith(`${meshIndex}:`) && isRecord(style) && style.texture);
    if (!entries.length) return;
    const base = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const wasArray = Array.isArray(mesh.material);
    const maxIndex = Math.max(...meshMaterialIndices(mesh), ...entries.map(([key]) => Number(key.split(':')[1]) || 0));
    const materials = Array.from({ length: maxIndex + 1 }, (_, index) => (base[index] || base[0])?.clone?.() || base[index] || base[0]);
    mesh.userData[FACE_MATERIAL_STATE] = { materials: base, wasArray };
    const worldScale = mesh.getWorldScale?.(new THREE.Vector3()) || new THREE.Vector3(1, 1, 1);
    for (const [key, style] of entries) {
      const materialIndex = Number(key.split(':')[1]);
      const textureRecord = texturesById?.[style.texture];
      const material = materials[materialIndex];
      if (!material || !textureRecord?.dataUrl) continue;
      material.map = textureFromDataUrl(textureRecord.dataUrl, {
        repeat: finiteVector(style.repeat, 2) ? style.repeat : null,
        fit: style.fit === 'cover' ? 'cover' : 'stretch',
        surfaceAspect: geometryMaterialAspect(mesh.geometry, materialIndex, worldScale.toArray()),
        flipX: Boolean(style.flipX),
        flipY: Boolean(style.flipY),
      });
      material.color?.set?.('#ffffff');
      material.alphaTest = 0.5; // transparent texture pixels punch through
      material.needsUpdate = true;
      applied += 1;
    }
    mesh.material = materials.length === 1 && !wasArray ? materials[0] : materials;
  });
  return applied;
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
