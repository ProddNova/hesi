/**
 * The two instruments the HUD paints on a canvas: the analog dials and the GPS
 * minimap.
 *
 * They live outside js/ui.js for one reason — the HUD editor
 * (tools/hesi-editor → HUD) previews the interface without booting a game, and a
 * preview whose dials are blank cannot be used to choose the colours the dials
 * are painted with. This module has no Three.js and no game state: give it a
 * canvas, a value and a palette and it draws. js/ui.js keeps the HUD wiring and
 * calls in here for the pixels, so there is exactly one dial painter.
 *
 * Colours come from the theme's custom properties rather than from arguments,
 * because a 2D context cannot resolve `var()` the way a declaration can — it has
 * to sample the computed style. The sample is cached against the theme's
 * revision stamp (written by `applyHudTheme`), so a running game reads it once
 * per change instead of once per frame.
 */
import { rgbaFromHex } from './hud-theme.js?v=aa56cc4f53cb';

/**
 * The defaults are what these instruments were painted with before the theme
 * existed; .devtests/hud-theme.test.mjs asserts they still equal the model's
 * defaults, so an unthemed build draws the original gauges.
 */
const INSTRUMENT_COLORS = Object.freeze([
  ['dialFace', '--hud-dial-face', '#0a0f15'],
  ['dialNeedle', '--hud-dial-needle', '#ff2e4d'],
  ['dialTick', '--hud-dial-tick', '#8cffab'],
  ['dialLabel', '--hud-dial-label', '#b6ffcc'],
  ['dialGlow', '--hud-dial-glow', '#5cff8a'],
  ['mapBg', '--hud-map-bg', '#020a06'],
  ['mapRoute', '--hud-map-route', '#35ff85'],
  ['mapRouteAlt', '--hud-map-route-alt', '#1d3f2c'],
  ['mapService', '--hud-map-service', '#3affd2'],
  ['mapGarage', '--hud-map-garage', '#ff4d6d'],
  ['mapPlayer', '--hud-map-player', '#ffffff'],
]);

const cache = new WeakMap();

/** The instrument palette in force on one document. Cheap to call per frame. */
export function instrumentColors(root = typeof document === 'undefined' ? null : document.documentElement) {
  if (!root) return Object.fromEntries(INSTRUMENT_COLORS.map(([key, , fallback]) => [key, fallback]));
  const revision = root.dataset?.hudRevision || '';
  const hit = cache.get(root);
  if (hit && hit.revision === revision) return hit.colors;
  const style = (root.ownerDocument?.defaultView || window).getComputedStyle(root);
  const colors = {};
  for (const [key, property, fallback] of INSTRUMENT_COLORS) {
    colors[key] = style.getPropertyValue(property).trim() || fallback;
  }
  cache.set(root, { revision, colors });
  return colors;
}

/** A gauge's per-canvas state: the cached face bitmap and the eased needle. */
export function createGauge(canvas) {
  return canvas ? { canvas, ctx: canvas.getContext('2d'), face: null, faceKey: '', disp: 0 } : null;
}

/**
 * Draws one dial. The face — ring, redline, ticks, numerals — is an expensive
 * bitmap cached against everything it depends on, INCLUDING the colours: without
 * them in the key a re-themed dial would keep the previous face until the canvas
 * changed size. Only the needle is redrawn per frame.
 *
 * `ease` is false for a still preview, where a needle that creeps toward its
 * value over several frames just looks like a bug.
 */
