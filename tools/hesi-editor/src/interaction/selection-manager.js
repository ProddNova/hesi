import * as THREE from 'three';
import { instanceWorldMatrix } from '../world/world-metadata.js';

const MAX_OVERLAY_COMPONENTS = 16;
const MAX_EDGE_VERTICES = 60000;
const ROAD_SURFACE_TYPES = new Set(['road-surface', 'service-road-surface']);
const ROUTE_ENTITY_TYPES = new Set(['road-route', 'service-route']);
// Paint batches sit directly on the asphalt: a click that lands on them means
// "the road". Everything else (lamps, signs, decks, props) is its own target.
const ROAD_PAINT_TYPES = new Set(['road-marking-batch', 'amber-marking-batch', 'marking-instance-batch']);
const ROAD_PICK_MAX_DISTANCE = 80;

/**
 * Rendered asphalt is merged into chunk meshes, while editable routes are
 * semantic entities. Resolve a surface hit through HighwayMap's 3D nearest
 * route query so clicking the visible road activates its centreline editor.
 */
export function resolveRoadSurfaceRoute(entity, hitPoint, adapter, routeEntitiesById) {
  if (!ROAD_SURFACE_TYPES.has(entity?.type) || !hitPoint || !adapter?.map?.getNearestRoute) return entity;
  const nearest = adapter.map.getNearestRoute(hitPoint, { maxDistance: ROAD_PICK_MAX_DISTANCE });
  return routeEntitiesById?.get(nearest?.route?.id) || entity;
}

export function isEditorHelper(object) {
  let current = object;
  while (current) {
    if (current.userData?.editorHelper) return true;
    current = current.parent;
  }
  return false;
}

function isActuallyVisible(object) {
  let current = object;
  while (current) {
    if (!current.visible) return false;
    current = current.parent;
  }
  return true;
}

