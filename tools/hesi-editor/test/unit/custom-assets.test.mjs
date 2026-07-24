import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PART_KINDS,
  WORLD_OBJECTS,
  WORLD_OBJECT_GROUPS,
  WORLD_SURFACES,
  WORLD_SURFACE_GROUPS,
  WORLD_TEXTURE_SLOTS,
  compactWorldSurfaceStyle,
  worldObjectForInstanceType,
  worldObjectForModelKey,
  worldObjectModelKey,
  worldObjectSurfaces,
  worldObjectsUsingSurface,
  isDefaultWorldSurfaceStyle,
  normalizeWorldSurfaceStyle,
  applyObjectFaceStyles,
  applyPartFaceProjections,
  applyVertexOffsets,
  applyWorldModelOverrides,
  applyWorldTextureOverrides,
  blankCustomAssetsDocument,
  buildCustomAssetGroup,
  buildPartObject,
  capturePartFaceProjection,
  customAssetsDocumentErrors,
  faceTextureTransform,
  clearObjectFaceStyles,
  objectFaceSlots,
  optimizeStaticCustomAssetGroup,
  partGeometry,
  textureSourceUrl,
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

test('texture records may reference an externalized image url instead of embedding a data URL', () => {
  const document = validDocument();
  document.textures['tex:0001'] = { name: 'wall.webp', url: 'textures/wall-a1889f7a10.webp' };
  assert.deepEqual(customAssetsDocumentErrors(document), []);
  for (const url of ['../outside.png', '/absolute.png', 'textures/evil/../../up.png', 'textures/script.js', 'https://evil.example/x.png']) {
    document.textures['tex:0001'] = { name: 'bad', url };
    assert.ok(customAssetsDocumentErrors(document).some((error) => error.includes('tex:0001')), `rejects ${url}`);
  }
});

