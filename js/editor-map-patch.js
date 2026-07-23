import * as THREE from 'three';
import { applyObjectFaceStyles, applyWorldModelOverrides, applyWorldTextureOverrides, buildCustomAssetGroup, fetchCustomAssetsDocument } from './custom-assets.js';
import { SkyboxRenderer } from './skybox.js';
import { applySceneLighting } from './lighting-config.js';

// Applies HESI world-editor builds to the running game.
//
// The editor (tools/hesi-editor) saves each scene as a resolved build file — a
// flat list of operations addressed by stable names/indices — so the game can
// replay edits on its freshly generated world without importing editor code.
// Missing build files simply mean "no edits": the game runs untouched.
//
// Modeler-built objects and world texture overrides live in the shared
// data/editor/custom-assets.json document (js/custom-assets.js): `place-custom`
// operations rebuild those objects here, and saved road/wall texture overrides
// are applied to the generated map materials even when no build file exists.

const BUILD_URLS = Object.freeze({
  highway: 'data/editor/hesi-world-build.json',
  garage: 'data/editor/garage-build.json',
});

const PRIMITIVE_GEOMETRY = {
  box: () => new THREE.BoxGeometry(1, 1, 1),
  cylinder: () => new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
  sphere: () => new THREE.SphereGeometry(0.5, 24, 16),
};

// One geometry + material set per part definition, shared by every placement
// of that asset in either scene. The custom-assets document is fetched once
// per page load, so part objects are stable WeakMap keys for the whole run.
const PART_BUILD_CACHE = new WeakMap();

async function fetchBuild(scene) {
  try {
    const response = await fetch(BUILD_URLS[scene], { cache: 'no-store' });
    if (!response.ok) return null;
    const build = await response.json();
    if (build?.version !== 1 || build.scene !== scene || !Array.isArray(build.operations)) {
      console.warn(`[editor-map-patch] ignoring malformed build for scene ${scene}`);
      return null;
    }
    return build;
  } catch {
    return null; // offline / file:// / no build yet — all normal
  }
}

function applyTransformOp(object, op) {
  object.position.fromArray(op.position);
  object.quaternion.fromArray(op.quaternion).normalize();
  object.scale.fromArray(op.scale);
  object.visible = op.visible !== false;
  object.updateMatrix?.();
  object.updateMatrixWorld?.(true);
}

function primitiveMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0x9aa7b5, roughness: 0.72, metalness: 0.06, name: 'editor-primitive' });
}

function placedGroup(parent) {
  let group = parent.children.find((child) => child.name === 'Editor placed objects');
  if (!group) {
    group = new THREE.Group();
    group.name = 'Editor placed objects';
    parent.add(group);
  }
  return group;
}

// Rebuilds one assembled/custom part tree. World-asset parts resolve through
// generated donor meshes; nested custom assets recurse through the document.
function customAssetPartResolver(customAssets, donorForMaterialKey, depth = 0) {
  return (part) => {
    if (typeof part.assetRef === 'string' && part.assetRef.startsWith('custom:')) {
      const nested = customAssets?.assets?.[part.assetRef];
      if (!nested || depth >= 4) return null;
      return buildCustomAssetGroup(nested, customAssets.textures, {
        resolveAssetPart: customAssetPartResolver(customAssets, donorForMaterialKey, depth + 1),
        buildCache: PART_BUILD_CACHE,
      });
    }
    const root = new THREE.Group();
    for (const component of part.components || []) {
      const donor = donorForMaterialKey(component.materialKey);
      if (!donor) return null; // never place half an assembled asset
      const mesh = new THREE.Mesh(donor.geometry, donor.material);
      mesh.name = component.materialKey;
      mesh.castShadow = donor.castShadow;
      mesh.receiveShadow = donor.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(component.matrix);
      root.add(mesh);
    }
    return root.children.length ? root : null;
  };
}

/**
 * Resolver used by dynamic car models outside the map-build pass. It indexes
 * the generated instanced buckets once, then rebuilds nested custom parts and
 * baked world-asset components with the same materials as placed objects.
 */
export function createRuntimeAssetPartResolver(customAssets, map) {
  const donors = new Map();
  map?.group?.traverse?.((object) => {
    if (!object.isInstancedMesh) return;
    const materialKey = String(object.name || '').replace(/^chunk\s+\S+\s+/, '');
    if (materialKey && !donors.has(materialKey)) donors.set(materialKey, object);
  });
  return customAssetPartResolver(customAssets, (materialKey) => donors.get(materialKey) || null);
}

