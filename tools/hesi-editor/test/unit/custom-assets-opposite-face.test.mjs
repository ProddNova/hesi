import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capturePartFaceProjection,
  clonePartFaceToOpposite,
  convertPartToMesh,
  customAssetsDocumentErrors,
  meshInsertVertexAtPoint,
  oppositePartFace,
  partFaceNames,
  translatePartFace,
} from '../../../../js/custom-assets.js';

const boxPart = (extra = {}) => ({
  kind: 'box', name: 'Box', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#9aa7b5', faces: {}, ...extra,
});

function partDocument(part, textureIds = []) {
  return {
    version: 1,
    assets: { 'custom:0001': { id: 'custom:0001', label: 'Thing', parts: [part] } },
    textures: Object.fromEntries(textureIds.map((id) => [id, { name: id, dataUrl: 'data:image/png;base64,AA==' }])),
    worldTextures: {},
  };
}

const sortedOffsets = (part) => [...(part.vertexOffsets || [])].sort((a, b) => a.i - b.i);

test('oppositePartFace knows the geometric pairs of each part kind', () => {
  const box = boxPart();
  assert.equal(oppositePartFace(box, 'front'), 'back');
  assert.equal(oppositePartFace(box, 'left'), 'right');
  assert.equal(oppositePartFace(box, 'bottom'), 'top');
  assert.equal(oppositePartFace({ kind: 'cylinder' }, 'top'), 'bottom');
  assert.equal(oppositePartFace({ kind: 'cylinder' }, 'side'), null);
  assert.equal(oppositePartFace({ kind: 'wedge' }, 'left'), 'right');
  assert.equal(oppositePartFace({ kind: 'wedge' }, 'back'), null); // a wedge has no front
  assert.equal(oppositePartFace({ kind: 'pyramid' }, 'side'), null);
  assert.equal(oppositePartFace({ kind: 'plane' }, 'face'), null);
  assert.equal(oppositePartFace({ kind: 'asset' }, 'front'), null);
  // Mesh parts inherit the pairs of the primitive they were converted from.
  const mesh = convertPartToMesh(boxPart());
  assert.equal(oppositePartFace(mesh, 'front'), 'back');
});

test('primitive clone mirrors the pulled face and copies the style', () => {
  const part = boxPart();
  translatePartFace(part, 'front', [0.2, 0.1, 0.3]);
  part.faces.front = { texture: 'tex:sign', fit: 'stretch', flipX: true };
  assert.equal(clonePartFaceToOpposite(part, 'front'), 'back');
  // The back face must carry the exact mirrored offsets of the front pull.
  const expected = boxPart();
  translatePartFace(expected, 'front', [0.2, 0.1, 0.3]);
  translatePartFace(expected, 'back', [0.2, 0.1, -0.3]);
  assert.deepEqual(sortedOffsets(part), sortedOffsets(expected));
  assert.deepEqual(part.faces.back, { texture: 'tex:sign', fit: 'stretch', flipX: true });
  assert.notEqual(part.faces.back, part.faces.front); // deep copy, not shared
  assert.deepEqual(customAssetsDocumentErrors(partDocument(part, ['tex:sign'])), []);
});

test('cloning an untouched face resets previous edits of the opposite face', () => {
  const part = boxPart();
  translatePartFace(part, 'back', [0, 0, -0.4]);
  part.faces.back = { color: '#ff0000' };
  assert.equal(clonePartFaceToOpposite(part, 'front'), 'back');
  assert.equal(part.vertexOffsets, undefined);
  assert.equal(part.faces.back, undefined);
});

test('cylinder top clones onto bottom through the shared rim welds', () => {
  const part = { kind: 'cylinder', name: 'Cyl', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], faces: {} };
  translatePartFace(part, 'top', [0, 0.3, 0]);
  assert.equal(clonePartFaceToOpposite(part, 'top'), 'bottom');
  const expected = { kind: 'cylinder', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], faces: {} };
  translatePartFace(expected, 'top', [0, 0.3, 0]);
  translatePartFace(expected, 'bottom', [0, -0.3, 0]);
  assert.deepEqual(sortedOffsets(part), sortedOffsets(expected));
});

test('a captured cover projection is mirrored, not re-centred', () => {
  const part = boxPart();
  const projection = capturePartFaceProjection(part, 'front');
  assert.ok(projection);
  part.faces.front = { texture: 'tex:photo', fit: 'cover', projection };
  assert.equal(clonePartFaceToOpposite(part, 'front'), 'back');
  const mirrored = part.faces.back.projection;
  assert.ok(mirrored);
  assert.ok(Math.abs(mirrored.origin[2] + projection.origin[2]) < 1e-9);
  assert.ok(Math.abs(mirrored.uVector[2] + projection.uVector[2]) < 1e-9);
  assert.ok(Math.abs(mirrored.vVector[2] + projection.vVector[2]) < 1e-9);
  assert.equal(mirrored.surfaceAspect, projection.surfaceAspect);
  // The source face keeps its own projection untouched.
  assert.deepEqual(part.faces.front.projection, projection);
});

