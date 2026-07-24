import * as THREE from 'three';
import { BUILD_SCHEMA_VERSION, buildDraftSignature, validateBuildDocument } from './build-schema.js';
import { normalizeSkyboxConfig } from '../../../../js/skybox-config.js';
import {
  LOCAL_LIGHT_ASSET_ID,
  normalizeLighting,
  normalizeLocalLight,
  isDefaultLighting,
} from '../../../../js/lighting-config.js';

/**
 * Resolves a saved project document against the live world into a flat build
 * document (see build-schema.js) that the game replays without editor code.
 */

const materialKeyFromMeshName = (name) => String(name || '').replace(/^chunk\s+\S+\s+/, '');

// Only the non-default parts of the environment travel with the build: an
// untouched skybox/lighting leaves the game's shipped look exactly as generated.
function buildEnvironment(environment) {
  const output = {};
  if (environment?.skybox) output.skybox = normalizeSkyboxConfig(environment.skybox);
  if (environment?.lighting && !isDefaultLighting(environment.lighting)) output.lighting = normalizeLighting(environment.lighting);
  const gloss = environment?.surfaceGloss;
  if (Number.isFinite(gloss) && Math.abs(gloss - 1) > 1e-3) output.surfaceGloss = Math.min(3, Math.max(0, gloss));
  return output;
}

// Deterministic occurrence index of `target` among identically named objects in
// a depth-first walk of the generated world. The game repeats the same walk on
// its own freshly generated map, so the pair (name, nameIndex) addresses the
// same object on both sides. Editor-owned helpers and placed objects are
// skipped because they do not exist in the game's walk.
function nameIndexFor(root, target) {
  let index = 0;
  let found = null;
  const targetName = target.name || '';
  const walk = (object) => {
    if (found !== null) return;
    if (object.userData?.editorHelper || object.userData?.editorPlacedObject) return;
    if (object.name === 'Editor placed objects') return;
    if (object !== root) {
      if (object === target) { found = index; return; }
      if ((object.name || '') === targetName) index += 1;
    }
    for (const child of object.children) walk(child);
  };
  walk(root);
  return found;
}

function persistedTransformFields(transform) {
  const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(...transform.rotation, 'XYZ'));
  return {
    position: [...transform.position],
    quaternion: quaternion.toArray(),
    scale: [...transform.scale],
  };
}

function liveTransformFields(object) {
  return {
    position: object.position.toArray(),
    quaternion: object.quaternion.toArray(),
    scale: object.scale.toArray(),
  };
}

const overrideVisible = (override) => override.visible !== false && !override.disabled;

function instanceOperations(entity) {
  const matrix = new THREE.Matrix4();
  return entity.metadata.instanceComponents.map((component) => {
    component.mesh.getMatrixAt(component.instanceIndex, matrix);
    return {
      op: 'instance',
      mesh: component.mesh.name,
      index: component.instanceIndex,
      matrix: matrix.toArray(),
    };
  });
}

function highwayOperations({ adapter, registry, assetRegistry, projectDocument }) {
  const operations = [];
  for (const [id, override] of Object.entries(projectDocument.entityOverrides)) {
    const entity = registry.getById(id);
    if (!entity) continue;
    if (entity.metadata?.instanceComponents?.length) {
      operations.push(...instanceOperations(entity));
      continue;
    }
    const object = entity.object3D;
    if (!object || object.userData?.editorInstanceProxy) continue; // semantic-only entity: nothing to bake
    const nameIndex = nameIndexFor(adapter.group, object);
    if (nameIndex === null) continue;
    operations.push({
      op: 'object',
      name: object.name || '',
      nameIndex,
      ...(override.transform ? persistedTransformFields(override.transform) : liveTransformFields(object)),
      visible: overrideVisible(override),
      ...(override.faceTextures && Object.keys(override.faceTextures).length ? { faceTextures: override.faceTextures } : {}),
    });
  }
  operations.push(...placedOperations({ assetRegistry, projectDocument }));
  return operations;
}

function garageOperations({ registry, assetRegistry, projectDocument }) {
  const operations = [];
  for (const [id, override] of Object.entries(projectDocument.entityOverrides)) {
    const entity = registry.getById(id);
    const childIndex = entity?.metadata?.garageChildIndex;
    if (!Number.isInteger(childIndex)) continue;
    operations.push({
      op: 'garage-object',
      childIndex,
      ...(override.transform ? persistedTransformFields(override.transform) : liveTransformFields(entity.object3D)),
      visible: overrideVisible(override),
      ...(override.faceTextures && Object.keys(override.faceTextures).length ? { faceTextures: override.faceTextures } : {}),
    });
  }
  operations.push(...placedOperations({ assetRegistry, projectDocument }));
  return operations;
}

function placedOperations({ assetRegistry, projectDocument }) {
  const operations = [];
  for (const placed of projectDocument.placedObjects) {
    const asset = assetRegistry.get(placed.assetId);
    if (!asset) continue;
    const base = {
      name: placed.name || placed.id,
      ...persistedTransformFields(placed.transform),
      visible: placed.visible !== false,
      ...(placed.faceTextures && Object.keys(placed.faceTextures).length ? { faceTextures: placed.faceTextures } : {}),
    };
    if (asset.kind === 'light' || placed.assetId === LOCAL_LIGHT_ASSET_ID) {
      operations.push({ op: 'place-light', light: normalizeLocalLight(placed.light), ...base });
      continue;
    }
    if (asset.kind === 'primitive') {
      operations.push({ op: 'place-primitive', primitive: placed.assetId.split(':').pop(), ...base });
      continue;
    }
    if (asset.kind === 'custom') {
      operations.push({ op: 'place-custom', assetId: placed.assetId, ...base });
      continue;
    }
    const baseInverse = asset.baseWorldMatrix.clone().invert();
    operations.push({
      op: 'place',
      ...base,
      components: asset.components.map((component) => ({
        materialKey: materialKeyFromMeshName(component.name),
        matrix: baseInverse.clone().multiply(component.sourceWorldMatrix).toArray(),
      })),
    });
  }
  return operations;
}

export function buildSceneDocument({ sceneId, adapter, registry, assetRegistry, projectDocument, projectPath }) {
  const operations = sceneId === 'garage'
    ? garageOperations({ registry, assetRegistry, projectDocument })
    : highwayOperations({ adapter, registry, assetRegistry, projectDocument });
  const document = {
    version: BUILD_SCHEMA_VERSION,
    scene: sceneId,
    generatedAt: new Date().toISOString(),
    project: {
      name: projectDocument.project.name,
      path: projectPath,
      draftSignature: buildDraftSignature(projectDocument),
    },
    environment: buildEnvironment(projectDocument.environment),
    operations,
  };
  validateBuildDocument(document);
  return document;
}
