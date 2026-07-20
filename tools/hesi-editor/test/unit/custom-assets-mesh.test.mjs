import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  PART_KINDS,
  applyVertexOffsets,
  buildPartObject,
  convertPartToMesh,
  customAssetsDocumentErrors,
  meshInsertVertexAtPoint,
  meshRemoveVertex,
  meshTopologyIssues,
  partFaceNames,
  partGeometry,
  translatePartFace,
  weldedVertices,
} from '../../../../js/custom-assets.js';

// A minimal square: two triangles sharing the 1-2 diagonal, explicit UVs.
function squareMesh() {
  return {
    kind: 'mesh',
    name: 'Square',
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
    triangles: [
      { v: [0, 1, 2], face: 0, uv: [[0, 0], [1, 0], [0, 1]] },
      { v: [2, 1, 3], face: 0, uv: [[0, 1], [1, 0], [1, 1]] },
    ],
    faceNames: ['surface'],
    faces: {},
  };
}

function meshDocument(part) {
  return {
    version: 1,
    assets: { 'custom:0001': { id: 'custom:0001', label: 'Mesh thing', parts: [part] } },
    textures: {},
    worldTextures: {},
  };
}

test('mesh parts validate; broken topology is rejected', () => {
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(squareMesh())), []);
  const badIndex = squareMesh();
  badIndex.triangles[0].v = [0, 1, 9];
  assert.ok(customAssetsDocumentErrors(meshDocument(badIndex)).some((error) => error.includes('vertex indices')));
  const duplicateCorner = squareMesh();
  duplicateCorner.triangles[0].v = [0, 1, 1];
  assert.ok(customAssetsDocumentErrors(meshDocument(duplicateCorner)).some((error) => error.includes('distinct')));
  const badFaceGroup = squareMesh();
  badFaceGroup.triangles[0].face = 4;
  assert.ok(customAssetsDocumentErrors(meshDocument(badFaceGroup)).some((error) => error.includes('face names')));
  const tooFewVertices = squareMesh();
  tooFewVertices.vertices = [[0, 0, 0], [1, 0, 0]];
  assert.ok(customAssetsDocumentErrors(meshDocument(tooFewVertices)).length > 0);
  const badNames = squareMesh();
  badNames.faceNames = ['surface', 'surface'];
  assert.ok(customAssetsDocumentErrors(meshDocument(badNames)).some((error) => error.includes('faceNames')));
});

test('converting a box yields its welded corners, face groups, and UVs', () => {
  const box = { kind: 'box', name: 'Crate', position: [1, 2, 3], scale: [2, 1, 1], color: '#336699', faces: { top: { color: '#ff0000' } } };
  const mesh = convertPartToMesh(box);
  assert.equal(mesh.kind, 'mesh');
  assert.equal(mesh.vertices.length, 8, 'a box has 8 welded corners');
  assert.equal(mesh.triangles.length, 12, 'a box has 12 triangles');
  assert.deepEqual(mesh.faceNames, PART_KINDS.box.faces);
  assert.deepEqual(mesh.position, [1, 2, 3]);
  assert.deepEqual(mesh.faces.top, { color: '#ff0000' }, 'face styles survive conversion');
  assert.ok(mesh.triangles.every((triangle) => Array.isArray(triangle.uv) && triangle.uv.length === 3), 'source UVs are captured');
  const groupsUsed = new Set(mesh.triangles.map((triangle) => triangle.face));
  assert.equal(groupsUsed.size, 6, 'every box face keeps its own material group');
  // The built geometry mirrors the primitive: same welded corners, one
  // non-empty group per face, and a material array aligned with faceNames.
  const geometry = partGeometry(mesh);
  assert.equal(weldedVertices(geometry).welded.length, 8);
  assert.equal(geometry.groups.length, 6);
  const built = buildPartObject(mesh, {});
  assert.equal(built.material.length, 6);
  assert.equal(built.material[2].color.getHexString(), 'ff0000');
  geometry.dispose();
});

