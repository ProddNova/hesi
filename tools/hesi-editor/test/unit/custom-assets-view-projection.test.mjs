import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  captureViewFaceProjection,
  convertPartToMesh,
  partFaceNames,
} from '../../../../js/custom-assets.js';

// Replicates applyPartFaceProjections' Gram solve: the UV a local-space
// vertex receives from a stored projection.
const projectedUv = (projection, point) => {
  const [ox, oy, oz] = projection.origin;
  const U = projection.uVector;
  const V = projection.vVector;
  const d = [point[0] - ox, point[1] - oy, point[2] - oz];
  const du = d[0] * U[0] + d[1] * U[1] + d[2] * U[2];
  const dv = d[0] * V[0] + d[1] * V[1] + d[2] * V[2];
  const uu = U[0] ** 2 + U[1] ** 2 + U[2] ** 2;
  const vv = V[0] ** 2 + V[1] ** 2 + V[2] ** 2;
  const uvDot = U[0] * V[0] + U[1] * V[1] + U[2] * V[2];
  const det = uu * vv - uvDot * uvDot;
  return [
    projection.uvOrigin[0] + (du * vv - dv * uvDot) / det,
    projection.uvOrigin[1] + (dv * uu - du * uvDot) / det,
  ];
};

function carLikePart() {
  return convertPartToMesh({
    kind: 'box',
    name: 'Car',
    position: [2, 0.5, -3],
    rotation: [0, Math.PI / 5, 0.1],
    scale: [1.7, 1.3, 4.2], // non-uniform: the covector math must survive it
    color: '#9aa7b5',
    faces: {},
  });
}

function composedMatrix(part) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3().fromArray(part.position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.rotation)),
    new THREE.Vector3().fromArray(part.scale),
  );
}

// A slightly tilted viewpoint aimed at the front of the part.
function viewAxes() {
  const forward = new THREE.Vector3(0.3, -0.4, -1).normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { right, up };
}

test('view projection gives every vertex its exact camera-plane coordinate', () => {
  const part = carLikePart();
  const matrix = composedMatrix(part);
  const { right, up } = viewAxes();
  const faceNames = ['front', 'top'];
  const projection = captureViewFaceProjection(part, faceNames, {
    right: right.toArray(),
    up: up.toArray(),
    matrixWorld: [...matrix.elements],
  });
  assert.ok(projection, 'a projection is derived');

  const names = partFaceNames(part);
  const wanted = new Set(faceNames.map((name) => names.indexOf(name)));
  const locals = [];
  for (const triangle of part.triangles) {
    if (!wanted.has(triangle.face || 0)) continue;
    for (const vertex of triangle.v) locals.push(part.vertices[vertex]);
  }
  const world = locals.map((point) => new THREE.Vector3(...point).applyMatrix4(matrix));
  const us = world.map((point) => point.dot(right));
  const vs = world.map((point) => point.dot(up));
  const uMin = Math.min(...us);
  const uSpan = Math.max(...us) - uMin;
  const vMin = Math.min(...vs);
  const vSpan = Math.max(...vs) - vMin;

  locals.forEach((point, index) => {
    const [u, v] = projectedUv(projection, point);
    assert.ok(Math.abs(u - (us[index] - uMin) / uSpan) < 1e-5, `u of vertex ${index} matches the view`);
    assert.ok(Math.abs(v - (vs[index] - vMin) / vSpan) < 1e-5, `v of vertex ${index} matches the view`);
    assert.ok(u > -1e-5 && u < 1 + 1e-5 && v > -1e-5 && v < 1 + 1e-5, 'the group fits the image square');
  });
  assert.ok(Math.abs(projection.surfaceAspect - uSpan / vSpan) < 1e-6, 'aspect is the on-screen metre ratio');
});

test('view projection composes the part transform when no matrix is given', () => {
  const part = carLikePart();
  const { right, up } = viewAxes();
  const options = { right: right.toArray(), up: up.toArray() };
  const implicit = captureViewFaceProjection(part, ['front'], options);
  const explicit = captureViewFaceProjection(part, ['front'], { ...options, matrixWorld: [...composedMatrix(part).elements] });
  assert.ok(implicit && explicit);
  for (const key of ['origin', 'uVector', 'vVector']) {
    implicit[key].forEach((value, axis) => {
      assert.ok(Math.abs(value - explicit[key][axis]) < 1e-9, `${key}[${axis}] matches the composed matrix`);
    });
  }
  assert.ok(Math.abs(implicit.surfaceAspect - explicit.surfaceAspect) < 1e-9);
});

test('view projection rejects unusable inputs', () => {
  const part = carLikePart();
  const { right, up } = viewAxes();
  const options = { right: right.toArray(), up: up.toArray() };
  assert.equal(captureViewFaceProjection(part, [], options), null, 'no faces, no projection');
  assert.equal(captureViewFaceProjection(part, ['nope'], options), null, 'unknown faces, no projection');
  assert.equal(captureViewFaceProjection(part, ['front'], { right: [0, 0, 0], up: up.toArray() }), null, 'a degenerate axis is refused');
  assert.equal(captureViewFaceProjection({ kind: 'asset', assetRef: 'x' }, ['front'], options), null, 'assembled assets have no editable faces');
});