export function paintDial(gauge, cfg, { colors = instrumentColors(), ease = true, dpr = null } = {}) {
  if (!gauge?.ctx) return;
  const view = gauge.canvas.ownerDocument?.defaultView || window;
  const ratio = dpr ?? Math.min(view.devicePixelRatio || 1, 2);
  const host = gauge.canvas.parentElement;
  const css = Math.max(48, Math.round(Math.min(host?.clientWidth || 120, host?.clientHeight || 120)));
  const px = Math.round(css * ratio);
  if (gauge.canvas.width !== px) { gauge.canvas.width = px; gauge.canvas.height = px; }
  const key = `${px}|${cfg.max}|${cfg.redlineAt || 0}|${colors.dialFace}${colors.dialNeedle}${colors.dialTick}${colors.dialLabel}${colors.dialGlow}`;
  if (gauge.faceKey !== key) { gauge.face = renderDialFace(px, cfg, colors, gauge.canvas.ownerDocument); gauge.faceKey = key; }
  const x = gauge.ctx;
  x.clearRect(0, 0, px, px);
  if (gauge.face) x.drawImage(gauge.face, 0, 0);
  gauge.disp = ease ? (gauge.disp ?? cfg.value) + (cfg.value - (gauge.disp ?? cfg.value)) * .38 : cfg.value;
  const a0 = Math.PI * .75, a1 = Math.PI * 2.25;
  const a = a0 + Math.max(0, Math.min(cfg.max, gauge.disp)) / cfg.max * (a1 - a0);
  x.save(); x.translate(px / 2, px / 2); x.rotate(a);
  x.strokeStyle = colors.dialNeedle; x.lineWidth = px * .021; x.lineCap = 'round';
  x.shadowColor = colors.dialNeedle; x.shadowBlur = px * .04;
  x.beginPath(); x.moveTo(-px * .12, 0); x.lineTo(px * .395, 0); x.stroke();
  x.shadowBlur = 0;
  x.fillStyle = colors.dialFace; x.beginPath(); x.arc(0, 0, px * .052, 0, 7); x.fill();
  x.strokeStyle = colors.dialGlow; x.lineWidth = px * .012; x.stroke();
  x.restore();
}

