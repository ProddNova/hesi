import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PART_KINDS,
  WORLD_TEXTURE_SLOTS,
  applyObjectFaceStyles,
  applyPartFaceProjections,
  applyVertexOffsets,
  applyWorldTextureOverrides,
  blankCustomAssetsDocument,
  buildCustomAssetGroup,
  buildPartObject,
  capturePartFaceProjection,
  customAssetsDocumentErrors,
  faceTextureTransform,
  clearObjectFaceStyles,
  objectFaceSlots,
  partGeometry,
  weldedVertices,
} from '../../../../js/custom-assets.js';
import { validateBuildDocument } from '../../src/overrides/build-schema.js';
import { AssetRegistry } from '../../src/world/asset-registry.js';
import * as THREE from 'three';

const PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function validDocument() {
  return {
    version: 1,
    assets: {
      'custom:0001': {
        id: 'custom:0001',
        label: 'Cestino',
        layer: 'Props',
        parts: [
          { kind: 'box', name: 'Body', position: [0, 0.5, 0], rotation: [0, 0, 0], scale: [0.5, 1, 0.5], color: '#5588aa', faces: { top: { texture: 'tex:0001' } } },
          { kind: 'cylinder', segments: 6, position: [0, 1.1, 0], scale: [0.6, 0.2, 0.6], faces: {} },
        ],
      },
    },
    textures: { 'tex:0001': { name: 'top.png', dataUrl: PIXEL_PNG } },
    worldTextures: { road: 'tex:0001' },
  };
}

test('blank custom assets document validates', () => {
  assert.deepEqual(customAssetsDocumentErrors(blankCustomAssetsDocument()), []);
});

test('a realistic document validates and bad references are rejected', () => {
  assert.deepEqual(customAssetsDocumentErrors(validDocument()), []);
  const missingTexture = validDocument();
  missingTexture.assets['custom:0001'].parts[0].faces.top.texture = 'tex:9999';
  assert.ok(customAssetsDocumentErrors(missingTexture).some((error) => error.includes('missing texture')));
  const badSlot = validDocument();
  badSlot.worldTextures.lava = 'tex:0001';
  assert.ok(customAssetsDocumentErrors(badSlot).some((error) => error.includes('unknown world texture slot')));
  const badFace = validDocument();
  badFace.assets['custom:0001'].parts[0].faces.lid = {};
  assert.ok(customAssetsDocumentErrors(badFace).some((error) => error.includes('not a face of box')));
  const badKind = validDocument();
  badKind.assets['custom:0001'].parts[0].kind = 'torus';
  assert.ok(customAssetsDocumentErrors(badKind).some((error) => error.includes('unknown')));
});

test('every primitive kind builds geometry with one group per named face', () => {
  for (const [kind, meta] of Object.entries(PART_KINDS)) {
    if (kind === 'asset' || kind === 'mesh') continue; // no static geometry: assembled/data-driven
    const geometry = partGeometry({ kind });
    assert.ok(geometry, `${kind} builds`);
    assert.equal(geometry.groups.length, meta.faces.length, `${kind} groups match faces`);
    const materialIndices = new Set(geometry.groups.map((group) => group.materialIndex));
    assert.equal(materialIndices.size, meta.faces.length, `${kind} group material indices are distinct`);
    geometry.dispose();
  }
});

test('subdivisions add editable vertices while keeping one group per face', () => {
  for (const kind of ['box', 'cylinder', 'pyramid', 'cone', 'plane']) {
    const base = partGeometry({ kind });
    const dense = partGeometry({ kind, subdivisions: 3 });
    assert.equal(dense.groups.length, PART_KINDS[kind].faces.length, `${kind} keeps its face groups`);
    assert.ok(
      weldedVertices(dense).welded.length > weldedVertices(base).welded.length,
      `${kind} gains welded vertices with subdivisions`,
    );
    base.dispose();
    dense.dispose();
  }
});

test('subdivisions validate as integers between 1 and 8', () => {
  const good = validDocument();
  good.assets['custom:0001'].parts[0].subdivisions = 4;
  assert.deepEqual(customAssetsDocumentErrors(good), []);
  for (const bad of [0, 9, 2.5, '3']) {
    const document = validDocument();
    document.assets['custom:0001'].parts[0].subdivisions = bad;
    assert.ok(
      customAssetsDocumentErrors(document).some((error) => error.includes('subdivisions')),
      `subdivisions=${bad} rejected`,
    );
  }
});

