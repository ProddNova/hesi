import * as THREE from 'three';

const MAX_SEGMENTS = 90000;

/**
 * Optional debug visualisation of the world's analytic collision walls.
 * Built lazily from HighwayMap.wallSegments; never touches production state
 * beyond reading the segment list. Editor helper only.
 */
export class CollisionOverlay {
  constructor({ viewport }) {
    this.viewport = viewport;
    this.object = null;
  }

  get available() { return true; }

  _build(adapter) {
    const segments = (adapter?.map?.wallSegments || []).slice(0, MAX_SEGMENTS);
    if (!segments.length) return false;
    const positions = new Float32Array(segments.length * 3 * 2 * 3);
    let offset = 0;
    const write = (a, b) => {
      positions[offset++] = a.x; positions[offset++] = a.y; positions[offset++] = a.z;
      positions[offset++] = b.x; positions[offset++] = b.y; positions[offset++] = b.z;
    };
    for (const segment of segments) {
      const height = Number(segment.height) || 1;
      const topStart = { x: segment.start.x, y: segment.start.y + height, z: segment.start.z };
      const topEnd = { x: segment.end.x, y: segment.end.y + height, z: segment.end.z };
      write(segment.start, segment.end);
      write(topStart, topEnd);
      write(segment.start, topStart);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({ color: 0x59ffa0, transparent: true, opacity: 0.9 });
    const lines = new THREE.LineSegments(geometry, material);
    lines.name = 'Debug collision walls';
    lines.userData.editorHelper = true;
    lines.visible = false;
    lines.renderOrder = 5;
    this.object = lines;
    this.viewport.scene.add(this.object);
    return true;
  }

  setVisible(visible, adapter) {
    if (visible && !this.object && !this._build(adapter)) return false;
    if (this.object) this.object.visible = Boolean(visible);
    return true;
  }

  get visible() { return Boolean(this.object?.visible); }

  dispose() {
    if (!this.object) return;
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.object = null;
  }
}