test('conversion happens in the vertex-handle index space (weld order + baked offsets)', () => {
  const box = { kind: 'box', vertexOffsets: [{ i: 0, o: [0.25, 0, 0] }] };
  const base = partGeometry({ kind: 'box' });
  const { welded } = weldedVertices(base);
  base.dispose();
  const mesh = convertPartToMesh(box);
  // Same order as the modeler's handles: index 0 is weld index 0, moved by its offset.
  assert.deepEqual(mesh.vertices[0], [welded[0][0] + 0.25, welded[0][1], welded[0][2]]);
  for (let index = 1; index < welded.length; index += 1) {
    assert.deepEqual(mesh.vertices[index], welded[index]);
  }
  assert.equal(mesh.vertexOffsets, undefined, 'offsets are baked, not carried');
});

test('a converted plane keeps rendering double-sided through its face style', () => {
  const plane = { kind: 'plane', faces: { face: { color: '#00ff00' } } };
  const mesh = convertPartToMesh(plane);
  assert.equal(mesh.faces.face.doubleSide, true);
  assert.equal(mesh.faces.face.color, '#00ff00');
  const built = buildPartObject(mesh, {});
  const material = Array.isArray(built.material) ? built.material[0] : built.material;
  assert.equal(material.side, THREE.DoubleSide);
});

test('assembled asset parts cannot convert; meshes convert to themselves', () => {
  assert.equal(convertPartToMesh({ kind: 'asset', assetRef: 'x' }), null);
  const mesh = squareMesh();
  assert.equal(convertPartToMesh(mesh), mesh);
});

test('an interior right-click point fans the containing triangle into three', () => {
  const mesh = squareMesh();
  const added = meshInsertVertexAtPoint(mesh, [0.2, 0.25, 0]);
  assert.equal(added.split, 'face');
  assert.equal(added.vertexIndex, 4);
  assert.equal(mesh.vertices.length, 5);
  assert.equal(mesh.triangles.length, 4, 'one triangle became three');
  const [x, y, z] = mesh.vertices[4];
  assert.ok(Math.abs(x - 0.2) < 1e-6 && Math.abs(y - 0.25) < 1e-6 && Math.abs(z) < 1e-6);
  // Barycentric UV: for this planar square the uv equals the position.
  const withNew = mesh.triangles.filter((triangle) => triangle.v.includes(4));
  assert.equal(withNew.length, 3);
  for (const triangle of withNew) {
    const corner = triangle.v.indexOf(4);
    assert.ok(Math.abs(triangle.uv[corner][0] - 0.2) < 1e-6);
    assert.ok(Math.abs(triangle.uv[corner][1] - 0.25) < 1e-6);
  }
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(mesh)), [], 'edited mesh still validates');
});

test('an interior apex on a closed mesh is also created on the opposite face', () => {
  const mesh = convertPartToMesh({ kind: 'box' });
  const added = meshInsertVertexAtPoint(mesh, [0, 0.25, 0.5], { faceIndex: 4 });

  assert.equal(added.split, 'face');
  assert.equal(added.oppositeSplit, 'face');
  assert.equal(added.vertexIndex, 8);
  assert.equal(added.oppositeVertexIndex, 9);
  assert.deepEqual(mesh.vertices[8], [0, 0.25, 0.5]);
  assert.deepEqual(mesh.vertices[9], [0, 0.25, -0.5]);
  assert.equal(mesh.triangles.length, 16, 'both opposing triangles fan into three');
  assert.ok(mesh.triangles.some((triangle) => triangle.face === 4 && triangle.v.includes(8)));
  assert.ok(mesh.triangles.some((triangle) => triangle.face === 5 && triangle.v.includes(9)));
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(mesh)), []);
});