function buildPlacedObject(op, donorForMaterialKey, customAssets = null) {
  const root = new THREE.Group();
  root.name = op.name || 'Editor placed object';
  if (op.op === 'place-custom') {
    const definition = customAssets?.assets?.[op.assetId];
    if (!definition) return null;
    const built = buildCustomAssetGroup(definition, customAssets.textures, {
      resolveAssetPart: customAssetPartResolver(customAssets, donorForMaterialKey),
      buildCache: PART_BUILD_CACHE,
    });
    if (!built.children.length) return null;
    root.add(built);
  } else if (op.op === 'place-primitive') {
    const geometry = PRIMITIVE_GEOMETRY[op.primitive]?.();
    if (!geometry) return null;
    root.add(new THREE.Mesh(geometry, primitiveMaterial()));
  } else {
    for (const component of op.components || []) {
      const donor = donorForMaterialKey(component.materialKey);
      if (!donor) return null; // never place half an asset
      const mesh = new THREE.Mesh(donor.geometry, donor.material);
      mesh.name = component.materialKey;
      mesh.castShadow = donor.castShadow;
      mesh.receiveShadow = donor.receiveShadow;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.fromArray(component.matrix);
      root.add(mesh);
    }
    if (!root.children.length) return null;
  }
  applyTransformOp(root, op);
  applyObjectFaceStyles(root, op.faceTextures || {}, customAssets?.textures || {});
  return root;
}

