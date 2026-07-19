import * as THREE from 'three';
import { deletePoint, findRoute, insertPointAfter, movePoint, nearestSegment } from './road-edit-ops.js';

const ROUTES_MODULE_URL = '/data/routes-smoothed.js';
const ROUTE_EDIT_TYPES = new Set(['road-route', 'service-route']);
const LINE_COLOR = 0xffb020;
const HANDLE_COLOR = 0xffb020;
const ACTIVE_HANDLE_COLOR = 0xff5040;
const HANDLE_RADIUS = 2.2;
const HANDLE_RANGE = 400;
const HANDLE_CAP = 60;
const REFRESH_INTERVAL_MS = 250;
const STATUS_HINT = 'Road curve edit · drag points · double-click line inserts · Del removes point · Save, then Rebuild Map to publish';

/**
 * Road centreline curve edit mode. While a road-route entity is selected this
 * controller overlays the route's centreline polyline with draggable point
 * handles. Edits mutate the shared ROUTE_DATA module (the same object graph
 * js/map.js builds the world from), so the change applies to the next map
 * rebuild; persistence to disk goes through src/overrides/route-persistence.js.
 *
 * All listeners run on `window` in the capture phase so they pre-empt viewport
 * selection, orbit controls, and the editor's entity Delete binding while a
 * handle/line interaction is in progress.
 */