test('opposite edge apexes are joined across their shared planar face', () => {
  const mesh = convertPartToMesh({ kind: 'box' });
  const added = meshInsertVertexAtPoint(mesh, [0.5, 0.5, 0], { faceIndex: 0 });

  assert.equal(added.split, 'edge');
  assert.equal(added.oppositeSplit, 'edge');
  assert.equal(added.connected, true);
  assert.deepEqual(mesh.vertices[added.vertexIndex], [0.5, 0.5, 0]);
  assert.deepEqual(mesh.vertices[added.oppositeVertexIndex], [-0.5, 0.5, 0]);
  assert.ok(mesh.triangles.some((triangle) => triangle.face === 2
    && triangle.v.includes(added.vertexIndex)
    && triangle.v.includes(added.oppositeVertexIndex)), 'the top face contains the new ridge edge');
  assert.equal(mesh.triangles.length, 16);
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(mesh)), []);
});

test('a right-click near a shared edge splits BOTH adjacent triangles', () => {
  const mesh = squareMesh();
  // Near the middle of the 1-2 diagonal (the shared edge).
  const added = meshInsertVertexAtPoint(mesh, [0.5, 0.5, 0]);
  assert.equal(added.split, 'edge');
  assert.equal(mesh.vertices.length, 5);
  assert.equal(mesh.triangles.length, 4, 'both neighbours split into two');
  const [x, y] = mesh.vertices[4];
  assert.ok(Math.abs(x - 0.5) < 1e-6 && Math.abs(y - 0.5) < 1e-6, 'new vertex sits on the edge');
  // Texture continuity: every corner using the new vertex interpolates the
  // edge UVs to the same value.
  for (const triangle of mesh.triangles.filter((entry) => entry.v.includes(4))) {
    const corner = triangle.v.indexOf(4);
    assert.ok(Math.abs(triangle.uv[corner][0] - 0.5) < 1e-6);
    assert.ok(Math.abs(triangle.uv[corner][1] - 0.5) < 1e-6);
  }
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(mesh)), []);
});

test('a right-click (almost) on an existing vertex snaps instead of adding a sliver', () => {
  const mesh = squareMesh();
  const added = meshInsertVertexAtPoint(mesh, [0.98, 0.01, 0]);
  assert.equal(added.split, 'corner');
  assert.equal(added.vertexIndex, 1, 'the nearby corner is reused');
  assert.equal(mesh.vertices.length, 4, 'no vertex was added');
  assert.equal(mesh.triangles.length, 2, 'topology is untouched');
});

test('a ridge still forms when the shared face already has custom vertices', () => {
  const mesh = convertPartToMesh({ kind: 'box' });
  // Hand-add an interior detail vertex on the top face, away from the ridge.
  const detail = meshInsertVertexAtPoint(mesh, [0.2, 0.5, 0.35], { faceIndex: 2, mirrorOpposite: false });
  assert.equal(detail.split, 'face');
  const added = meshInsertVertexAtPoint(mesh, [0.5, 0.5, 0], { faceIndex: 0 });
  assert.equal(added.connected, true, 'the ridge is created despite the extra vertex');
  assert.ok(mesh.triangles.some((triangle) => (triangle.face || 0) === 2
    && triangle.v.includes(added.vertexIndex)
    && triangle.v.includes(added.oppositeVertexIndex)), 'the top face contains the new ridge edge');
  assert.ok(mesh.triangles.some((triangle) => triangle.v.includes(detail.vertexIndex)),
    'the hand-added vertex survives the retriangulation');
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(mesh)), []);
});

