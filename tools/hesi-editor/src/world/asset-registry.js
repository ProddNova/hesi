import * as THREE from 'three';
import { objectRenderMetadata } from './world-metadata.js';

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
    return this;
  }

  supports(entity) {
    return Boolean(entity?.assetId && this.assets.has(entity.assetId));
  }

  has(assetId) { return this.assets.has(assetId); }
  ids() { return new Set(this.assets.keys()); }
  sourceEntityId(assetId) { return this.assets.get(assetId)?.sourceEntityId || null; }

  createPlacedEntity(sourceEntity, { id = null, name = null } = {}) {
    const asset = this.assets.get(sourceEntity?.assetId);
    if (!asset) throw new Error('This entity has no reusable asset reference');
    const placedId = id || `placed:${String(this.nextPlacedIndex++).padStart(4, '0')}`;
    const placedIndex = Number(placedId.match(/^placed:(\d+)$/)?.[1]);
    if (Number.isInteger(placedIndex)) this.nextPlacedIndex = Math.max(this.nextPlacedIndex, placedIndex + 1);
    const root = new THREE.Group();
    root.name = name || `${sourceEntity.name} copy`;
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
    root.position.copy(sourceEntity.object3D.position);
    root.quaternion.copy(sourceEntity.object3D.quaternion);
    root.scale.copy(sourceEntity.object3D.scale);
    root.position.x += 2;
    this.editorGroup.add(root);
    root.updateMatrixWorld(true);
    const entity = {
      id: placedId,
      name: root.name,
      type: 'placed-asset-instance',
      layer: sourceEntity.layer,
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
        sourceEntityId: sourceEntity.id,
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
