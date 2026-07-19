import * as THREE from 'three';
import { buildCustomAssetGroup } from '/js/custom-assets.js';

// Bridges the shared custom-asset builder (js/custom-assets.js) with the
// editor's AssetRegistry: resolves assembled world-asset parts through live
// registry geometry, flattens built groups into placement components, and
// bakes registry assets into game-replayable components.

const materialKeyFromMeshName = (name) => String(name || '').replace(/^chunk\s+\S+\s+/, '');

/** Builds a THREE.Group for one registry asset (world, primitive, or custom). */
export function groupFromRegistryAsset(asset) {
  if (!asset?.components?.length) return null;
  const root = new THREE.Group();
  root.name = asset.label || asset.id;
  const baseInverse = asset.baseWorldMatrix.clone().invert();
  for (const component of asset.components) {
    const mesh = new THREE.Mesh(component.geometry, component.material);
    mesh.name = component.name || asset.id;
    mesh.castShadow = component.castShadow;
    mesh.receiveShadow = component.receiveShadow;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.multiplyMatrices(baseInverse, component.sourceWorldMatrix);
    root.add(mesh);
  }
  return root;
}

/** resolveAssetPart callback for the shared builder, backed by the registry. */
export function assetPartResolver(assetRegistry) {
  return (part) => groupFromRegistryAsset(assetRegistry.get(part.assetRef));
}

/**
 * Flattens a built custom-asset group into the component records the
 * AssetRegistry and placement pipeline understand.
 */
export function componentsForCustomAsset(definition, texturesById, assetRegistry) {
  const group = buildCustomAssetGroup(definition, texturesById, { resolveAssetPart: assetPartResolver(assetRegistry) });
  group.updateMatrixWorld(true);
  const components = [];
  group.traverse((child) => {
    if (!child.isMesh) return;
    components.push({
      geometry: child.geometry,
      material: child.material,
      sourceWorldMatrix: child.matrixWorld.clone(),
      castShadow: Boolean(child.castShadow),
      receiveShadow: Boolean(child.receiveShadow),
      name: child.name,
    });
  });
  return components;
}

/** Registers every asset of a custom-assets document into the registry. */
export function registerCustomAssets(assetRegistry, document) {
  let registered = 0;
  for (const definition of Object.values(document?.assets || {})) {
    const components = componentsForCustomAsset(definition, document.textures, assetRegistry);
    if (assetRegistry.registerCustomAsset(definition, components)) registered += 1;
  }
  return registered;
}

/** Re-registers one asset after a Modeler edit (refreshes geometry/materials). */
export function refreshCustomAsset(assetRegistry, document, assetId) {
  const definition = document?.assets?.[assetId];
  if (!definition) return null;
  const components = componentsForCustomAsset(definition, document.textures, assetRegistry);
  return assetRegistry.registerCustomAsset(definition, components);
}

/**
 * Bakes a registry asset into game-replayable `{materialKey, matrix}`
 * components. The game rebuilds these from its own generated donor meshes
 * (same mechanism as `place` build operations).
 */
export function bakeAssetPartComponents(assetRegistry, assetRef) {
  const asset = assetRegistry.get(assetRef);
  if (!asset || asset.kind === 'custom') return [];
  const baseInverse = asset.baseWorldMatrix.clone().invert();
  return asset.components.map((component) => ({
    materialKey: materialKeyFromMeshName(component.name),
    matrix: baseInverse.clone().multiply(component.sourceWorldMatrix).toArray(),
  }));
}

/**
 * Builds a custom-asset definition from live selected entities: each entity
 * with a reusable asset becomes one assembled part, positioned relative to
 * the first entity so signs+poles (and similar split map elements) become a
 * single placeable object.
 */
export function assembleDefinitionFromEntities(entities, assetRegistry, { id, label }) {
  const usable = (entities || []).filter((entity) => entity?.assetId && assetRegistry.has(entity.assetId) && entity.object3D);
  if (usable.length < 1) throw new Error('Select objects with reusable assets (lamps, signs, barriers, placed objects) to assemble');
  for (const entity of usable) entity.object3D.updateWorldMatrix(true, false);
  const pivotInverse = usable[0].object3D.matrixWorld.clone();
  // Anchor at the first object's position, but keep the asset upright.
  const pivotPosition = new THREE.Vector3().setFromMatrixPosition(pivotInverse);
  const pivot = new THREE.Matrix4().makeTranslation(pivotPosition.x, pivotPosition.y, pivotPosition.z).invert();
  const parts = usable.map((entity) => {
    const local = pivot.clone().multiply(entity.object3D.matrixWorld);
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    local.decompose(position, quaternion, scale);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
    const registryAsset = assetRegistry.get(entity.assetId);
    return {
      kind: 'asset',
      name: entity.name,
      assetRef: entity.assetId,
      components: registryAsset.kind === 'custom' ? undefined : bakeAssetPartComponents(assetRegistry, entity.assetId),
      position: position.toArray(),
      rotation: euler.toArray().slice(0, 3),
      scale: scale.toArray(),
    };
  });
  return {
    id,
    label,
    description: `Assembled from ${usable.length} map object${usable.length === 1 ? '' : 's'}`,
    layer: usable[0].layer || 'Props',
    createdAt: new Date().toISOString(),
    parts,
  };
}