export class RoadEditController {
  constructor({ viewport, history, selection, onStatus = () => {}, onDirty = () => {} }) {
    this.viewport = viewport;
    this.history = history;
    this.selection = selection;
    this.onStatus = onStatus;
    this.onDirty = onDirty;
    this.activeEntity = null;
    this.routeData = null;
    this.route = null;
    this.activeHandle = null;
    this.drag = null;
    this.dirty = new Set();
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 6;
    this.pointer = new THREE.Vector2();
    this.group = null;
    this.line = null;
    this.handles = [];
    this._handleKey = '';
    this._routeDataPromise = null;
    this._activateToken = null;
    this._refreshTimer = null;
    this._disposed = false;
    this._handleGeometry = new THREE.SphereGeometry(HANDLE_RADIUS, 12, 10);
    this._handleMaterial = new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, toneMapped: false });
    this._activeHandleMaterial = new THREE.MeshBasicMaterial({ color: ACTIVE_HANDLE_COLOR, depthTest: false, toneMapped: false });

    this._onPointerDown = (event) => {
      if (!this.active || event.target !== this.viewport.canvas || event.button !== 0) return;
      this._setPointer(event);
      const hit = this.raycaster.intersectObjects(this.handles, false)[0];
      if (!hit) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const mesh = hit.object;
      const index = mesh.userData.pointIndex;
      this._setActiveHandle(index);
      if (index === 0 || index === this.route.points.length - 1) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this.onStatus('Route endpoints are protected to keep junctions connected');
        return;
      }
      const point = this.route.points[index];
      this.drag = {
        index,
        mesh,
        before: [point[0], point[2]],
        plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -point[1]),
        moved: false,
      };
      this.viewport.setNavigationBlocked(true);
    };
    this._onPointerMove = (event) => {
      if (!this.active || !this.drag) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      this._setPointer(event);
      const target = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(this.drag.plane, target)) return;
      const point = this.route.points[this.drag.index];
      this.drag.moved = true;
      this.drag.mesh.position.set(target.x, point[1], target.z);
      // Live preview only: ROUTE_DATA itself is mutated once, on commit.
      const position = this.line.geometry.getAttribute('position');
      position.setXYZ(this.drag.index, target.x, point[1], target.z);
      if (this.route.closed && this.drag.index === 0 && position.count === this.route.points.length + 1) {
        position.setXYZ(position.count - 1, target.x, point[1], target.z);
      }
      position.needsUpdate = true;
      this.line.geometry.computeBoundingSphere();
    };
    this._onPointerUp = (event) => {
      if (!this.active || !this.drag) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const drag = this.drag;
      this.drag = null;
      this.viewport.setNavigationBlocked(false);
      if (!drag.moved || !this.route) return;
      const route = this.route;
      const index = drag.index;
      const before = drag.before;
      const after = [drag.mesh.position.x, drag.mesh.position.z];
      this.history.execute({
        label: `Move road point · ${route.name}`,
        redo: () => { movePoint(route, index, after); this._refreshHelpers(); },
        undo: () => { movePoint(route, index, before); this._refreshHelpers(); },
      });
      this._markDirty(route.id);
    };
    this._onDblClick = (event) => {
      if (!this.active || event.target !== this.viewport.canvas || !this.line) return;
      this._setPointer(event);
      const hit = this.raycaster.intersectObject(this.line, false)[0];
      if (!hit) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const segment = nearestSegment(this.route.points, hit.point.x, hit.point.z);
      if (!segment) return;
      const route = this.route;
      const index = segment.index;
      const point = [...segment.point];
      this.activeHandle = index + 1;
      this.history.execute({
        label: `Insert road point · ${route.name}`,
        redo: () => { insertPointAfter(route, index, point); this._refreshHelpers(); },
        undo: () => { deletePoint(route, index + 1); this._refreshHelpers(); },
      });
      this._markDirty(route.id);
    };
    this._onKeyDown = (event) => {
      if (!this.active || this.activeHandle == null || !this.route) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || event.target?.isContentEditable || event.target?.closest?.('[contenteditable="true"]')) return;
      if (event.code !== 'Delete' && event.code !== 'Backspace') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.route.points.length <= 2) {
        this.onStatus('A road needs at least 2 points');
        return;
      }
      const route = this.route;
      const index = this.activeHandle;
      if (index === 0 || index === route.points.length - 1) {
        this.onStatus('Route endpoints are protected to keep junctions connected');
        return;
      }
      const snapshot = [...route.points[index]];
      this.activeHandle = null;
      this.history.execute({
        label: `Delete road point · ${route.name}`,
        redo: () => { deletePoint(route, index); this._refreshHelpers(); },
        undo: () => { route.points.splice(index, 0, [...snapshot]); this._refreshHelpers(); },
      });
      this._markDirty(route.id);
    };
    window.addEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.addEventListener('pointermove', this._onPointerMove, { capture: true });
    window.addEventListener('pointerup', this._onPointerUp, { capture: true });
    window.addEventListener('dblclick', this._onDblClick, { capture: true });
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
  }

  get active() { return Boolean(this.activeEntity); }

  hasDirty() { return this.dirty.size > 0; }

  get dirtyRouteIds() { return [...this.dirty]; }

  dirtyRouteUpdates() {
    if (!this.routeData || !this.dirty.size) return [];
    return this.routeData.routes
      .filter((route) => this.dirty.has(route.id))
      .map((route) => ({ id: route.id, points: structuredClone(route.points) }));
  }

  clearDirty() { this.dirty.clear(); }

  /** Activates curve editing for road-route entities; deactivates otherwise. */
  setActiveEntity(entity) {
    const routeId = entity?.metadata?.routeId;
    if (entity && ROUTE_EDIT_TYPES.has(entity.type) && typeof routeId === 'string' && routeId) {
      if (this.active && this.route && this.activeEntity.id === entity.id) return;
      this._deactivate();
      this.activeEntity = entity;
      this._activate(routeId);
    } else {
      this._deactivate();
    }
  }

  _markDirty(routeId) {
    this.dirty.add(routeId);
    this.onDirty(routeId);
  }

  _loadRouteData() {
    this._routeDataPromise ??= import(ROUTES_MODULE_URL).then((module) => module.default);
    return this._routeDataPromise;
  }

  async _activate(routeId) {
    const token = (this._activateToken = {});
    let data;
    try {
      data = await this._loadRouteData();
    } catch (error) {
      data = null;
      if (this._activateToken === token) this.onStatus(`Road route data failed to load · ${error.message}`);
    }
    if (this._activateToken !== token || this._disposed) return;
    this.routeData = data;
    const route = data && findRoute(data, routeId);
    if (!route) {
      this.activeEntity = null;
      if (data) this.onStatus(`Road route not found in data · ${routeId}`);
      return;
    }
    this.route = route;
    this._buildHelpers();
    this._refreshTimer = setInterval(() => this._refreshHandles(), REFRESH_INTERVAL_MS);
    this.onStatus(STATUS_HINT);
  }

  _deactivate() {
    this._activateToken = null;
    if (this.drag) {
      this.drag = null;
      this.viewport.setNavigationBlocked(false);
    }
    clearInterval(this._refreshTimer);
    this._refreshTimer = null;
    this.activeEntity = null;
    this.route = null;
    this.activeHandle = null;
    this._clearHelpers();
  }

  _setPointer(event) {
    const rect = this.viewport.canvas.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.viewport.camera);
  }

  _buildHelpers() {
    this._clearHelpers();
    const group = new THREE.Group();
    group.name = `road-edit:${this.route.id}`;
    group.userData.editorHelper = true;
    const material = new THREE.LineBasicMaterial({ color: LINE_COLOR, depthTest: false, toneMapped: false });
    this.line = new THREE.Line(new THREE.BufferGeometry(), material);
    this.line.renderOrder = 10000;
    this.line.userData.editorHelper = true;
    this.line.frustumCulled = false;
    group.add(this.line);
    this.group = group;
    this.viewport.scene.add(group);
    this._refreshLine();
    this._refreshHandles({ force: true });
  }

  _clearHelpers() {
    this.group?.removeFromParent();
    if (this.line) {
      this.line.geometry.dispose();
      this.line.material.dispose();
    }
    this.group = null;
    this.line = null;
    this.handles = [];
    this._handleKey = '';
  }

  _refreshHelpers() {
    if (!this.route || !this.group) return;
    this._refreshLine();
    this._refreshHandles({ force: true });
  }

  _refreshLine() {
    const flat = [];
    for (const point of this.route.points) flat.push(point[0], point[1], point[2]);
    if (this.route.closed && this.route.points.length > 2) {
      const first = this.route.points[0];
      flat.push(first[0], first[1], first[2]);
    }
    this.line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
    this.line.geometry.computeBoundingSphere();
  }

  _handleIndices() {
    const points = this.route.points;
    const camera = this.viewport.camera.position;
    const near = [];
    for (let index = 0; index < points.length; index += 1) {
      const dx = points[index][0] - camera.x;
      const dz = points[index][2] - camera.z;
      if (dx * dx + dz * dz <= HANDLE_RANGE * HANDLE_RANGE) near.push(index);
    }
    let indices = near;
    if (near.length > HANDLE_CAP) {
      indices = [];
      for (let sample = 0; sample < HANDLE_CAP; sample += 1) {
        indices.push(near[Math.round(sample * (near.length - 1) / (HANDLE_CAP - 1))]);
      }
    }
    if (this.activeHandle != null && !indices.includes(this.activeHandle)) indices.push(this.activeHandle);
    if (this.drag && !indices.includes(this.drag.index)) indices.push(this.drag.index);
    return indices;
  }

  _refreshHandles({ force = false } = {}) {
    if (!this.route || !this.group || this.drag) return;
    const key = this._handleIndices().join(',');
    if (!force && key === this._handleKey) return;
    this._handleKey = key;
    for (const mesh of this.handles) mesh.removeFromParent();
    this.handles = this._handleIndices().map((index) => {
      const point = this.route.points[index];
      const mesh = new THREE.Mesh(
        this._handleGeometry,
        index === this.activeHandle ? this._activeHandleMaterial : this._handleMaterial,
      );
      mesh.position.set(point[0], point[1], point[2]);
      mesh.renderOrder = 10001;
      mesh.userData.editorHelper = true;
      mesh.userData.pointIndex = index;
      this.group.add(mesh);
      return mesh;
    });
  }

  _setActiveHandle(index) {
    this.activeHandle = index;
    for (const mesh of this.handles) {
      mesh.material = mesh.userData.pointIndex === index ? this._activeHandleMaterial : this._handleMaterial;
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._deactivate();
    this._handleGeometry.dispose();
    this._handleMaterial.dispose();
    this._activeHandleMaterial.dispose();
    window.removeEventListener('pointerdown', this._onPointerDown, { capture: true });
    window.removeEventListener('pointermove', this._onPointerMove, { capture: true });
    window.removeEventListener('pointerup', this._onPointerUp, { capture: true });
    window.removeEventListener('dblclick', this._onDblClick, { capture: true });
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
  }
}