test('pulling a whole face moves every vertex of that face', () => {
  // Primitive: the four welded top corners of a box gain the same offset.
  const box = { kind: 'box' };
  assert.equal(translatePartFace(box, 'top', [0, 0.5, 0]), true);
  assert.equal(box.vertexOffsets.length, 4);
  assert.ok(box.vertexOffsets.every((entry) => entry.o[1] === 0.5));
  const geometry = partGeometry(box);
  applyVertexOffsets(geometry, box.vertexOffsets);
  const position = geometry.getAttribute('position');
  let maxY = -Infinity;
  for (let index = 0; index < position.count; index += 1) maxY = Math.max(maxY, position.getY(index));
  assert.ok(Math.abs(maxY - 1.0) < 1e-6, 'the top face rose by half a metre');
  geometry.dispose();
  // Pulling again accumulates into the same offsets.
  assert.equal(translatePartFace(box, 'top', [0, 0.25, 0]), true);
  assert.ok(box.vertexOffsets.every((entry) => Math.abs(entry.o[1] - 0.75) < 1e-9));
  // Mesh parts move their vertices directly.
  const mesh = squareMesh();
  assert.equal(translatePartFace(mesh, 'surface', [1, 0, 0]), true);
  assert.deepEqual(mesh.vertices[0], [1, 0, 0]);
  assert.deepEqual(mesh.vertices[3], [2, 1, 0]);
  // Unknown faces and assembled assets are refused.
  assert.equal(translatePartFace(box, 'nope', [0, 1, 0]), false);
  assert.equal(translatePartFace({ kind: 'asset', assetRef: 'x' }, 'top', [0, 1, 0]), false);
});

test('removing a vertex drops its faces and compacts the mesh; floors hold', () => {
  const box = convertPartToMesh({ kind: 'box' });
  const before = box.triangles.length;
  assert.equal(meshRemoveVertex(box, 0), true);
  assert.equal(box.vertices.length, 7);
  assert.ok(box.triangles.length < before, 'triangles using the corner were dropped');
  assert.ok(box.triangles.every((triangle) => triangle.v.every((vertex) => vertex >= 0 && vertex < box.vertices.length)));
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(box)), [], 'compacted mesh still validates');
  // A single triangle refuses to lose a vertex (nothing would remain).
  const minimal = {
    kind: 'mesh',
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    triangles: [{ v: [0, 1, 2], face: 0 }],
  };
  assert.equal(meshRemoveVertex(minimal, 0), false);
  assert.equal(minimal.vertices.length, 3, 'refusal leaves the mesh untouched');
  assert.equal(meshRemoveVertex(box, 99), false, 'unknown index is refused');
});

test('face names are dynamic for meshes and static for primitives', () => {
  assert.deepEqual(partFaceNames({ kind: 'box' }), PART_KINDS.box.faces);
  assert.deepEqual(partFaceNames({ kind: 'mesh' }), ['surface']);
  assert.deepEqual(partFaceNames({ kind: 'mesh', faceNames: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(partFaceNames({ kind: 'asset' }), []);
});

test('meshes without stored UVs still build with planar fallback UVs', () => {
  const mesh = {
    kind: 'mesh',
    vertices: [[-0.5, 0, -0.5], [0.5, 0, -0.5], [0.5, 0, 0.5]],
    triangles: [{ v: [0, 1, 2], face: 0 }],
  };
  const geometry = partGeometry(mesh);
  const uv = geometry.getAttribute('uv');
  assert.equal(uv.count, 3);
  for (let index = 0; index < uv.count; index += 1) {
    assert.ok(uv.getX(index) >= 0 && uv.getX(index) <= 1);
    assert.ok(uv.getY(index) >= 0 && uv.getY(index) <= 1);
  }
  geometry.dispose();
});

test('meshTopologyIssues: primitive conversions are sound, corruption is flagged', () => {
  for (const kind of Object.keys(PART_KINDS).filter((entry) => entry !== 'asset')) {
    const part = convertPartToMesh({ kind, name: kind, position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#999', faces: {} });
    if (!part) continue;
    assert.deepEqual(meshTopologyIssues(part), [], `${kind} conversion must be clean`);
  }
  const part = convertPartToMesh({ kind: 'box', name: 'b', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], color: '#999', faces: {} });
  part.vertices.push([9, 9, 9]); // orphan handle floating in the void
  part.triangles[0] = { ...part.triangles[0], v: [0, 0, 1] }; // degenerate
  const issues = meshTopologyIssues(part);
  assert.ok(issues.some((issue) => issue.includes('orphaned')));
  assert.ok(issues.some((issue) => issue.includes('degenerate')));
  assert.ok(issues.some((issue) => issue.includes('boundary crack')));
});