test('textureSourceUrl prefers the embedded data URL and resolves relative urls against data/editor/', () => {
  assert.equal(textureSourceUrl({ dataUrl: PIXEL_PNG, url: 'textures/wall-a1889f7a10.webp' }), PIXEL_PNG);
  const resolved = textureSourceUrl({ url: 'textures/wall-a1889f7a10.webp' });
  assert.ok(resolved.endsWith('/data/editor/textures/wall-a1889f7a10.webp'), resolved);
  assert.equal(textureSourceUrl({ url: '../escape.png' }), null);
  assert.equal(textureSourceUrl({}), null);
  assert.equal(textureSourceUrl(null), null);
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

test('optimizeStaticCustomAssetGroup merges static parts by equivalent material', () => {
  const definition = {
    id: 'custom:runtime-car',
    label: 'Runtime car',
    parts: [
      { kind: 'plane', position: [-1, 0, 0], color: '#ff0000' },
      { kind: 'plane', position: [1, 0, 0], color: '#ff0000' },
      { kind: 'plane', position: [0, 1, 0], color: '#0000ff' },
    ],
  };
  const group = optimizeStaticCustomAssetGroup(buildCustomAssetGroup(definition, {}));
  assert.equal(group.children.length, 1);
  assert.equal(group.children[0].isMesh, true);
  assert.equal(group.children[0].geometry.groups.length, 2);
  assert.equal(group.children[0].geometry.getAttribute('position').count, 18);
  assert.equal(group.userData.hesiRuntimeDrawGroups, 2);
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

test('world surface styles normalize, compact, and round-trip both stored forms', () => {
  // Legacy documents stored a bare texture id; the rich form adds tiling.
  assert.equal(normalizeWorldSurfaceStyle('tex:0001').texture, 'tex:0001');
  assert.deepEqual(normalizeWorldSurfaceStyle('tex:0001').repeat, [1, 1]);
  assert.ok(isDefaultWorldSurfaceStyle(normalizeWorldSurfaceStyle(null)));
  assert.equal(compactWorldSurfaceStyle({ tint: '#ffffff' }), null, 'an all-default style is not stored at all');
  const compact = compactWorldSurfaceStyle({ texture: 'tex:0001', repeat: [4, 2], rotation: 90, brightness: 1 });
  assert.deepEqual(compact, { texture: 'tex:0001', repeat: [4, 2], rotation: 90 });
  // Out-of-range values are clamped rather than trusted into the material.
  assert.equal(normalizeWorldSurfaceStyle({ brightness: 99 }).brightness, 4);
  assert.equal(normalizeWorldSurfaceStyle({ tint: 'javascript:x' }).tint, '#ffffff');
});

test('applyWorldTextureOverrides tiles, tints, and restores the generated look', () => {
  const materials = {
    road: new THREE.MeshLambertMaterial({ color: 0x14171f }),
    marking: new THREE.MeshBasicMaterial({ color: 0xd8d6bf }),
    lampSodium: new THREE.MeshBasicMaterial({ color: 0xff8a2e }),
  };
  const document = {
    version: 1,
    assets: {},
    textures: { 'tex:0001': { dataUrl: PIXEL_PNG } },
    worldTextures: {
      road: { texture: 'tex:0001', repeat: [4, 4], rotation: 45 },
      marking: { texture: 'tex:0001' },
      lampSodium: { tint: '#00ff88' },
    },
  };
  applyWorldTextureOverrides(materials, document);
  assert.ok(materials.road.map, 'road took the image');
  assert.ok(materials.marking.map, 'lane markings took the image');
  assert.equal(materials.lampSodium.color.getHexString(), '00ff88', 'a tint-only slot recolours without an image');
  // Dropping the overrides puts the generated materials back exactly.
  delete document.worldTextures.road;
  delete document.worldTextures.lampSodium;
  const summary = applyWorldTextureOverrides(materials, document);
  assert.equal(summary.cleared, 2);
  assert.equal(materials.road.map, null);
  assert.equal(materials.road.color.getHexString(), '14171f');
  assert.equal(materials.lampSodium.color.getHexString(), 'ff8a2e');
});

test('world surface fit modes drive the texture transform', () => {
  const materials = {
    facadeOffice: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    road: new THREE.MeshLambertMaterial({ color: 0x14171f }),
  };
  const document = {
    version: 1,
    assets: {},
    textures: { 'tex:0001': { dataUrl: PIXEL_PNG } },
    // A rectangular tile: the two axes are independent, not locked square.
    worldTextures: { road: { texture: 'tex:0001', repeat: [3, 0.5] } },
  };
  applyWorldTextureOverrides(materials, document);
  assert.deepEqual(materials.road.map.repeat.toArray(), [3, 0.5], 'tiles can be rectangles');

  // Stretch and Fit & crop pull ONE copy over the surface, so neither tiles.
  for (const fit of ['stretch', 'cover']) {
    document.worldTextures.facadeOffice = { texture: 'tex:0001', fit, repeat: [4, 4] };
    applyWorldTextureOverrides(materials, document);
    assert.deepEqual(materials.facadeOffice.map.repeat.toArray(), [1, 1], fit + ' ignores the tiling');
  }
  assert.equal(materials.facadeOffice.map.wrapS, THREE.ClampToEdgeWrapping, 'Fit & crop clamps instead of repeating');

  // Asphalt UVs are unbounded, so those slots tile whatever the fit says.
  document.worldTextures.road = { texture: 'tex:0001', fit: 'cover', repeat: [3, 0.5] };
  applyWorldTextureOverrides(materials, document);
  assert.deepEqual(materials.road.map.repeat.toArray(), [3, 0.5], 'world-anchored asphalt keeps tiling');

  assert.equal(normalizeWorldSurfaceStyle({ fit: 'nonsense' }).fit, 'tile');
  assert.deepEqual(compactWorldSurfaceStyle({ fit: 'cover', aspect: 3 }), { fit: 'cover', aspect: 3 });
});

test('a saved model replaces the shape of every copy in an instanced bucket', () => {
  // Two chunks of the same bucket: one shared geometry drives every copy.
  const makeBucket = (name) => {
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 4);
    mesh.name = name;
    return mesh;
  };
  const buckets = [makeBucket('chunk 0,0 box:container'), makeBucket('chunk 1,0 box:container')];
  const other = makeBucket('chunk 0,0 box:vending');
  const map = { _chunks: new Map([['0,0', { group: { children: [buckets[0], other] } }], ['1,0', { group: { children: [buckets[1]] } }]]) };
  const generated = buckets[0].geometry;
  const document = {
    version: 1,
    textures: {},
    assets: {
      'custom:0001': {
        id: 'custom:0001',
        label: 'Crate',
        parts: [
          { kind: 'box', position: [0, 0.5, 0], scale: [2, 1, 1], color: '#ff0000' },
          { kind: 'cylinder', position: [0, 1.5, 0], scale: [1, 1, 1], color: '#00ff00' },
        ],
      },
    },
    worldModels: { 'box:container': 'custom:0001' },
  };
  const summary = applyWorldModelOverrides(map, document);
  assert.equal(summary.applied, 2, 'every chunk of the bucket is swapped');
  for (const mesh of buckets) {
    assert.notEqual(mesh.geometry, generated, 'the bucket draws the model now');
    assert.ok(mesh.geometry.getAttribute('position').count > 24, 'the replacement carries the model geometry');
    // Instance matrices still scale a unit box, so the model is fitted to it.
    mesh.geometry.computeBoundingBox();
    const size = mesh.geometry.boundingBox.getSize(new THREE.Vector3());
    assert.ok(Math.abs(size.x - 1) < 1e-4 && Math.abs(size.y - 1) < 1e-4 && Math.abs(size.z - 1) < 1e-4,
      'the model is fitted into the unit box every instance matrix scales');
  }
  assert.equal(other.geometry, other.userData.hesiGeneratedModel.geometry, 'other buckets are untouched');

  // Dropping the override restores the generated geometry exactly.
  delete document.worldModels['box:container'];
  const cleared = applyWorldModelOverrides(map, document);
  assert.equal(cleared.cleared, 2);
  assert.equal(buckets[0].geometry, generated);
});

test('world model targets and their validation', () => {
  assert.equal(worldObjectForInstanceType('box:container'), 'shippingContainer');
  // Buildings are replaced through their facade material, behind a prefix that
  // cannot collide with a `<geometry>:<material>` instance bucket.
  assert.equal(worldObjectModelKey('shippingContainer'), 'box:container');
  // The catalogue keeps the legacy facade slots on the types that inherited
  // their role, so models saved before it existed still find their buildings.
  assert.equal(worldObjectModelKey('officeBlock'), 'facade:facadeOffice');
  assert.equal(worldObjectModelKey('routeSign'), null, 'archetypes with no per-copy record are not replaceable');
  assert.equal(worldObjectForModelKey('facade:facadeOffice'), 'officeBlock');
  const document = validDocument();
  document.worldModels = { 'box:container': 'custom:0404' };
  assert.match(customAssetsDocumentErrors(document)[0], /missing asset custom:0404/);
  document.worldModels = { 'facade:facadeOffice': null };
  assert.deepEqual(customAssetsDocumentErrors(document), [], 'a building facade is a valid target');
  document.worldModels = { facadeOffice: null };
  assert.match(customAssetsDocumentErrors(document)[0], /unknown world model target/);
});

test('world objects are composites of real surfaces', () => {
  const grouped = WORLD_OBJECT_GROUPS.flatMap((entry) => entry.objects);
  assert.equal(grouped.length, Object.keys(WORLD_OBJECTS).length);
  assert.equal(new Set(grouped).size, grouped.length, 'every object appears in exactly one group');
  for (const [objectId, meta] of Object.entries(WORLD_OBJECTS)) {
    assert.ok(meta.label && meta.description && meta.group, objectId + ' needs label/description/group');
    assert.ok(meta.parts.length, objectId + ' needs at least one part');
    for (const part of meta.parts) {
      assert.ok(Object.hasOwn(WORLD_SURFACES, part.slot), objectId + ' references unknown surface ' + part.slot);
      assert.equal(part.size.length, 3);
      assert.equal(part.position.length, 3);
    }
    // Every surface of an object must be reachable from that object.
    for (const slot of worldObjectSurfaces(objectId)) {
      assert.ok(worldObjectsUsingSurface(slot).includes(objectId));
    }
  }
  // A lamp is its mast AND its head — the case that motivated the composite.
  assert.deepEqual(worldObjectSurfaces('highwayLamp'), ['concrete', 'lampSodium']);
  // The mast material is shared with the pillars, and the UI must be able to say so.
  assert.ok(worldObjectsUsingSurface('concrete').length > 1);
});

test('world texture slots stay aligned with the map material names', () => {
  // Guard against typos: every slot key must be a plausible material key.
  for (const slot of Object.keys(WORLD_TEXTURE_SLOTS)) {
    assert.match(slot, /^[a-zA-Z]+$/);
  }
  assert.equal(WORLD_TEXTURE_SLOTS.roadService.label, 'Service area asphalt');
  assert.equal(WORLD_TEXTURE_SLOTS.railMetal.label, 'Guardrails');
  assert.equal(WORLD_TEXTURE_SLOTS.marking.tintOnly, undefined, 'white lane markings accept uploaded images');
  assert.equal(WORLD_TEXTURE_SLOTS.amber.tintOnly, undefined, 'amber lane markings accept uploaded images');
  assert.equal(WORLD_TEXTURE_SLOTS.reflector.tintOnly, true, 'point reflectors remain colour-only');
  // Every surface must declare the metadata the Surfaces editor renders from,
  // and every slot must appear in exactly one display group.
  const grouped = WORLD_SURFACE_GROUPS.flatMap((entry) => entry.slots);
  assert.equal(grouped.length, Object.keys(WORLD_SURFACES).length);
  assert.equal(new Set(grouped).size, grouped.length);
  for (const [slot, meta] of Object.entries(WORLD_SURFACES)) {
    assert.ok(meta.label && meta.description, `${slot} needs a label and description`);
    assert.ok(['surface', 'object'].includes(meta.kind), `${slot} needs a kind`);
  }
});
