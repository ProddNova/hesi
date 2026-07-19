import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  HighwayMap,
  ROAD_SURFACE_MATERIAL_NAMES,
  ROAD_TEXTURE_TILE_METERS,
  applyWorldSurfaceUVs,
} from '../../../../js/map.js';

// UV density/continuity probe for the road texture fix: the same 1080x1080
// asphalt image must read at ONE visual scale on every road surface —
// whatever the segment length, deck width, orientation, curvature, or
// generated topology — and tiles must continue seamlessly across quads,
// chunks, and routes. The mapping contract that guarantees both is that
// every stored uv equals the triangle's dominant-axis world projection
// divided by the tile size; this probe verifies exactly that, across the
// whole generated network.

const TILE = ROAD_TEXTURE_TILE_METERS;

// The three world-anchored projection planes the mapping may use. Which one a
// surface picks is an implementation detail (dominant axis of its connected
// component); the probe only demands that every triangle uses exactly one of
// them, consistently for all three corners.
function candidatePlaneUvs(world) {
  return [
    [world.x / TILE, world.z / TILE], // top-down: the asphalt itself
    [world.z / TILE, world.y / TILE], // X-facing side
    [world.x / TILE, world.y / TILE], // Z-facing side
  ];
}

function quadGeometry(corners) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(corners.flat(), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

function uvSpan(geometry) {
  const uv = geometry.getAttribute('uv');
  let minU = Infinity; let maxU = -Infinity; let minV = Infinity; let maxV = -Infinity;
  for (let index = 0; index < uv.count; index += 1) {
    minU = Math.min(minU, uv.getX(index)); maxU = Math.max(maxU, uv.getX(index));
    minV = Math.min(minV, uv.getY(index)); maxV = Math.max(maxV, uv.getY(index));
  }
  return { u: maxU - minU, v: maxV - minV };
}

test('applyWorldSurfaceUVs maps any quad size and orientation at one density', () => {
  // A short narrow quad and a long wide quad: repeats per metre must match.
  const small = applyWorldSurfaceUVs(quadGeometry([[0, 5, 0], [3, 5, 0], [3, 5, 2], [0, 5, 2]]));
  const large = applyWorldSurfaceUVs(quadGeometry([[10, 8, 10], [70, 8, 10], [70, 8, 50], [10, 8, 50]]));
  assert.ok(Math.abs(uvSpan(small).u - 3 / TILE) < 1e-6);
  assert.ok(Math.abs(uvSpan(small).v - 2 / TILE) < 1e-6);
  assert.ok(Math.abs(uvSpan(large).u - 60 / TILE) < 1e-6);
  assert.ok(Math.abs(uvSpan(large).v - 40 / TILE) < 1e-6);
  // A rotated (diagonal) quad keeps the same metres-per-repeat on its edges.
  const diagonal = applyWorldSurfaceUVs(quadGeometry([[0, 0, 0], [30, 0, 30], [25, 0, 35], [-5, 0, 5]]));
  const uv = diagonal.getAttribute('uv');
  const edgeUv = Math.hypot(uv.getX(1) - uv.getX(0), uv.getY(1) - uv.getY(0));
  assert.ok(Math.abs(edgeUv * TILE - Math.hypot(30, 30)) < 1e-4, 'diagonal edge density matches world length');
  // matrixWorld variant: translated/rotated local geometry lands on the same
  // world lattice as already-baked geometry at that spot (continuity).
  const local = quadGeometry([[-2, 0, -2], [2, 0, -2], [2, 0, 2], [-2, 0, 2]]);
  const matrix = new THREE.Matrix4().makeTranslation(100, 3, -40);
  applyWorldSurfaceUVs(local, matrix);
  const localUv = local.getAttribute('uv');
  assert.ok(Math.abs(localUv.getX(0) - 98 / TILE) < 1e-5);
  assert.ok(Math.abs(localUv.getY(0) - (-42) / TILE) < 1e-5);
  for (const geometry of [small, large, diagonal, local]) geometry.dispose();
});

test('every road surface in the real network keeps one texture density and seamless continuity', { timeout: 120000 }, () => {
  const map = new HighwayMap({ quality: 'low', applyFog: false });
  try {
    const roadMaterials = new Set(ROAD_SURFACE_MATERIAL_NAMES.map((name) => map.materials[name]));
    map.group.updateMatrixWorld(true);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let meshCount = 0;
    let triangleCount = 0;
    let steepEdges = 0;
    let totalEdges = 0;
    const badUvs = [];
    map.group.traverse((object) => {
      if (!object.isMesh || object.isInstancedMesh || !roadMaterials.has(object.material)) return;
      meshCount += 1;
      const geometry = object.geometry;
      const position = geometry.getAttribute('position');
      const uv = geometry.getAttribute('uv');
      assert.ok(uv, `road mesh "${object.name}" carries UVs`);
      assert.equal(uv.count, position.count, `road mesh "${object.name}" has one uv per vertex`);
      const index = geometry.index;
      const cornerCount = index ? index.count : position.count;
      for (let corner = 0; corner + 2 < cornerCount; corner += 3) {
        const indices = [0, 1, 2].map((k) => index ? index.getX(corner + k) : corner + k);
        a.fromBufferAttribute(position, indices[0]).applyMatrix4(object.matrixWorld);
        b.fromBufferAttribute(position, indices[1]).applyMatrix4(object.matrixWorld);
        c.fromBufferAttribute(position, indices[2]).applyMatrix4(object.matrixWorld);
        triangleCount += 1;
        // Continuity + uniformity contract: every corner's uv is its world
        // position on one of the fixed-scale projection planes, and all
        // three corners of a triangle agree on the plane. Identical world
        // positions therefore always carry identical uvs (seamless tiles).
        const worlds = [a, b, c];
        let commonPlanes = null;
        for (let k = 0; k < 3; k += 1) {
          const u = uv.getX(indices[k]);
          const v = uv.getY(indices[k]);
          const matches = new Set();
          candidatePlaneUvs(worlds[k]).forEach((candidate, plane) => {
            if (Math.hypot(u - candidate[0], v - candidate[1]) <= 2e-3) matches.add(plane);
          });
          commonPlanes = commonPlanes === null ? matches : new Set([...commonPlanes].filter((plane) => matches.has(plane)));
        }
        if (!commonPlanes.size && badUvs.length < 5) {
          badUvs.push(`${object.name} tri ${corner / 3} at (${a.x.toFixed(1)}, ${a.y.toFixed(1)}, ${a.z.toFixed(1)}) does not sit on one world projection plane`);
        }
        // On-surface density: |Δuv| * tile / |Δworld| is 1 on the projection
        // plane and shrinks only with true slope. Asphalt is near-horizontal,
        // so all but a sliver of edges must sit within 10% of uniform.
        for (const [p, q, ip, iq] of [[a, b, indices[0], indices[1]], [b, c, indices[1], indices[2]], [c, a, indices[2], indices[0]]]) {
          const worldLength = p.distanceTo(q);
          if (worldLength < 0.5) continue; // sub-half-metre slivers: float32 uv noise dominates
          const uvLength = Math.hypot(uv.getX(iq) - uv.getX(ip), uv.getY(iq) - uv.getY(ip)) * TILE;
          const density = uvLength / worldLength;
          totalEdges += 1;
          assert.ok(density < 1.02, `density never exceeds the world scale (got ${density} on ${object.name})`);
          if (density < 0.9) steepEdges += 1;
        }
      }
    });
    assert.ok(meshCount > 10, `probe saw enough road meshes (${meshCount})`);
    assert.ok(triangleCount > 1000, `probe saw enough road triangles (${triangleCount})`);
    assert.deepEqual(badUvs, [], 'every road uv follows the world-anchored mapping');
    assert.ok(steepEdges / totalEdges < 0.02,
      `uniform density on ${(100 - (steepEdges / totalEdges) * 100).toFixed(2)}% of ${totalEdges} road edges (needs >= 98%)`);
  } finally {
    map.dispose();
  }
});