export class SelectionManager {
  constructor({ viewport, registry, adapter, onChange = () => {}, onStatus = () => {} }) {
    this.viewport = viewport;
    this.registry = registry;
    this.adapter = adapter;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.selected = null;
    this.selectedEntities = [];
    this.routeEntitiesById = new Map(
      registry.list()
        .filter((entity) => ROUTE_ENTITY_TYPES.has(entity.type) && typeof entity.metadata?.routeId === 'string')
        .map((entity) => [entity.metadata.routeId, entity]),
    );
    this.inspectLocked = false;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._down = null;
    this._lastPick = { x: Infinity, y: Infinity, at: 0, ids: [], index: -1 };
    this.debug = { bounds: false, pivot: false };

    // Geometry-fitting selection highlight: translucent overlay clones of the
    // actual render meshes plus crisp edges for small geometry. Production
    // geometry is shared read-only; production materials are never touched.
    this.overlayMaterial = new THREE.MeshBasicMaterial({
      color: 0x2fd7f2, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: 0xaef3ff, transparent: true, opacity: 0.95 });
    this.highlightGroup = new THREE.Group();
    this.highlightGroup.name = 'Editor selection highlight';
    this.highlightGroup.userData.editorHelper = true;
    this.highlightGroup.renderOrder = 9999;
    this.highlightGroup.visible = false;
    viewport.scene.add(this.highlightGroup);
    this._edgeCache = new Map();
    this._overlaySources = [];

    // Optional debug helpers, both off by default.
    this.boundsHelper = new THREE.Box3Helper(new THREE.Box3(), 0x56e5ff);
    this.boundsHelper.name = 'Editor debug selection bounds';
    this.boundsHelper.visible = false;
    this.boundsHelper.userData.editorHelper = true;
    this.boundsHelper.material.depthTest = false;
    this.boundsHelper.material.transparent = true;
    this.boundsHelper.material.opacity = 0.92;
    this.boundsHelper.renderOrder = 10000;
    viewport.scene.add(this.boundsHelper);
    this.pivotHelper = new THREE.AxesHelper(4);
    this.pivotHelper.name = 'Editor debug selection pivot';
    this.pivotHelper.visible = false;
    this.pivotHelper.userData.editorHelper = true;
    viewport.scene.add(this.pivotHelper);

    this._onPointerDown = (event) => {
      if (event.button === 0) this._down = { x: event.clientX, y: event.clientY };
    };
    this._onPointerUp = (event) => {
      if (event.button !== 0 || !this._down) return;
      const travel = Math.hypot(event.clientX - this._down.x, event.clientY - this._down.y);
      this._down = null;
      if (travel > 4 || document.pointerLockElement === this.viewport.canvas) return;
      this.pick(event.clientX, event.clientY, { additive: event.shiftKey });
    };
    this._onKeyDown = (event) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '')) return;
      if (event.code === 'Escape' && document.pointerLockElement !== this.viewport.canvas) this.clear('keyboard');
      if (event.code === 'KeyF') {
        event.preventDefault();
        this.focusSelected();
      }
    };
    viewport.canvas.addEventListener('pointerdown', this._onPointerDown);
    viewport.canvas.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('keydown', this._onKeyDown);
  }

  setInspectLocked(enabled) { this.inspectLocked = Boolean(enabled); }

  setDebugOptions(patch = {}) {
    this.debug = { ...this.debug, ...patch };
    this.refreshHighlight();
  }

  canSelect(entity) {
    if (!entity || !this.registry.isLayerVisible(entity.layer)) return false;
    if (this.registry.isLayerLocked(entity.layer) && !this.inspectLocked) return false;
    if (entity.metadata?.locked && !this.inspectLocked) return false;
    if (entity.metadata?.disabled) return false;
    return true;
  }

  pick(clientX, clientY, { additive = false } = {}) {
    const rect = this.viewport.canvas.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.viewport.camera);
    const hits = this.raycaster.intersectObject(this.adapter.group, true);
    const candidates = [];
    const seen = new Set();
    for (const hit of hits) {
      if (isEditorHelper(hit.object) || !isActuallyVisible(hit.object)) continue;
      const pickedEntity = this.adapter.resolveSelection?.(hit.object, hit.instanceId);
      const entity = resolveRoadSurfaceRoute(pickedEntity, hit.point, this.adapter, this.routeEntitiesById);
      if (!this.canSelect(entity) || seen.has(entity.id)) continue;
      seen.add(entity.id);
      candidates.push(entity);
    }
    // Asphalt clicks often hit lane paint first. Promote the resolved route
    // over paint batches only, so clicking markings still selects the road
    // while lamps, signs, the Tatsumi PA deck, and other props keep natural
    // depth order and stay directly clickable.
    const routeIndex = candidates.findIndex((entity) => ROUTE_ENTITY_TYPES.has(entity.type));
    if (routeIndex > 0 && candidates.slice(0, routeIndex).every((entity) => ROAD_PAINT_TYPES.has(entity.type))) {
      candidates.unshift(...candidates.splice(routeIndex, 1));
    }
    if (!candidates.length) {
      // Shift+click on empty space keeps the current multi-selection.
      if (!additive) this.clear('viewport');
      else this.onStatus('No selectable object under pointer');
      return null;
    }
    if (additive) {
      return this.select(candidates[0], { source: 'viewport', additive: true, overlap: candidates.length, overlapIndex: 0 });
    }
    const now = Date.now();
    const sameSpot = Math.hypot(clientX - this._lastPick.x, clientY - this._lastPick.y) < 6 && now - this._lastPick.at < 900;
    const ids = candidates.map((entity) => entity.id);
    const sameHits = sameSpot && ids.length === this._lastPick.ids.length && ids.every((id, index) => id === this._lastPick.ids[index]);
    const index = sameHits ? (this._lastPick.index + 1) % candidates.length : 0;
    this._lastPick = { x: clientX, y: clientY, at: now, ids, index };
    return this.select(candidates[index], { source: 'viewport', overlap: candidates.length, overlapIndex: index });
  }

  select(entityOrId, { source = 'api', additive = false, overlap = 1, overlapIndex = 0 } = {}) {
    const entity = typeof entityOrId === 'string' ? this.registry.getById(entityOrId) : entityOrId;
    if (!this.canSelect(entity)) {
      this.onStatus(entity ? `${entity.layer} or entity is hidden, disabled, or locked` : 'Entity not found');
      return null;
    }
    if (additive) {
      const existing = this.selectedEntities.findIndex((item) => item.id === entity.id);
      if (existing >= 0) {
        this.selectedEntities.splice(existing, 1);
        if (this.selected?.id === entity.id) this.selected = this.selectedEntities[this.selectedEntities.length - 1] || null;
      } else {
        this.selectedEntities.push(entity);
        this.selected = entity;
      }
    } else {
      this.selectedEntities = [entity];
      this.selected = entity;
    }
    this._rebuildHighlight();
    this.refreshHighlight();
    const count = this.selectedEntities.length;
    this.onChange(this.selected, { source, selectedCount: count });
    this.onStatus(count > 1
      ? `${count} objects selected · primary ${this.selected?.name || 'none'} · delete/duplicate/visibility/lock apply to all`
      : count === 1
        ? `Selected ${this.selected.name} · ${this.selected.id}${overlap > 1 ? ` · hit ${overlapIndex + 1}/${overlap}` : ''}`
        : 'Selection cleared');
    return this.selected;
  }

  removeFromSelection(entityOrId, source = 'api') {
    const id = typeof entityOrId === 'string' ? entityOrId : entityOrId?.id;
    const index = this.selectedEntities.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.selectedEntities.splice(index, 1);
    if (this.selected?.id === id) this.selected = this.selectedEntities[this.selectedEntities.length - 1] || null;
    this._rebuildHighlight();
    this.refreshHighlight();
    this.onChange(this.selected, { source, selectedCount: this.selectedEntities.length });
    return true;
  }

  clear(source = 'api') {
    if (!this.selected && !this.selectedEntities.length) return;
    this.selected = null;
    this.selectedEntities = [];
    this.highlightGroup.visible = false;
    this.boundsHelper.visible = false;
    this.pivotHelper.visible = false;
    this.onChange(null, { source, selectedCount: 0 });
  }

  getSelectedBounds() {
    const box = new THREE.Box3();
    for (const entity of this.selectedEntities) {
      const entityBox = entity.getWorldBounds?.() || (entity.object3D ? new THREE.Box3().setFromObject(entity.object3D) : null);
      if (entityBox && !entityBox.isEmpty()) box.union(entityBox);
    }
    return box;
  }

  _edgesFor(geometry) {
    if (!geometry) return null;
    const vertices = geometry.getAttribute('position')?.count || 0;
    if (!vertices || vertices > MAX_EDGE_VERTICES) return null;
    if (!this._edgeCache.has(geometry)) this._edgeCache.set(geometry, new THREE.EdgesGeometry(geometry, 24));
    return this._edgeCache.get(geometry);
  }

  _addOverlay(geometry, source) {
    if (!geometry || this._overlaySources.length >= MAX_OVERLAY_COMPONENTS) return;
    const overlay = new THREE.Mesh(geometry, this.overlayMaterial);
    overlay.matrixAutoUpdate = false;
    overlay.userData.editorHelper = true;
    overlay.userData.source = source;
    overlay.renderOrder = 9998;
    this.highlightGroup.add(overlay);
    const edges = this._edgesFor(geometry);
    if (edges && !source.instancedBatch) {
      const line = new THREE.LineSegments(edges, this.edgeMaterial);
      line.matrixAutoUpdate = false;
      line.userData.editorHelper = true;
      line.userData.source = source;
      line.renderOrder = 9999;
      this.highlightGroup.add(line);
    }
    this._overlaySources.push(source);
  }

  _rebuildHighlight() {
    for (const child of [...this.highlightGroup.children]) {
      if (child.isInstancedMesh) child.instanceMatrix.dispose?.();
      child.removeFromParent();
    }
    this._overlaySources = [];
    for (const entity of this.selectedEntities) this._addEntityHighlight(entity);
    this.highlightGroup.visible = this.highlightGroup.children.length > 0;
  }

  _addEntityHighlight(entity) {
    if (!entity) return;
    const components = entity.metadata?.instanceComponents || [];
    const usesInstancedBatchOverlay = !components.length && entity.object3D?.isInstancedMesh;
    if (components.length || usesInstancedBatchOverlay) {
      if (components.length) {
        // Lamp glow quads (light pools, streaks) are effects, not geometry:
        // highlighting them reads as a giant blob, so keep physical parts only.
        const physical = components.filter((component) => !/lightpool|lightstreak|lampsodium|glow|flare/i.test(component.mesh?.name || ''));
        for (const component of (physical.length ? physical : components).slice(0, MAX_OVERLAY_COMPONENTS)) {
          this._addOverlay(component.mesh?.geometry, { kind: 'instance', mesh: component.mesh, instanceIndex: component.instanceIndex });
        }
      } else {
        const mesh = entity.object3D;
        const overlay = new THREE.InstancedMesh(mesh.geometry, this.overlayMaterial, mesh.count);
        overlay.instanceMatrix.array.set(mesh.instanceMatrix.array);
        overlay.instanceMatrix.needsUpdate = true;
        overlay.matrixAutoUpdate = false;
        overlay.userData.editorHelper = true;
        overlay.userData.source = { kind: 'object', object: mesh };
        overlay.renderOrder = 9998;
        this.highlightGroup.add(overlay);
        this._overlaySources.push({ kind: 'object', object: mesh, instancedBatch: true });
      }
      return;
    }
    // Plain render objects (chunk-merged road/building meshes, direct meshes,
    // placed objects): tint the actual geometry and add edges when it is
    // small enough for an edge pass to stay readable.
    const root = entity.object3D;
    if (!root) return;
    const meshes = [];
    root.traverse?.((child) => { if (child.isMesh && !child.isInstancedMesh && meshes.length < MAX_OVERLAY_COMPONENTS) meshes.push(child); });
    if (root.isMesh && !root.isInstancedMesh && !meshes.includes(root)) meshes.unshift(root);
    for (const mesh of meshes.slice(0, MAX_OVERLAY_COMPONENTS)) {
      this._addOverlay(mesh.geometry, { kind: 'object', object: mesh });
    }
  }

  refreshHighlight() {
    const entity = this.selected;
    if (!this.selectedEntities.length) {
      this.highlightGroup.visible = false;
      this.boundsHelper.visible = false;
      this.pivotHelper.visible = false;
      return;
    }
    const matrix = new THREE.Matrix4();
    let overlayVisible = false;
    for (const child of this.highlightGroup.children) {
      const source = child.userData.source;
      if (!source) continue;
      if (source.kind === 'instance') instanceWorldMatrix(source.mesh, source.instanceIndex, matrix);
      else {
        source.object.updateWorldMatrix(true, false);
        matrix.copy(source.object.matrixWorld);
      }
      child.matrix.copy(matrix);
      child.matrixWorld.copy(matrix);
      overlayVisible = true;
    }
    this.highlightGroup.visible = overlayVisible;
    const box = this.getSelectedBounds();
    const showBounds = this.debug.bounds && !box.isEmpty();
    this.boundsHelper.visible = showBounds;
    if (showBounds) {
      this.boundsHelper.box.copy(box);
      this.boundsHelper.updateMatrixWorld(true);
    }
    const showPivot = this.debug.pivot && entity?.object3D;
    this.pivotHelper.visible = Boolean(showPivot);
    if (showPivot) {
      this.pivotHelper.position.copy(entity.object3D.getWorldPosition(new THREE.Vector3()));
      const size = box.isEmpty() ? 4 : Math.min(30, Math.max(2, box.getSize(new THREE.Vector3()).length() * 0.35));
      this.pivotHelper.scale.setScalar(size / 4);
      this.pivotHelper.updateMatrixWorld(true);
    }
  }

  focusSelected() {
    if (!this.selected) { this.onStatus('Nothing selected to focus'); return false; }
    const box = this.getSelectedBounds();
    if (box.isEmpty()) { this.onStatus(`${this.selected.name} has metadata only; no visual bounds to frame`); return false; }
    this.adapter.setChunkMode('nearby', box.getCenter(new THREE.Vector3()));
    const focused = this.viewport.focusOn(box);
    if (focused) this.onStatus(`Focused ${this.selected.name}`);
    return focused;
  }

  dispose() {
    this.viewport.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.viewport.canvas.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('keydown', this._onKeyDown);
    for (const edges of this._edgeCache.values()) edges.dispose();
    this._edgeCache.clear();
    this.highlightGroup.removeFromParent();
    this.boundsHelper.removeFromParent();
    this.boundsHelper.geometry.dispose();
    this.boundsHelper.material.dispose();
    this.pivotHelper.removeFromParent();
    this.pivotHelper.geometry.dispose();
    this.pivotHelper.material.dispose();
    this.overlayMaterial.dispose();
    this.edgeMaterial.dispose();
  }
}
