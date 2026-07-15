/**
 * Canvas renderer for the road editor map.
 *
 * All heavy geometry is cached as Path2D in WORLD coordinates and drawn via
 * a single canvas transform, so pan/zoom never rebuilds anything and the
 * full network stays fluid without per-point DOM elements.
 */
import { cumLengths, polylineAt, crSample, curvature, bbox, slicePolyline } from './geometry.mjs';

export const COLORS = {
  bg: '#0c0e12',
  bodyMain: '#222936',
  bodyRamp: '#1d232e',
  bodyEdge: '#39455a',
  raw: '#67707f',
  rawDot: '#98a2b3',
  current: '#e5983c',
  preview: '#3ddc97',
  previewDim: '#2a9d70',
  zone: 'rgba(168, 85, 247, 0.4)',
  zoneCore: 'rgba(168, 85, 247, 0.8)',
  anchor: '#5cc8ff',
  junction: '#8fd3fe',
  pa: '#7ee0b8',
  handle: '#ffd23e',
  handleSel: '#ffffff',
  handleOff: '#8a8f98',
  handleGhost: 'rgba(255, 210, 62, 0.35)',
  section: '#ff7edb',
  warn: '#f59e0b',
  error: '#ef4444',
  text: '#d7dce4',
  dim: '#9aa2af',
};

const KAPPA_GAIN = 600; // |κ|·gain → heat intensity (matches debug viewer)

