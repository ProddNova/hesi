import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capturePartFaceProjection,
  convertPartToMesh,
  customAssetsDocumentErrors,
  mergePartFaces,
  meshFacePlanarRegions,
  meshInsertVertexAtPoint,
  partFaceCoverProjection,
  partFaceNames,
  partFacePlanarRegionCount,
  partGeometry,
  splitPartFaceByPlanarRegions,
} from '../../../../js/custom-assets.js';

// A sheet folded 90°: a vertical square (z=0, the "front") and a horizontal
// square (y=1, the "top") sharing the v2-v3 edge. Explicit per-face UVs.
function foldedSheet() {
  return {
    kind: 'mesh',
    name: 'Fold',
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 1, -1], [1, 1, -1]],
    triangles: [
      { v: [0, 1, 2], face: 0, uv: [[0, 0], [1, 0], [0, 1]] },
      { v: [2, 1, 3], face: 0, uv: [[0, 1], [1, 0], [1, 1]] },
      { v: [2, 3, 4], face: 1, uv: [[0, 0], [1, 0], [0, 1]] },
      { v: [4, 3, 5], face: 1, uv: [[0, 1], [1, 0], [1, 1]] },
    ],
    faceNames: ['front', 'top'],
    faces: { front: { color: '#ff0000' } },
  };
}

function meshDocument(part) {
  return {
    version: 1,
    assets: { 'custom:0001': { id: 'custom:0001', label: 'Merge thing', parts: [part] } },
    textures: {},
    worldTextures: {},
  };
}

const length3 = (vector) => Math.hypot(vector[0], vector[1], vector[2]);

test('meshFacePlanarRegions separates the flat surfaces of a face', () => {
  const single = foldedSheet();
  single.faceNames = ['surface'];
  for (const triangle of single.triangles) triangle.face = 0;
  const regions = meshFacePlanarRegions(single, 'surface');
  assert.equal(regions.length, 2, 'the fold splits one face into two flat regions');
  assert.deepEqual(regions.flat().sort(), [0, 1, 2, 3], 'every triangle lands in a region');
  assert.ok(regions.every((region) => region.length === 2));

  const sheet = foldedSheet();
  assert.equal(meshFacePlanarRegions(sheet, 'front').length, 1, 'a flat square is one region');
  assert.equal(meshFacePlanarRegions(sheet, 'nope'), null, 'unknown face names return null');
  sheet.faceNames = ['front', 'top', 'spare'];
  assert.deepEqual(meshFacePlanarRegions(sheet, 'spare'), [], 'a face with no triangles has no regions');
});

test('partFacePlanarRegionCount probes primitives without mutating them', () => {
  const box = { kind: 'box', name: 'Crate', scale: [1, 1, 1], color: '#9aa7b5', faces: {} };
  assert.equal(partFacePlanarRegionCount(box, 'top'), 1);
  assert.equal(box.kind, 'box', 'the probe conversion never touches the part');
  const single = foldedSheet();
  single.faceNames = ['surface'];
  for (const triangle of single.triangles) triangle.face = 0;
  assert.equal(partFacePlanarRegionCount(single, 'surface'), 2);
  assert.equal(partFacePlanarRegionCount({ kind: 'asset', assetRef: 'x' }, 'top'), 0);
});

test('mergePartFaces concatenates faces into one with a union cover projection', () => {
  const sheet = foldedSheet();
  const result = mergePartFaces(sheet, ['front', 'top']);
  assert.deepEqual([result.ok, result.faceName, result.mergedCount], [true, 'front', 2]);
  assert.deepEqual(sheet.faceNames, ['front'], 'the merged name is the only one left');
  assert.ok(sheet.triangles.every((triangle) => triangle.face === 0), 'every triangle joined the merged slot');
  const style = sheet.faces.front;
  assert.equal(style.color, '#ff0000', 'the surviving face keeps its style');
  assert.equal(style.fit, 'cover');
  assert.deepEqual(style.projection.uvOrigin, [0, 0], 'the union projection maps the whole sheet onto the image square');
  assert.ok(Math.abs(length3(style.projection.uVector) - 1) < 0.05, 'u spans the 1 m width');
  const vLength = length3(style.projection.vVector);
  assert.ok(vLength > 1.3 && vLength < 1.5, `v spans the unfolded ~1.414 m sheet, got ${vLength}`);
  assert.equal(partFaceNames(sheet).length, 1);
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(sheet)), [], 'the merged part still validates');
  assert.ok(partGeometry(sheet), 'the merged part still builds geometry');
});