// Every edge of a closed mesh must be shared by exactly two triangles;
// anything else is a crack or an overlapping polygon.
const nonManifoldEdges = (part) => {
  const edges = new Map();
  for (const triangle of part.triangles) {
    for (let corner = 0; corner < 3; corner += 1) {
      const a = triangle.v[corner];
      const b = triangle.v[(corner + 1) % 3];
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  return [...edges.entries()].filter(([, count]) => count !== 2);
};

test('mesh clone with a ridge apex snaps the stale far apex instead of duplicating it', () => {
  // Inserting near the front/top shared edge splits it and pairs a far apex,
  // connected by a chord across the top face — the two-apex roof workflow.
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const added = meshInsertVertexAtPoint(part, [0, 0.49, 0.5], { faceIndex: names.indexOf('front') });
  assert.ok(added);
  assert.equal(added.connected, true);
  // Pull only the front apex: the mesh is now asymmetric.
  part.vertices[added.vertexIndex] = [0.1, 0.85, 0.4];
  const vertexCount = part.vertices.length;
  assert.equal(clonePartFaceToOpposite(part, 'front'), 'back');
  // The far apex must MOVE to the mirrored position (the top-face ridge
  // triangles reference it), not linger while a duplicate is added.
  assert.equal(part.vertices.length, vertexCount);
  const farApex = part.vertices[added.oppositeVertexIndex];
  assert.deepEqual(farApex, [0.1, 0.85, -0.4]);
  assert.deepEqual(nonManifoldEdges(part), []);
  assert.deepEqual(customAssetsDocumentErrors(partDocument(part)), []);
});

test('mesh clone re-welds the frame even when the boundary carries pulled vertices', () => {
  // A notch: the shared-edge vertex is pushed down into the face, skewing the
  // boundary ring the mirror plane is derived from.
  const part = convertPartToMesh(boxPart());
  const names = partFaceNames(part);
  const added = meshInsertVertexAtPoint(part, [0, 0.49, 0.5], { faceIndex: names.indexOf('front') });
  assert.ok(added);
  part.vertices[added.vertexIndex] = [0, 0.1, 0.5];
  const vertexCount = part.vertices.length;
  assert.equal(clonePartFaceToOpposite(part, 'front'), 'back');
  assert.equal(part.vertices.length, vertexCount);
  assert.deepEqual(part.vertices[added.oppositeVertexIndex], [0, 0.1, -0.5]);
  // The box corners stay single, exactly on the frame.
  for (const corner of [[0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5]]) {
    const matches = part.vertices.filter(
      (vertex) => vertex.every((value, axis) => Math.abs(value - corner[axis]) < 0.06),
    );
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0], corner);
  }
  assert.deepEqual(nonManifoldEdges(part), []);
});

test('mesh clone rebuilds the opposite face as an exact mirror, points included', () => {
  const part = convertPartToMesh(boxPart({ subdivisions: 2 }));
  const names = partFaceNames(part);
  const frontIndex = names.indexOf('front');
  const backIndex = names.indexOf('back');
  const findVertex = (target) => part.vertices.findIndex(
    (vertex) => vertex.every((value, axis) => Math.abs(value - target[axis]) < 1e-6),
  );
  // Sculpt the front: pull its centre vertex out into a bump.
  const frontCentre = findVertex([0, 0, 0.5]);
  assert.ok(frontCentre >= 0);
  part.vertices[frontCentre] = [0.1, 0.2, 0.8];
  part.faces.front = { color: '#123456' };
  const vertexCount = part.vertices.length;
  const frontTriangles = part.triangles.filter((triangle) => triangle.face === frontIndex);
  assert.equal(clonePartFaceToOpposite(part, 'front'), 'back');
  // Same topology on the mirrored side, boundary re-welded to the box frame.
  const backTriangles = part.triangles.filter((triangle) => triangle.face === backIndex);
  assert.equal(backTriangles.length, frontTriangles.length);
  assert.equal(part.vertices.length, vertexCount);
  assert.ok(findVertex([0.1, 0.2, -0.8]) >= 0); // the bump, mirrored
  assert.equal(findVertex([0, 0, -0.5]), -1); // the old flat back centre is gone
  assert.deepEqual(customAssetsDocumentErrors(partDocument(part)), []);
  // Winding stays outward (normals point towards -z) and UVs are carried over.
  for (const triangle of backTriangles) {
    const [a, b, c] = triangle.v.map((vertex) => part.vertices[vertex]);
    const normalZ = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    assert.ok(normalZ < 0);
    assert.equal(triangle.uv?.length, 3);
  }
  assert.deepEqual(part.faces.back, { color: '#123456' });
});