export function applyHighwayBuild(map, build, customAssets = null) {
  const summary = { applied: 0, skipped: 0 };
  if (!map?.group || !build) return summary;

  // Index the generated world once: instanced meshes by exact bucket name, and
  // every object by (name → ordered occurrence list). The editor computed its
  // nameIndex values over the identical deterministic walk.
  const instancedByName = new Map();
  const objectsByName = new Map();
  map.group.traverse((object) => {
    if (object === map.group) return;
    if (object.isInstancedMesh && !instancedByName.has(object.name)) instancedByName.set(object.name, object);
    const name = object.name || '';
    if (!objectsByName.has(name)) objectsByName.set(name, []);
    objectsByName.get(name).push(object);
  });
  const donorForMaterialKey = (materialKey) => {
    for (const [name, mesh] of instancedByName) {
      if (new RegExp(`^chunk \\S+ ${materialKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(name)) return mesh;
    }
    return null;
  };

  const touchedInstanced = new Set();
  for (const op of build.operations) {
    if (op.op === 'instance') {
      const mesh = instancedByName.get(op.mesh);
      if (!mesh || !Number.isInteger(op.index) || op.index >= mesh.count) { summary.skipped += 1; continue; }
      mesh.setMatrixAt(op.index, new THREE.Matrix4().fromArray(op.matrix));
      touchedInstanced.add(mesh);
      summary.applied += 1;
      continue;
    }
    if (op.op === 'object') {
      const target = objectsByName.get(op.name || '')?.[op.nameIndex];
      if (!target) { summary.skipped += 1; continue; }
      applyTransformOp(target, op);
      applyObjectFaceStyles(target, op.faceTextures || {}, customAssets?.textures || {});
      summary.applied += 1;
      continue;
    }
    if (op.op === 'place' || op.op === 'place-primitive' || op.op === 'place-custom') {
      const placed = buildPlacedObject(op, donorForMaterialKey, customAssets);
      if (!placed) { summary.skipped += 1; continue; }
      // Streamed with the world chunks so far-away placements cost nothing;
      // the shared group is only the fallback for maps without chunk support.
      if (typeof map.attachStreamedObject === 'function') map.attachStreamedObject(placed);
      else placedGroup(map.group).add(placed);
      summary.applied += 1;
      continue;
    }
    summary.skipped += 1;
  }
  for (const mesh of touchedInstanced) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox?.();
    mesh.computeBoundingSphere?.();
  }
  return summary;
}

export function applyGarageBuild(garageRoot, build, customAssets = null) {
  const summary = { applied: 0, skipped: 0 };
  if (!garageRoot || !build) return summary;
  // Garage children are addressed by build-order index, so this must run right
  // after GarageSystem.build() and before deliveries/cars mutate the root.
  const children = [...garageRoot.children];
  for (const op of build.operations) {
    if (op.op === 'garage-object') {
      const target = children[op.childIndex];
      if (!target) { summary.skipped += 1; continue; }
      const mirrorKey = target.userData?.editorBuildMirror;
      const targets = mirrorKey
        ? children.filter((child) => child.userData?.editorBuildMirror === mirrorKey)
        : [target];
      for (const operationTarget of targets) {
        const quaternionOffset = operationTarget.userData?.editorBuildQuaternionOffset;
        const targetOp = quaternionOffset
          ? {
              ...op,
              quaternion: new THREE.Quaternion()
                .fromArray(op.quaternion)
                .multiply(new THREE.Quaternion().fromArray(quaternionOffset))
                .normalize()
                .toArray(),
            }
          : op;
        applyTransformOp(operationTarget, targetOp);
        applyObjectFaceStyles(operationTarget, op.faceTextures || {}, customAssets?.textures || {});
      }
      if (target.userData?.editorAnchorFollower) target.userData.editorBuildTransformApplied = true;
      summary.applied += 1;
      continue;
    }
    if (op.op === 'place-primitive' || op.op === 'place-custom') {
      const placed = buildPlacedObject(op, () => null, customAssets);
      if (!placed) { summary.skipped += 1; continue; }
      placedGroup(garageRoot).add(placed);
      summary.applied += 1;
      continue;
    }
    summary.skipped += 1;
  }
  return summary;
}

export function applyBuildSkybox(scene, build, customAssets = null) {
  if (!scene) return false;
  let renderer = scene.userData?.hesiSkyboxRenderer || null;
  const config = build?.environment?.skybox || null;
  if (!config) {
    renderer?.set({ enabled: false }, {});
    return false;
  }
  if (!renderer) {
    renderer = new SkyboxRenderer(scene, {
      // The source file stays full-resolution on disk; the runtime upload is
      // bounded independently so an 8K panorama cannot dominate game VRAM.
      maxTextureSize: 2048,
      onError: (message) => console.warn(`[editor-map-patch] ${message}`),
    });
    scene.userData.hesiSkyboxRenderer = renderer;
  }
  return renderer.set(config, customAssets?.textures || {});
}

export async function applyEditorBuilds({ map = null, garageRoot = null, roadScene = null, garageScene = null } = {}) {
  const summary = { applied: 0, skipped: 0, scenes: [] };
  const merge = (scene, partial) => {
    summary.applied += partial.applied;
    summary.skipped += partial.skipped;
    if (partial.applied || partial.skipped) summary.scenes.push({ scene, ...partial });
  };
  // All three documents are small (textures live in separate image files that
  // stream in asynchronously), so fetch them in parallel and apply at once.
  const [customAssets, highwayBuild, garageBuild] = await Promise.all([
    fetchCustomAssetsDocument(),
    map ? fetchBuild('highway') : null,
    garageRoot ? fetchBuild('garage') : null,
  ]);
  summary.customAssets = customAssets;
  if (map) {
    // World look dials saved on the highway build (wet-asphalt gloss, ...).
    const gloss = highwayBuild?.environment?.surfaceGloss;
    if (Number.isFinite(gloss) && typeof map.setSurfaceGloss === 'function') {
      map.setSurfaceGloss(gloss);
      summary.scenes.push({ scene: 'world-look', applied: 1, skipped: 0 });
    }
    // Saved world texture overrides (custom road asphalt, walls, ...) apply
    // even when no build file exists yet.
    if (customAssets && map.materials) {
      const textures = applyWorldTextureOverrides(map.materials, customAssets);
      if (textures.applied) summary.scenes.push({ scene: 'world-textures', ...textures });
    }
    // Saved replacement models for the instanced archetypes (containers, lamps,
    // barriers, ...) swap the shape every copy of that bucket draws.
    if (customAssets) {
      const models = applyWorldModelOverrides(map, customAssets);
      if (models.applied) summary.scenes.push({ scene: 'world-models', ...models });
    }
    if (applyBuildSkybox(roadScene, highwayBuild, customAssets)) merge('highway-skybox', { applied: 1, skipped: 0 });
    if (roadScene && highwayBuild?.environment?.lighting && applySceneLighting(roadScene, highwayBuild.environment.lighting)) {
      summary.scenes.push({ scene: 'highway-lighting', applied: 1, skipped: 0 });
    }
    if (highwayBuild) merge('highway', applyHighwayBuild(map, highwayBuild, customAssets));
  }
  if (garageRoot) {
    if (applyBuildSkybox(garageScene, garageBuild, customAssets)) merge('garage-skybox', { applied: 1, skipped: 0 });
    if (garageScene && garageBuild?.environment?.lighting && applySceneLighting(garageScene, garageBuild.environment.lighting)) {
      summary.scenes.push({ scene: 'garage-lighting', applied: 1, skipped: 0 });
    }
    if (garageBuild) merge('garage', applyGarageBuild(garageRoot, garageBuild, customAssets));
  }
  return summary;
}