test('mergePartFaces remaps bystander faces and adopts the first available style', () => {
  const part = {
    kind: 'mesh',
    name: 'Trio',
    vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 2, 0]],
    triangles: [
      { v: [0, 1, 2], face: 0 },
      { v: [1, 3, 2], face: 1 },
      { v: [2, 3, 4], face: 2 },
    ],
    faceNames: ['a', 'b', 'c'],
    faces: { a: { color: '#00ff00' } },
  };
  const result = mergePartFaces(part, ['c', 'a']);
  assert.deepEqual([result.ok, result.faceName], [true, 'c'], 'the first ticked name survives');
  assert.deepEqual(part.faceNames, ['b', 'c']);
  assert.deepEqual(part.triangles.map((triangle) => triangle.face), [1, 0, 1], 'b keeps its triangles, a+c share the merged slot');
  assert.equal(part.faces.c.color, '#00ff00', 'the merged face adopts the first merged style');
  assert.equal(part.faces.a, undefined, 'removed names lose their styles');
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(part)), []);
});

test('mergePartFaces rejects non-meshes and too-small selections', () => {
  assert.equal(mergePartFaces({ kind: 'box', faces: {} }, ['top', 'front']).ok, false);
  assert.equal(mergePartFaces(foldedSheet(), ['front']).ok, false);
  assert.equal(mergePartFaces(foldedSheet(), ['front', 'nope']).ok, false);
});

test('partFaceCoverProjection fits mesh faces and preserves primitive planes', () => {
  // Mesh UVs are fragments after folds/splits, so a mesh face always gets a
  // plane fitted to the face itself — the whole image lands on the surface.
  const sheet = foldedSheet();
  const fitted = partFaceCoverProjection(sheet, 'front');
  assert.deepEqual(fitted.uvOrigin, [0, 0]);
  assert.ok(Math.abs(length3(fitted.uVector) - 1) < 1e-6, 'fitted to the 1 m face width');
  assert.ok(Math.abs(length3(fitted.vVector) - 1) < 1e-6, 'fitted to the 1 m face height');
  const box = { kind: 'box', name: 'Crate', scale: [1, 1, 1], color: '#9aa7b5', faces: {} };
  assert.deepEqual(
    partFaceCoverProjection(box, 'top'),
    capturePartFaceProjection(box, 'top'),
    'primitive faces keep their current UV plane, the picture stays put',
  );
  const single = foldedSheet();
  single.faceNames = ['surface'];
  for (const triangle of single.triangles) triangle.face = 0;
  const draped = partFaceCoverProjection(single, 'surface');
  const vLength = length3(draped.vVector);
  assert.ok(vLength > 1.3 && vLength < 1.5, `a folded face gets the union-fitted plane, got v span ${vLength}`);
  assert.deepEqual(draped.uvOrigin, [0, 0]);
});

test('union cover projections measure their aspect in scaled metres', () => {
  const single = foldedSheet();
  single.faceNames = ['surface'];
  for (const triangle of single.triangles) triangle.face = 0;
  single.scale = [3, 1, 1];
  const draped = partFaceCoverProjection(single, 'surface');
  // 3 m wide, ~1.414 m of unfolded sheet: the aspect must use physical sizes,
  // not the unit-space vertex coordinates.
  const expected = 3 / Math.hypot(1, 1);
  assert.ok(Math.abs(draped.surfaceAspect - expected) < 0.05,
    `aspect should be ~${expected.toFixed(3)}, got ${draped.surfaceAspect}`);
});

test('the user flow: fold a box top with a vertex, split the surfaces, merge them with the front', () => {
  const part = convertPartToMesh({ kind: 'box', name: 'Car', scale: [1, 1, 1], color: '#9aa7b5', faces: {} });
  const added = meshInsertVertexAtPoint(part, [0, 0.5, 0]);
  assert.ok(added, 'a vertex lands on the top face');
  part.vertices[added.vertexIndex] = [0, 0.9, 0]; // pull the apex up: the top folds
  const foldedCount = partFacePlanarRegionCount(part, 'top');
  assert.ok(foldedCount > 1, `the pulled apex folds the top into several flat surfaces, got ${foldedCount}`);

  const split = splitPartFaceByPlanarRegions(part, 'top');
  assert.equal(split.ok, true, 'the folded top splits into per-surface faces');
  assert.equal(split.faces.length, foldedCount);
  for (const name of split.faces) assert.ok(partFaceNames(part).includes(name), `face "${name}" is listed`);

  const merged = mergePartFaces(part, ['front', ...split.faces]);
  assert.equal(merged.ok, true, 'front + every top surface concatenate into one face');
  assert.equal(merged.faceName, 'front');
  assert.ok(!partFaceNames(part).some((name) => name.startsWith('top')), 'the split names are gone');
  assert.equal(partFacePlanarRegionCount(part, 'front'), foldedCount + 1, 'the merged face spans all the flat surfaces');
  assert.equal(part.faces.front.fit, 'cover');
  assert.ok(part.faces.front.projection, 'one image can now drape over the whole merged surface');
  assert.deepEqual(customAssetsDocumentErrors(meshDocument(part)), []);
});