test('vertex welding and offsets deform the box deterministically', () => {
  const geometry = partGeometry({ kind: 'box' });
  const { welded, weldIndexOf } = weldedVertices(geometry);
  assert.equal(welded.length, 8, 'a box has 8 logical corners');
  assert.equal(weldIndexOf.length, geometry.getAttribute('position').count);
  const cornerBefore = [...welded[0]];
  applyVertexOffsets(geometry, [{ i: 0, o: [0.25, 0, 0] }]);
  const after = weldedVertices(geometry);
  // The moved corner appears at base+offset; welding still finds 8 corners.
  assert.equal(after.welded.length, 8);
  assert.ok(after.welded.some((position) => Math.abs(position[0] - (cornerBefore[0] + 0.25)) < 1e-6
    && Math.abs(position[1] - cornerBefore[1]) < 1e-6
    && Math.abs(position[2] - cornerBefore[2]) < 1e-6));
  geometry.dispose();
});

test('buildPartObject applies transforms and per-face materials', () => {
  const part = { kind: 'box', position: [1, 2, 3], rotation: [0, Math.PI / 2, 0], scale: [2, 1, 1], color: '#ff0000', faces: {} };
  const mesh = buildPartObject(part, {});
  assert.ok(mesh.isMesh);
  assert.deepEqual(mesh.position.toArray(), [1, 2, 3]);
  assert.equal(mesh.material.length, 6);
  assert.equal(mesh.material[0].color.getHexString(), 'ff0000');
});

test('face texture cover preserves aspect, crops centrally, and flips per axis', () => {
  assert.deepEqual(faceTextureTransform({ fit: 'cover', imageAspect: 2, surfaceAspect: 1 }), {
    repeat: [0.5, 1], offset: [0.25, 0],
  });
  assert.deepEqual(faceTextureTransform({ fit: 'cover', imageAspect: 1, surfaceAspect: 2, flipX: true, flipY: true }), {
    repeat: [-1, -0.5], offset: [1, 0.75],
  });
  assert.deepEqual(faceTextureTransform({ fit: 'stretch', flipX: true }), {
    repeat: [-1, 1], offset: [1, 0],
  });
});

test('Fit & crop keeps a fixed image plane while moved vertices crop it', () => {
  const part = {
    kind: 'mesh',
    scale: [1, 1, 1],
    vertices: [[-1, -0.5, 0], [1, -0.5, 0], [1, 0.5, 0], [-1, 0.5, 0]],
    triangles: [
      { v: [0, 1, 2], face: 0, uv: [[0, 0], [1, 0], [1, 1]] },
      { v: [0, 2, 3], face: 0, uv: [[0, 0], [1, 1], [0, 1]] },
    ],
    faceNames: ['side'],
    faces: { side: { texture: 'tex:0001', fit: 'cover' } },
  };
  const projection = capturePartFaceProjection(part, 'side');
  assert.ok(projection, 'the original image plane is captured');
  assert.ok(Math.abs(projection.surfaceAspect - 2) < 1e-6);
  part.faces.side.projection = projection;

  // Pull the upper-right corner halfway into the original rectangle. Its UV
  // must become 0.5 (same stationary image at x=0), not stay at 1 (stretch).
  part.vertices[2] = [0, 0.5, 0];
  const geometry = partGeometry(part);
  applyPartFaceProjections(geometry, part);
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const movedCornerUvs = [];
  for (let index = 0; index < position.count; index += 1) {
    if (Math.abs(position.getX(index)) < 1e-6 && Math.abs(position.getY(index) - 0.5) < 1e-6) {
      movedCornerUvs.push([uv.getX(index), uv.getY(index)]);
    }
  }
  assert.equal(movedCornerUvs.length, 2);
  assert.ok(movedCornerUvs.every(([u, v]) => Math.abs(u - 0.5) < 1e-6 && Math.abs(v - 1) < 1e-6));
  geometry.dispose();

  const mesh = buildPartObject(part, { 'tex:0001': { dataUrl: PIXEL_PNG } });
  assert.ok(Math.abs(mesh.material.map.repeat.y - 0.5) < 1e-6, 'crop aspect remains frozen at capture time');
  mesh.geometry.dispose();
  mesh.material.dispose();
});

test('Map Editor face slots split a box material and restore it cleanly', () => {
  const original = new THREE.MeshLambertMaterial({ color: 0x334455, name: 'wall' });
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), original);
  const slots = objectFaceSlots(box);
  assert.deepEqual(slots.map((slot) => slot.faceName), ['right', 'left', 'top', 'bottom', 'front', 'back']);
  assert.equal(applyObjectFaceStyles(box, {
    '0:4': { texture: 'tex:0001', fit: 'cover', flipX: true },
  }, { 'tex:0001': { dataUrl: PIXEL_PNG } }), 1);
  assert.ok(Array.isArray(box.material));
  assert.equal(box.material.length, 6);
  assert.ok(box.material[4].map);
  assert.equal(box.material[4].color.getHexString(), 'ffffff');
  assert.equal(box.material[0].color.getHexString(), '334455');
  clearObjectFaceStyles(box);
  assert.equal(box.material, original);
});

