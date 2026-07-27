import * as THREE from 'three';
import {
  BARRIER_STYLES,
  DEFAULT_BARRIER_STYLE_ID,
  flattenBarrierSpans,
} from '/js/road-barrier-styles.js';

/**
 * Authoring overlay for lateral barrier spans.
 *
 * Barrier geometry is baked into merged chunk buckets while the world is
 * generated, so an unsaved span cannot repaint the real wall without a full
 * world rebuild. This draws the AUTHORED intent instead: for the selected
 * road, a coloured ladder standing at each edge — one rung per surface frame,
 * at the style's own height — so extent, side and height are all visible while
 * the numbers are being typed. Editor helper only; never leaves the editor.
 */

// One colour per style, so a mixed road reads at a glance.
const STYLE_COLORS = {
  parapet: 0x5b6672,
  shutokoTall: 0x37e57f,
  meshScreen: 0x49c9ff,
  soundWall: 0xffb347,
  jersey: 0xd782ff,
  guardrail: 0xffe66d,
  none: 0xff5b6e,
};

const MAX_FRAMES = 6000;

export class BarrierOverlay {
  constructor({ viewport }) {
    this.viewport = viewport;
    this.object = null;
    this.enabled = true;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.object) this.object.visible = this.enabled;
  }

  /** Redraw for `routeId` against `document`; pass a falsy route to clear. */
  update(map, document, routeId) {
    this._clear();
    if (!map || !routeId) return;
    const route = map.routes?.get?.(routeId);
    const frames = route?.surfaceFrames;
    if (!frames?.length) return;

    const flattened = flattenBarrierSpans(document, routeId, route.length ?? Infinity);
    if (!flattened[1].length && !flattened[-1].length) return;

    const step = Math.max(1, Math.ceil(frames.length / MAX_FRAMES));
    const positions = [];
    const colors = [];
    const color = new THREE.Color();
    const push = (a, b, hex) => {
      color.setHex(hex);
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    };

    for (const side of [1, -1]) {
      const painted = flattened[side];
      if (!painted.length) continue;
      let previousTop = null;
      let previousStyleId = null;
      for (let index = 0; index < frames.length; index += step) {
        const frame = frames[index];
        const span = painted.find((entry) => frame.distance >= entry.start && frame.distance < entry.end);
        const styleId = span?.style || null;
        if (!styleId || styleId === DEFAULT_BARRIER_STYLE_ID) { previousTop = null; previousStyleId = null; continue; }
        const style = BARRIER_STYLES[styleId];
        const height = Math.max(0.35, (style?.approximateHeight || 1) * (span.heightScale ?? 1));
        const hex = STYLE_COLORS[styleId] ?? 0xffffff;
        const base = map._deckPoint(frame, map._surfaceEdgeLateral(frame, side, 0.12), 0.05);
        const top = base.clone();
        top.y += height;
        push(base, top, hex);
        if (previousTop && previousStyleId === styleId) push(previousTop, top, hex);
        previousTop = top;
        previousStyleId = styleId;
      }
    }
    if (!positions.length) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const lines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95, depthTest: false,
    }));
    lines.name = 'Barrier span overlay';
    lines.userData.editorHelper = true;
    lines.renderOrder = 6;
    lines.visible = this.enabled;
    this.object = lines;
    this.viewport.scene.add(lines);
  }

  _clear() {
    if (!this.object) return;
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.object.material.dispose();
    this.object = null;
  }

  dispose() { this._clear(); }
}

export { STYLE_COLORS };