export class MapRenderer {
  /**
   * @param {HTMLCanvasElement} canvas main map canvas
   * @param {HTMLCanvasElement} minimap overview canvas
   * @param {object} ui shared mutable UI state owned by the app:
   *   view {cx,cz,scale}, layers {...}, hidden:Set, isolateId, selectedId,
   *   hoverRouteId, previews:Map(id→pts), handles:[…], handleSel:Set,
   *   section {routeId,a,b}, markers:[{x,z,severity}]
   */
  constructor(canvas, minimap, ui) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.mctx = minimap ? minimap.getContext('2d') : null;
    this.ui = ui;
    this.routes = new Map();
    this.edges = [];
    this.junctions = [];
    this.serviceAreas = [];
    this.netBBox = { x0: -1000, z0: -1000, x1: 1000, z1: 1000 };
    this.curvCache = new Map(); // id → { samples, kap, srcKey }
    this.miniCache = null;
    this.dpr = 1;
  }

  setNetwork({ data, smoothed, zones }) {
    this.routes.clear();
    this.curvCache.clear();
    this.miniCache = null;
    const smoothById = new Map(smoothed.routes.map((r) => [r.id, r]));
    for (const r of data.routes) {
      const sm = smoothById.get(r.id) || { points: r.points, length: r.length };
      const rawPath = buildPath(r.points, !!r.closed);
      const smoothPath = buildPath(sm.points, !!r.closed);
      this.routes.set(r.id, {
        id: r.id,
        data: r,
        raw: r.points,
        rawCum: cumLengths(r.points, !!r.closed),
        smooth: sm.points,
        smoothCum: cumLengths(sm.points, !!r.closed),
        smoothLength: sm.length,
        closed: !!r.closed,
        kind: r.kind,
        halfWidth: (r.lanes || (r.kind === 'ramp' ? 1 : 2)) * 3.5 * 0.5 + (r.kind === 'ramp' || r.kind === 'service' ? 0.95 : 2.5),
        bbox: bbox(r.points),
        rawPath,
        smoothPath,
        previewPath: null,
        zones: zones[r.id] || [],
      });
    }
    this.edges = data.edges || [];
    this.junctions = data.junctions || [];
    this.serviceAreas = data.serviceAreas || [];
    const bbs = [...this.routes.values()].map((r) => r.bbox);
    this.netBBox = {
      x0: Math.min(...bbs.map((b) => b.x0)),
      z0: Math.min(...bbs.map((b) => b.z0)),
      x1: Math.max(...bbs.map((b) => b.x1)),
      z1: Math.max(...bbs.map((b) => b.z1)),
    };
  }

  /** Set/replace the edited preview polyline for a route (null clears). */
  setPreview(routeId, pts) {
    const r = this.routes.get(routeId);
    if (!r) return;
    if (pts) {
      this.ui.previews.set(routeId, pts);
      r.previewPath = buildPath(pts, r.closed);
    } else {
      this.ui.previews.delete(routeId);
      r.previewPath = null;
    }
    this.curvCache.delete(routeId);
  }

  // ------------------------------------------------------------- transforms
  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = this.cv.clientWidth; const h = this.cv.clientHeight;
    if (this.cv.width !== Math.round(w * this.dpr)) this.cv.width = Math.round(w * this.dpr);
    if (this.cv.height !== Math.round(h * this.dpr)) this.cv.height = Math.round(h * this.dpr);
  }

  worldToScreen(x, z) {
    const { cx, cz, scale } = this.ui.view;
    return [
      (x - cx) * scale + this.cv.clientWidth / 2,
      (z - cz) * scale + this.cv.clientHeight / 2,
    ];
  }

  screenToWorld(px, py) {
    const { cx, cz, scale } = this.ui.view;
    return [
      (px - this.cv.clientWidth / 2) / scale + cx,
      (py - this.cv.clientHeight / 2) / scale + cz,
    ];
  }

  fitBounds(bb, pad = 60) {
    const w = this.cv.clientWidth; const h = this.cv.clientHeight;
    this.ui.view.cx = (bb.x0 + bb.x1) / 2;
    this.ui.view.cz = (bb.z0 + bb.z1) / 2;
    this.ui.view.scale = Math.min(
      w / Math.max(1, bb.x1 - bb.x0 + pad * 2),
      h / Math.max(1, bb.z1 - bb.z0 + pad * 2),
    );
  }

  fitAll() { this.fitBounds(this.netBBox, 300); }

  fitRoute(id) {
    const r = this.routes.get(id);
    if (r) this.fitBounds(r.bbox, 80);
  }

  visibleBounds() {
    const [x0, z0] = this.screenToWorld(0, 0);
    const [x1, z1] = this.screenToWorld(this.cv.clientWidth, this.cv.clientHeight);
    return { x0, z0, x1, z1 };
  }

  // -------------------------------------------------------------- hit tests
  /** Nearest visible displayed centreline within `px` pixels of (mx,my). */
  hitTestRoute(mx, my, px = 9) {
    const [wx, wz] = this.screenToWorld(mx, my);
    const maxD = px / this.ui.view.scale;
    let best = null;
    for (const r of this.routes.values()) {
      if (this.ui.hidden.has(r.id)) continue;
      if (this.ui.isolateId && this.ui.isolateId !== r.id) continue;
      const bb = r.bbox;
      if (wx < bb.x0 - maxD - 40 || wx > bb.x1 + maxD + 40 || wz < bb.z0 - maxD - 40 || wz > bb.z1 + maxD + 40) continue;
      const pts = this.displayPts(r.id);
      const cum = this.ui.previews.has(r.id) ? cumLengths(pts, r.closed) : this.smoothCumOf(r);
      const segs = r.closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segs; i += 1) {
        const a = pts[i]; const b = pts[(i + 1) % pts.length];
        const dx = b[0] - a[0]; const dz = b[2] - a[2];
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-12) continue;
        let f = ((wx - a[0]) * dx + (wz - a[2]) * dz) / len2;
        f = Math.max(0, Math.min(1, f));
        const qx = a[0] + f * dx; const qz = a[2] + f * dz;
        const d = Math.hypot(wx - qx, wz - qz);
        if (d < maxD && (!best || d < best.d)) {
          best = { id: r.id, d, s: cum[i] + Math.sqrt(len2) * f, x: qx, z: qz };
        }
      }
    }
    return best;
  }

  displayPts(id) {
    const r = this.routes.get(id);
    return this.ui.previews.get(id) || r.smooth;
  }

  smoothCumOf(r) { return r.smoothCum; }

  // ------------------------------------------------------------------ draw
  draw() {
    this.resize();
    const { ctx } = this;
    const { view, layers } = this.ui;
    const W = this.cv.clientWidth; const H = this.cv.clientHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const vb = this.visibleBounds();
    const margin = 60 / view.scale;
    const inView = (r) => !(r.bbox.x1 < vb.x0 - margin || r.bbox.x0 > vb.x1 + margin
      || r.bbox.z1 < vb.z0 - margin || r.bbox.z0 > vb.z1 + margin);
    const alphaOf = (r) => {
      if (this.ui.isolateId && this.ui.isolateId !== r.id) return 0.13;
      if (this.ui.selectedId && this.ui.selectedId !== r.id) return 0.55;
      return 1;
    };
    const worldTransform = () => {
      ctx.setTransform(
        this.dpr * view.scale, 0, 0, this.dpr * view.scale,
        this.dpr * (W / 2 - view.cx * view.scale),
        this.dpr * (H / 2 - view.cz * view.scale),
      );
    };
    const screenTransform = () => ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const visible = [...this.routes.values()].filter((r) => !this.ui.hidden.has(r.id) && inView(r));

    // 1. road bodies at true width
    if (layers.body) {
      worldTransform();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const r of visible) {
        const path = r.previewPath || r.smoothPath;
        // edge silhouette: slightly wider stroke under the body
        ctx.globalAlpha = alphaOf(r) * 0.7;
        ctx.strokeStyle = COLORS.bodyEdge;
        ctx.lineWidth = r.halfWidth * 2 + Math.max(0.35, 1.1 / view.scale);
        ctx.stroke(path);
        ctx.globalAlpha = alphaOf(r) * 0.95;
        ctx.strokeStyle = r.kind === 'ramp' ? COLORS.bodyRamp : COLORS.bodyMain;
        ctx.lineWidth = r.halfWidth * 2;
        ctx.stroke(path);
      }
      ctx.globalAlpha = 1;
    }

    // 2. protected zones (selected route always; all when layer on)
    if (layers.zones) {
      worldTransform();
      for (const r of visible) {
        if (!r.zones.length) continue;
        const emph = r.id === this.ui.selectedId;
        if (!emph && view.scale < 0.06) continue;
        ctx.globalAlpha = alphaOf(r);
        ctx.strokeStyle = emph ? COLORS.zoneCore : COLORS.zone;
        ctx.lineWidth = emph ? Math.max(r.halfWidth * 2 + 2, 8 / view.scale) : r.halfWidth * 2 + 2;
        ctx.lineCap = 'butt';
        for (const z of r.zones) {
          const seg = slicePolyline(r.raw, r.rawCum, Math.max(0, z.s0), Math.min(r.rawCum[r.rawCum.length - 1], z.s1));
          strokePolyline(ctx, seg);
        }
      }
      ctx.globalAlpha = 1;
    }

    // 3. raw OSM polyline + vertex dots
    if (layers.raw) {
      worldTransform();
      for (const r of visible) {
        ctx.globalAlpha = alphaOf(r) * 0.85;
        ctx.strokeStyle = COLORS.raw;
        ctx.lineWidth = Math.max(0.35, 1.1 / view.scale);
        ctx.stroke(r.rawPath);
      }
      if (view.scale > 1.4) {
        screenTransform();
        ctx.fillStyle = COLORS.rawDot;
        for (const r of visible) {
          ctx.globalAlpha = alphaOf(r);
          for (const p of r.raw) {
            const [sx, sy] = this.worldToScreen(p[0], p[2]);
            if (sx < -10 || sy < -10 || sx > W + 10 || sy > H + 10) continue;
            ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;
    }

    // 4. current processed centreline
    if (layers.current) {
      worldTransform();
      for (const r of visible) {
        ctx.globalAlpha = alphaOf(r) * (this.ui.previews.has(r.id) ? 0.65 : 1);
        ctx.strokeStyle = COLORS.current;
        ctx.lineWidth = Math.max(0.5, 1.7 / view.scale);
        ctx.stroke(r.smoothPath);
      }
      ctx.globalAlpha = 1;
    }

    // 5. edited preview centreline
    if (layers.preview) {
      worldTransform();
      for (const r of visible) {
        if (!r.previewPath) continue;
        ctx.globalAlpha = alphaOf(r);
        ctx.strokeStyle = r.id === this.ui.selectedId ? COLORS.preview : COLORS.previewDim;
        ctx.lineWidth = Math.max(0.6, 2.1 / view.scale);
        ctx.stroke(r.previewPath);
      }
      ctx.globalAlpha = 1;
    }

    // 6. curvature heatmap (displayed line)
    if (layers.curvature) {
      screenTransform();
      for (const r of visible) {
        if (view.scale < 0.09 && r.id !== this.ui.selectedId) continue;
        const { samples, kap } = this.curvatureOf(r.id);
        const skip = Math.max(1, Math.round(6 / (3 * view.scale)));
        ctx.globalAlpha = alphaOf(r);
        for (let i = 0; i < samples.length; i += skip) {
          const k = kap[i];
          const mag = Math.min(1, Math.abs(k) * KAPPA_GAIN);
          if (mag < 0.045) continue;
          const [sx, sy] = this.worldToScreen(samples[i][0], samples[i][2]);
          if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
          ctx.fillStyle = k > 0 ? `rgba(255,80,80,${(0.16 + 0.55 * mag).toFixed(2)})` : `rgba(90,120,255,${(0.16 + 0.55 * mag).toFixed(2)})`;
          ctx.beginPath(); ctx.arc(sx, sy, 2 + 6 * mag, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // 7. direction arrows
    if (layers.arrows && view.scale > 0.03) {
      screenTransform();
      const spacing = Math.max(36, Math.min(900, 110 / view.scale));
      for (const r of visible) {
        ctx.globalAlpha = alphaOf(r) * 0.9;
        ctx.strokeStyle = this.ui.previews.has(r.id) ? COLORS.preview : COLORS.dim;
        ctx.lineWidth = 1.4;
        const pts = this.displayPts(r.id);
        const cum = this.ui.previews.has(r.id) ? cumLengths(pts, r.closed) : r.smoothCum;
        const total = cum[cum.length - 1];
        for (let s = spacing * 0.5; s < total; s += spacing) {
          const p = polylineAt(pts, cum, r.closed, s);
          const q = polylineAt(pts, cum, r.closed, Math.min(total, s + 4));
          const [sx, sy] = this.worldToScreen(p[0], p[2]);
          if (sx < -12 || sy < -12 || sx > W + 12 || sy > H + 12) continue;
          const ang = Math.atan2(q[2] - p[2], q[0] - p[0]);
          drawChevron(ctx, sx, sy, ang, 5);
        }
      }
      ctx.globalAlpha = 1;
    }

    // 8. connections / junctions / PA
    if (layers.anchors) {
      screenTransform();
      if (view.scale > 0.045) {
        ctx.fillStyle = COLORS.anchor;
        for (const e of this.edges) {
          const [sx, sy] = this.worldToScreen(e.point[0], e.point[1]);
          if (sx < -8 || sy < -8 || sx > W + 8 || sy > H + 8) continue;
          ctx.globalAlpha = 0.85;
          ctx.beginPath(); ctx.arc(sx, sy, view.scale > 0.4 ? 4 : 2.6, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      for (const j of this.junctions) {
        const [sx, sy] = this.worldToScreen(j.x, j.z);
        if (sx < -60 || sy < -30 || sx > W + 60 || sy > H + 30) continue;
        ctx.fillStyle = COLORS.junction;
        drawDiamond(ctx, sx, sy, 5);
        if (view.scale > 0.075) {
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.fillStyle = COLORS.text;
          ctx.fillText(j.name || j.id, sx + 8, sy + 4);
        }
      }
      for (const sa of this.serviceAreas) {
        const [sx, sy] = this.worldToScreen(sa.x, sa.z);
        if (sx < -40 || sy < -20 || sx > W + 40 || sy > H + 20) continue;
        ctx.fillStyle = COLORS.pa;
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('🅿', sx, sy + 4);
        if (view.scale > 0.075) {
          ctx.fillStyle = COLORS.dim;
          ctx.font = '10px system-ui, sans-serif';
          ctx.fillText(sa.name, sx, sy + 16);
        }
      }
    }

    // 9. section markers
    const sec = this.ui.section;
    if (sec && sec.routeId && this.routes.has(sec.routeId)) {
      const r = this.routes.get(sec.routeId);
      screenTransform();
      for (const [key, label] of [['a', 'A'], ['b', 'B']]) {
        if (sec[key] == null) continue;
        const p = polylineAt(r.raw, r.rawCum, r.closed, sec[key]);
        const [sx, sy] = this.worldToScreen(p[0], p[2]);
        ctx.fillStyle = COLORS.section;
        ctx.beginPath(); ctx.arc(sx, sy, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#1a0f18';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(label, sx, sy + 3.5);
      }
      if (sec.a != null && sec.b != null) {
        worldTransform();
        ctx.strokeStyle = COLORS.section;
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = Math.max(1, 4 / view.scale);
        strokePolyline(ctx, slicePolyline(r.raw, r.rawCum, sec.a, sec.b));
        ctx.globalAlpha = 1;
      }
    }

    // 10. handles (screen-space)
    if (layers.handles && this.ui.handles.length) {
      screenTransform();
      for (let i = 0; i < this.ui.handles.length; i += 1) {
        const h = this.ui.handles[i];
        const sel = this.ui.handleSel.has(i);
        const [sx, sy] = this.worldToScreen(h.x, h.z);
        if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) continue;
        // influence ring
        if (h.influence > 0 && (sel || this.ui.handles.length < 40)) {
          ctx.strokeStyle = COLORS.handleGhost;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(sx, sy, h.influence * view.scale, 0, Math.PI * 2);
          ctx.stroke();
        }
        // original position ghost + leash
        if (h.ox !== undefined && (h.ox !== h.x || h.oz !== h.z)) {
          const [gx, gy] = this.worldToScreen(h.ox, h.oz);
          ctx.strokeStyle = COLORS.handleGhost;
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(gx, gy); ctx.lineTo(sx, sy); ctx.stroke();
          ctx.beginPath(); ctx.arc(gx, gy, 3, 0, Math.PI * 2); ctx.stroke();
        }
        const color = !h.enabled ? COLORS.handleOff
          : h.kind === 'pin' ? COLORS.zoneCore
            : h.kind === 'smooth' ? COLORS.anchor
              : sel ? COLORS.handleSel : COLORS.handle;
        ctx.fillStyle = color;
        ctx.strokeStyle = '#10131a';
        ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(sx, sy, sel ? 7 : 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (h.locked) {
          ctx.font = '9px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#10131a';
          ctx.fillText('🔒', sx, sy + 3);
        }
      }
    }

    // 11. finding markers
    if (this.ui.markers && this.ui.markers.length) {
      screenTransform();
      for (const m of this.ui.markers) {
        if (m.x === undefined) continue;
        const [sx, sy] = this.worldToScreen(m.x, m.z);
        if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
        ctx.strokeStyle = m.severity === 'error' ? COLORS.error : COLORS.warn;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, 10, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = ctx.strokeStyle;
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(m.severity === 'error' ? '✕' : '!', sx, sy + 4);
      }
    }

    // 12. scale bar
    screenTransform();
    const target = 120 / view.scale;
    const metres = 10 ** Math.floor(Math.log10(target));
    const nice = target / metres >= 5 ? metres * 5 : target / metres >= 2 ? metres * 2 : metres;
    const px = nice * view.scale;
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W - 30 - px, H - 22);
    ctx.lineTo(W - 30, H - 22);
    ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, W - 30, H - 30);

    this.drawMinimap();
  }

  curvatureOf(id) {
    const pts = this.displayPts(id);
    const key = this.ui.previews.has(id) ? `p${pts.length}` : 's';
    let c = this.curvCache.get(id);
    if (!c || c.srcKey !== key) {
      const r = this.routes.get(id);
      const samples = crSample(pts, r.closed, 3);
      c = { samples, kap: curvature(samples, 4), srcKey: key };
      this.curvCache.set(id, c);
    }
    return c;
  }

  drawMinimap() {
    if (!this.mctx) return;
    const mw = this.mini.clientWidth; const mh = this.mini.clientHeight;
    const dpr = this.dpr;
    if (this.mini.width !== mw * dpr) { this.mini.width = mw * dpr; this.mini.height = mh * dpr; this.miniCache = null; }
    const bb = this.netBBox;
    const pad = 500;
    const sc = Math.min(mw / (bb.x1 - bb.x0 + pad * 2), mh / (bb.z1 - bb.z0 + pad * 2));
    const ox = mw / 2 - ((bb.x0 + bb.x1) / 2) * sc;
    const oz = mh / 2 - ((bb.z0 + bb.z1) / 2) * sc;
    if (!this.miniCache) {
      const off = document.createElement('canvas');
      off.width = mw * dpr; off.height = mh * dpr;
      const c = off.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = '#11141a';
      c.fillRect(0, 0, mw, mh);
      c.lineWidth = 1;
      for (const r of this.routes.values()) {
        c.strokeStyle = r.kind === 'ramp' ? '#3b4557' : '#5c6a82';
        c.beginPath();
        for (let i = 0; i < r.smooth.length; i += 3) {
          const p = r.smooth[i];
          const x = p[0] * sc + ox; const y = p[2] * sc + oz;
          if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.stroke();
      }
      this.miniCache = { off, sc, ox, oz };
    }
    const m = this.mctx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.drawImage(this.miniCache.off, 0, 0);
    // viewport rectangle
    const vb = this.visibleBounds();
    m.setTransform(dpr, 0, 0, dpr, 0, 0);
    m.strokeStyle = '#3ddc97';
    m.lineWidth = 1.2;
    m.strokeRect(
      vb.x0 * this.miniCache.sc + this.miniCache.ox,
      vb.z0 * this.miniCache.sc + this.miniCache.oz,
      (vb.x1 - vb.x0) * this.miniCache.sc,
      (vb.z1 - vb.z0) * this.miniCache.sc,
    );
    // selected route highlight
    if (this.ui.selectedId && this.routes.has(this.ui.selectedId)) {
      const r = this.routes.get(this.ui.selectedId);
      m.strokeStyle = '#e5983c';
      m.lineWidth = 1.6;
      m.beginPath();
      for (let i = 0; i < r.smooth.length; i += 3) {
        const p = r.smooth[i];
        const x = p[0] * this.miniCache.sc + this.miniCache.ox;
        const y = p[2] * this.miniCache.sc + this.miniCache.oz;
        if (i === 0) m.moveTo(x, y); else m.lineTo(x, y);
      }
      m.stroke();
    }
  }

  /** Map a minimap click to world coordinates (null outside cache). */
  minimapToWorld(mx, my) {
    if (!this.miniCache) return null;
    return [(mx - this.miniCache.ox) / this.miniCache.sc, (my - this.miniCache.oz) / this.miniCache.sc];
  }
}

function buildPath(pts, closed) {
  const p = new Path2D();
  for (let i = 0; i < pts.length; i += 1) {
    if (i === 0) p.moveTo(pts[i][0], pts[i][2]);
    else p.lineTo(pts[i][0], pts[i][2]);
  }
  if (closed) p.closePath();
  return p;
}

function strokePolyline(ctx, pts) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i += 1) {
    if (i === 0) ctx.moveTo(pts[i][0], pts[i][2]);
    else ctx.lineTo(pts[i][0], pts[i][2]);
  }
  ctx.stroke();
}

function drawChevron(ctx, x, y, ang, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(-size * 0.6, -size);
  ctx.lineTo(size * 0.6, 0);
  ctx.lineTo(-size * 0.6, size);
  ctx.stroke();
  ctx.restore();
}

function drawDiamond(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  ctx.fill();
}
