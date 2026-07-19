import * as THREE from 'three';
import { instanceWorldMatrix, objectRenderMetadata } from './world-metadata.js';

function matrixFromArray(values) {
  return new THREE.Matrix4().fromArray(values);
}

function transformRecord(object) {
  return {
    position: object.position.toArray(),
    quaternion: object.quaternion.toArray(),
    scale: object.scale.toArray(),
  };
}

// Batch instanced meshes (one draw per material bucket) can still donate a
// single segment as a reusable placement asset.
const SEGMENT_ASSETS = Object.freeze({
  barrier: { label: 'Concrete Barrier', description: 'Single road-edge concrete barrier segment', layer: 'Barriers' },
  fence: { label: 'Safety Fence', description: 'Single safety fence segment', layer: 'Barriers' },
  railMetal: { label: 'Guardrail', description: 'Single metal guardrail segment', layer: 'Guardrails' },
  exitGreen: { label: 'Exit Sign', description: 'Overhead green exit sign panel', layer: 'Signs' },
  chevron: { label: 'Chevron Sign', description: 'Curve chevron warning sign', layer: 'Signs' },
});

const WORLD_ASSET_LABELS = Object.freeze({
  'hesi:lamppost:concrete': { label: 'Highway Lamp', description: 'Road-side lamp post with light head', layer: 'Lamps' },
  'hesi:box:concrete': { label: 'Concrete Pillar', description: 'Expressway support column', layer: 'Pillars' },
  'hesi:box:concreteDark': { label: 'Dark Concrete Pillar', description: 'Dark concrete support column', layer: 'Pillars' },
  'hesi:box:canopy': { label: 'PA Canopy', description: 'Service-area canopy roof', layer: 'Props' },
  'hesi:box:konbini': { label: 'Konbini Store', description: 'Small convenience-store building', layer: 'Props' },
  'hesi:box:vending': { label: 'Vending Machine', description: 'Drinks vending machine', layer: 'Props' },
  'hesi:box:garage': { label: 'Garage Structure', description: 'Garage bay structure module', layer: 'Garage' },
});

const CATALOG_ORDER = [
  'hesi:lamppost:concrete',
  'hesi:box:concrete',
  'hesi:box:concreteDark',
  'hesi:segment:barrier',
  'hesi:segment:railMetal',
  'hesi:segment:exitGreen',
  'hesi:box:canopy',
  'hesi:box:konbini',
  'hesi:box:vending',
  'hesi:box:garage',
  'editor:primitive:box',
  'editor:primitive:cylinder',
  'editor:primitive:sphere',
];

export class AssetRegistry {
  constructor({ editorGroup }) {
    this.editorGroup = editorGroup;
    this.assets = new Map();
    this.nextPlacedIndex = 1;
  }

  collect(entities) {
    for (const entity of entities) {
      if (!entity.assetId || !entity.metadata?.instanceEligible || this.assets.has(entity.assetId)) continue;
      const components = entity.metadata.instanceComponents || [];
      if (!components.length || components.some((component) => !component.mesh?.geometry || !component.mesh?.material)) continue;
      const baseWorldMatrix = matrixFromArray(entity.metadata.sourceWorldMatrix);
      this.assets.set(entity.assetId, {
        id: entity.assetId,
        kind: 'world',
        sourceEntityId: entity.id,
        components: components.map((component) => ({
          geometry: component.mesh.geometry,
          material: component.mesh.material,
          sourceWorldMatrix: matrixFromArray(component.sourceWorldMatrix),
          castShadow: component.mesh.castShadow,
          receiveShadow: component.mesh.receiveShadow,
          name: component.mesh.name,
        })),
        baseWorldMatrix,
      });
    }
    for (const entity of entities) {
      const instanceType = entity.metadata?.instanceType || '';
      const material = instanceType.split(':')[1];
      const segment = SEGMENT_ASSETS[material];
      if (!segment || entity.metadata?.instanceEligible || !entity.object3D?.isInstancedMesh) continue;
      const assetId = `hesi:segment:${material}`;
      if (this.assets.has(assetId) || entity.object3D.count < 1) continue;
      this.assets.set(assetId, {
        id: assetId,
        kind: 'world',
        sourceEntityId: entity.id,
        components: [{
          geometry: entity.object3D.geometry,
          material: entity.object3D.material,
          sourceWorldMatrix: instanceWorldMatrix(entity.object3D, 0, new THREE.Matrix4()).clone(),
          castShadow: entity.object3D.castShadow,
          receiveShadow: entity.object3D.receiveShadow,
          name: entity.object3D.name,
        }],
        baseWorldMatrix: instanceWorldMatrix(entity.object3D, 0, new THREE.Matrix4()).clone(),
      });
    }
    this._definePrimitives();
    return this;
  }