test('custom asset face styles validate fit and flips', () => {
  const document = validDocument();
  const part = document.assets['custom:0001'].parts[0];
  part.faces.top = {
    texture: 'tex:0001',
    fit: 'cover',
    flipX: true,
    flipY: false,
    projection: capturePartFaceProjection(part, 'top'),
  };
  assert.deepEqual(customAssetsDocumentErrors(document), []);
  part.faces.top.fit = 'contain';
  part.faces.top.flipX = 'yes';
  part.faces.top.projection.uVector = [1, 0];
  assert.ok(customAssetsDocumentErrors(document).some((error) => error.includes('.fit')));
  assert.ok(customAssetsDocumentErrors(document).some((error) => error.includes('.flipX')));
  assert.ok(customAssetsDocumentErrors(document).some((error) => error.includes('.projection')));
});

test('buildCustomAssetGroup skips unresolvable assembled parts without throwing', () => {
  const definition = {
    id: 'custom:0002',
    label: 'Sign with pole',
    parts: [
      { kind: 'cylinder', position: [0, 2, 0], scale: [0.2, 4, 0.2] },
      { kind: 'asset', assetRef: 'hesi:segment:exitGreen', components: [] },
    ],
  };
  const group = buildCustomAssetGroup(definition, {}, { resolveAssetPart: () => null });
  assert.equal(group.children.length, 1);
  assert.equal(group.userData.customAssetSkippedParts, 1);
  const resolved = buildCustomAssetGroup(definition, {}, { resolveAssetPart: () => new THREE.Group() });
  assert.equal(resolved.children.length, 2);
});

test('applyWorldTextureOverrides only touches known slots with real textures', () => {
  const materials = { road: new THREE.MeshLambertMaterial({ color: 0x14171f }) };
  const summary = applyWorldTextureOverrides(materials, {
    version: 1,
    assets: {},
    textures: { 'tex:0001': { dataUrl: PIXEL_PNG } },
    worldTextures: { road: 'tex:0001', lava: 'tex:0001', roadAlt: 'tex:9999' },
  });
  assert.equal(summary.applied, 1);
  assert.equal(summary.skipped, 2);
  assert.ok(materials.road.map, 'road material received a texture');
  assert.equal(materials.road.color.getHexString(), 'ffffff');
});

test('build schema accepts place-custom operations and rejects malformed ones', () => {
  const base = {
    version: 1,
    scene: 'highway',
    generatedAt: new Date().toISOString(),
    project: { name: 'Test', path: 'data/editor/hesi-world-project.json' },
    operations: [{
      op: 'place-custom',
      assetId: 'custom:0001',
      name: 'Cestino',
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      visible: true,
    }],
  };
  assert.ok(validateBuildDocument(base));
  const bad = structuredClone(base);
  bad.operations[0].assetId = 'hesi:lamppost:concrete';
  assert.throws(() => validateBuildDocument(bad), /custom:<id>/);
});

test('AssetRegistry registers custom assets and lists them first in the catalog', () => {
  const registry = new AssetRegistry({ editorGroup: new THREE.Group() }).collect([]);
  const components = [{
    geometry: new THREE.BoxGeometry(1, 1, 1),
    material: new THREE.MeshLambertMaterial(),
    sourceWorldMatrix: new THREE.Matrix4(),
    castShadow: false,
    receiveShadow: false,
    name: 'Body',
  }];
  const asset = registry.registerCustomAsset({ id: 'custom:0001', label: 'Cestino', layer: 'Props' }, components);
  assert.equal(asset.kind, 'custom');
  const catalog = registry.catalog();
  assert.equal(catalog[0].id, 'custom:0001');
  assert.equal(catalog[0].kind, 'custom');
  const placed = registry.createPlacedEntity('custom:0001', { position: new THREE.Vector3(5, 0, 5) });
  assert.equal(placed.assetId, 'custom:0001');
  assert.equal(placed.metadata.placed, true);
  assert.ok(registry.removeCustomAsset('custom:0001'));
  assert.ok(!registry.catalog().some((entry) => entry.id === 'custom:0001'));
});

test('world texture slots stay aligned with the map material names', () => {
  // Guard against typos: every slot key must be a plausible material key.
  for (const slot of Object.keys(WORLD_TEXTURE_SLOTS)) {
    assert.match(slot, /^[a-zA-Z]+$/);
  }
});