export function renderDialFace(px, cfg, colors = instrumentColors(), doc = typeof document === 'undefined' ? null : document) {
  const f = doc.createElement('canvas'); f.width = px; f.height = px;
  const x = f.getContext('2d'), c = px / 2;
  const a0 = Math.PI * .75, a1 = Math.PI * 2.25;
  const ang = v => a0 + Math.max(0, Math.min(cfg.max, v)) / cfg.max * (a1 - a0);
  x.fillStyle = colors.dialFace; x.beginPath(); x.arc(c, c, px * .485, 0, 7); x.fill();
  x.strokeStyle = rgbaFromHex(colors.dialGlow, .16); x.lineWidth = px * .008;
  x.beginPath(); x.arc(c, c, px * .44, 0, 7); x.stroke();
  if (cfg.redlineAt) {
    x.strokeStyle = colors.dialNeedle; x.lineWidth = px * .026; x.shadowColor = colors.dialNeedle; x.shadowBlur = px * .025;
    x.beginPath(); x.arc(c, c, px * .415, ang(cfg.redlineAt), a1); x.stroke(); x.shadowBlur = 0;
  }
  for (let v = 0; v <= cfg.max + 1e-6; v += cfg.minorEvery) {
    const major = Math.abs(v / cfg.majorEvery - Math.round(v / cfg.majorEvery)) < 1e-6;
    const a = ang(v), ca = Math.cos(a), sa = Math.sin(a);
    const r1 = px * .425, r2 = major ? px * .355 : px * .385;
    x.strokeStyle = major ? colors.dialTick : rgbaFromHex(colors.dialTick, .4);
    x.lineWidth = major ? px * .013 : px * .007;
    if (major) { x.shadowColor = colors.dialGlow; x.shadowBlur = px * .018; }
    x.beginPath(); x.moveTo(c + ca * r2, c + sa * r2); x.lineTo(c + ca * r1, c + sa * r1); x.stroke();
    x.shadowBlur = 0;
    if (major && v % cfg.labelEvery === 0) {
      const lr = px * .275;
      x.fillStyle = colors.dialLabel; x.font = `${Math.round(px * .082)}px "RoundedTit","Rounded",sans-serif`;
      x.textAlign = 'center'; x.textBaseline = 'middle';
      x.shadowColor = colors.dialGlow; x.shadowBlur = px * .022;
      x.fillText(cfg.fmt(v), c + ca * lr, c + sa * lr);
      x.shadowBlur = 0;
    }
  }
  x.fillStyle = rgbaFromHex(colors.dialTick, .5); x.font = `${Math.round(px * .05)}px "Rounded",sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(cfg.sub, c, c - px * .155);
  return f;
}

/** The tachometer's dial contract for a given redline, and the speedometer's. */
export function tachConfig(redline) {
  const max = Math.max(5, Math.ceil(redline / 1000)) * 1000;
  return { max, redlineAt: redline, majorEvery: 1000, minorEvery: 250, labelEvery: 1000, fmt: v => String(v / 1000), sub: '×1000 RPM' };
}

export function speedConfig() {
  return { max: 280, majorEvery: 20, minorEvery: 10, labelEvery: 40, fmt: v => String(v), sub: 'km/h' };
}

/**
 * Draws the route network, the service markers and the player arrow.
 *
 * `data` is either `{ routes, bounds }` or a bare array of point arrays, which is
 * what both the phone map and the HUD minimap already pass. `large` widens the
 * strokes and adds the service names, for the phone's full-page map.
 */
export function paintMinimap(canvas, { data, player = null, services = [], colors = instrumentColors(), large = false } = {}) {
  if (!canvas || (!data?.routes?.length && !Array.isArray(data))) return false;
  const c = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  c.fillStyle = colors.mapBg; c.fillRect(0, 0, w, h);
  const routes = data.routes || data;
  const all = routes.flatMap(r => r.points || r);
  if (!all.length) return false;
  const xs = all.map(p => p.x), zs = all.map(p => p.z ?? p.y);
  const bounds = data.bounds || { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  const pad = large ? 22 : 12;
  const scale = Math.min((w - pad * 2) / Math.max(1, bounds.maxX - bounds.minX), (h - pad * 2) / Math.max(1, bounds.maxZ - bounds.minZ));
  const tx = x => w / 2 + (x - (bounds.minX + bounds.maxX) / 2) * scale;
  const ty = z => h / 2 - (z - (bounds.minZ + bounds.maxZ) / 2) * scale; // +Z = north = up
  routes.forEach((r, idx) => {
    const pts = r.points || r;
    c.beginPath();
    pts.forEach((p, i) => i ? c.lineTo(tx(p.x), ty(p.z ?? p.y)) : c.moveTo(tx(p.x), ty(p.z ?? p.y)));
    if (r.closed) c.closePath();
    c.strokeStyle = r.color || (idx === 0 ? colors.mapRoute : colors.mapRouteAlt);
    c.lineWidth = large ? 4 : 2; c.stroke();
  });
  services.forEach(s => {
    c.fillStyle = s.garage ? colors.mapGarage : colors.mapService;
    c.fillRect(tx(s.position?.x ?? s.x) - 3, ty(s.position?.z ?? s.z) - 3, 6, 6);
    if (large) { c.fillStyle = '#9fdcb4'; c.font = '10px monospace'; c.fillText(s.name || 'PA', tx(s.position?.x ?? s.x) + 6, ty(s.position?.z ?? s.z) - 5); }
  });
  if (player) {
    const x = tx(player.x), y = ty(player.z);
    // North-up canvas (y = -z): heading 0 (+Z) points straight up, so the
    // up-drawn arrow rotates by the heading directly.
    c.save(); c.translate(x, y); c.rotate(player.heading ?? 0);
    c.fillStyle = colors.mapPlayer;
    c.beginPath(); c.moveTo(0, -7); c.lineTo(5, 5); c.lineTo(0, 2); c.lineTo(-5, 5); c.closePath(); c.fill();
    c.restore();
  }
  return true;
}