  _definePrimitives() {
    const material = new THREE.MeshStandardMaterial({ color: 0x9aa7b5, roughness: 0.72, metalness: 0.06, name: 'editor-primitive' });
    const primitives = [
      ['editor:primitive:box', 'Box', 'Simple 1 m box primitive', new THREE.BoxGeometry(1, 1, 1)],
      ['editor:primitive:cylinder', 'Cylinder', 'Simple 1 m cylinder primitive', new THREE.CylinderGeometry(0.5, 0.5, 1, 24)],
      ['editor:primitive:sphere', 'Sphere', 'Simple 1 m sphere primitive', new THREE.SphereGeometry(0.5, 24, 16)],
    ];
    for (const [id, label, description, geometry] of primitives) {
      if (this.assets.has(id)) continue;
      geometry.name = label;
      this.assets.set(id, {
        id,
        kind: 'primitive',
        label,
        description,
        layer: 'Props',
        editorOwned: true,
        sourceEntityId: null,
        components: [{
          geometry,
          material,
          sourceWorldMatrix: new THREE.Matrix4(),
          castShadow: false,
          receiveShadow: false,
          name: label,
        }],
        baseWorldMatrix: new THREE.Matrix4(),
      });
    }
  }

  /**
   * Registers (or refreshes) one Modeler-built custom asset. `components` are
   * pre-built meshes flattened to the shared component shape; `definition` is
   * the persisted document entry (kept for build ops and re-editing).
   */
  registerCustomAsset(definition, components) {
    if (!definition?.id || !Array.isArray(components) || !components.length) return null;
    const asset = {
      id: definition.id,
      kind: 'custom',
      label: definition.label || definition.id,
      description: definition.description || 'Custom modeled object',
      layer: definition.layer || 'Props',
      editorOwned: true,
      sourceEntityId: null,
      components,
      baseWorldMatrix: new THREE.Matrix4(),
      definition,
    };
    this.assets.set(definition.id, asset);
    return asset;
  }

  removeCustomAsset(assetId) {
    const asset = this.assets.get(assetId);
    if (!asset || asset.kind !== 'custom') return false;
    return this.assets.delete(assetId);
  }

  customAssets() {
    return [...this.assets.values()].filter((asset) => asset.kind === 'custom');
  }

  supports(entity) {
    return Boolean(entity?.assetId && this.assets.has(entity.assetId));
  }

  has(assetId) { return this.assets.has(assetId); }
  ids() { return new Set(this.assets.keys()); }
  sourceEntityId(assetId) { return this.assets.get(assetId)?.sourceEntityId || null; }
  get(assetId) { return this.assets.get(assetId) || null; }

  catalog() {
    const entries = [];
    // Modeler-built objects come first so new creations are easy to find.
    for (const asset of this.customAssets().sort((a, b) => a.label.localeCompare(b.label))) {
      entries.push({
        id: asset.id,
        label: asset.label,
        description: asset.description,
        kind: 'custom',
        layer: asset.layer || 'Props',
      });
    }
    for (const id of CATALOG_ORDER) {
      const asset = this.assets.get(id);
      if (!asset) continue;
      const curated = WORLD_ASSET_LABELS[id];
      entries.push({
        id,
        label: asset.label || curated?.label || SEGMENT_ASSETS[id.replace('hesi:segment:', '')]?.label || id,
        description: asset.description || curated?.description || SEGMENT_ASSETS[id.replace('hesi:segment:', '')]?.description || 'Reusable world asset',
        kind: asset.kind,
        layer: asset.layer || curated?.layer || 'Props',
      });
    }
    return entries;
  }

  createPlacedEntity(sourceOrId, { id = null, name = null, position = null } = {}) {
    const fromId = typeof sourceOrId === 'string';
    const sourceEntity = fromId ? null : sourceOrId;
    const asset = this.assets.get(fromId ? sourceOrId : sourceEntity?.assetId);
    if (!asset) throw new Error('This entity has no reusable asset reference');
    const placedId = id || `placed:${String(this.nextPlacedIndex++).padStart(4, '0')}`;
    const placedIndex = Number(placedId.match(/^placed:(\d+)$/)?.[1]);
    if (Number.isInteger(placedIndex)) this.nextPlacedIndex = Math.max(this.nextPlacedIndex, placedIndex + 1);
    const root = new THREE.Group();
    root.name = name || (sourceEntity ? `${sourceEntity.name} copy` : asset.label || asset.id);
    root.userData.editorPlacedObject = true;
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
    if (sourceEntity) {
      root.position.copy(sourceEntity.object3D.position);
      root.quaternion.copy(sourceEntity.object3D.quaternion);
      root.scale.copy(sourceEntity.object3D.scale);
      if (!position) root.position.x += 2;
    }
    if (position) root.position.copy(position);
    this.editorGroup.add(root);
    root.updateMatrixWorld(true);
    const entity = {
      id: placedId,
      name: root.name,
      type: 'placed-asset-instance',
      layer: sourceEntity?.layer || asset.layer || 'Props',
      object3D: root,
      source: `editor asset reference:${asset.id}`,
      editable: true,
      generated: false,
      assetId: asset.id,
      parentId: null,
      visibilityObjects: [root],
      getWorldBounds: () => new THREE.Box3().setFromObject(root),
      metadata: {
        sourceKind: 'PLACED OBJECT',
        placed: true,
        sourceEntityId: asset.sourceEntityId ?? sourceEntity?.id ?? null,
        static: true,
        instanced: false,
        render: objectRenderMetadata(root),
        initialTransform: transformRecord(root),
        initialName: root.name,
      },
    };
    return entity;
  }

  recordFor(entity) {
    return {
      id: entity.id,
      name: entity.name,
      assetId: entity.assetId,
      layer: entity.layer,
      sourceEntityId: entity.metadata.sourceEntityId,
      transform: transformRecord(entity.object3D),
      visible: entity.object3D.visible,
      locked: Boolean(entity.metadata.locked),
    };
  }
}
