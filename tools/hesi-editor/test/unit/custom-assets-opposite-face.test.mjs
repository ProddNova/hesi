import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capturePartFaceProjection,
  clonePartFaceToOpposite,
  convertPartToMesh,
  customAssetsDocumentErrors,
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
