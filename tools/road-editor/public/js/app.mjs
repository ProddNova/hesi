/**
 * Shutoko road editor — application bootstrap and UI wiring.
 * Interfaccia in italiano; vedi ROAD_EDITOR.md per la guida completa.
 */
import { api } from './api.mjs';
import { MapRenderer, COLORS } from './render.mjs';
import { cumLengths, polylineAt, projectToPolyline, crSample, curvature, bbox } from './geometry.mjs';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ shared state
const ui = {
  view: { cx: 0, cz: 0, scale: 0.04 },
  layers: {
    body: true, raw: true, current: true, preview: true,
    curvature: false, arrows: true, zones: true, anchors: true, handles: true,
  },
  hidden: new Set(),
  isolateId: null,
  selectedId: null,
  previews: new Map(),
  handles: [],
  handleSel: new Set(),
  section: { routeId: null, a: null, b: null },
  markers: [],
};

const app = {
  data: null,          // raw dataset (data/routes.json)
  smoothed: null,      // processed dataset (routes-smoothed)
  zones: {},           // routeId → [{s0,s1,why}]
  quality: null,       // routeId → base curvature quality
  meta: null,
  connCount: new Map(),
  filter: 'all',
  search: '',
  findingsByRoute: new Map(), // routeId → findings[]
  warnCursor: -1,
  renderer: null,
  needsDraw: true,
};
window.__app = app; // console debugging aid
window.__ui = ui;
import('./geometry.mjs').then((g) => { window.__geom = g; });

const LAYER_DEFS = [
  ['body', 'Corpo strada', '#8ea3c4'],
  ['raw', 'Linea OSM grezza', '#98a2b3'],
  ['current', 'Strada attuale', COLORS.current],
  ['preview', 'Anteprima modificata', COLORS.preview],
  ['curvature', 'Curvatura', '#f07878'],
  ['arrows', 'Direzione', '#9aa2af'],
  ['zones', 'Zone protette', '#c084fc'],
  ['anchors', 'Connessioni', COLORS.anchor],
  ['handles', 'Maniglie', COLORS.handle],
];

// ------------------------------------------------------------------- boot
async function boot() {
  setState('carico la rete…', true);
  const [net, meta] = await Promise.all([api.network(), api.meta()]);
  app.data = net.data;
  app.smoothed = net.smoothed;
  app.zones = net.zones;
  app.meta = meta;
  for (const e of app.data.edges || []) {
    app.connCount.set(e.from.route, (app.connCount.get(e.from.route) || 0) + 1);
    app.connCount.set(e.to.route, (app.connCount.get(e.to.route) || 0) + 1);
  }

  app.renderer = new MapRenderer($('map'), $('minimap'), ui);
  app.renderer.setNetwork({ data: app.data, smoothed: app.smoothed, zones: app.zones });
  app.renderer.resize();
  app.renderer.fitAll();

  buildLayerChips();
  buildSidebar();
  wireMapEvents();
  wireTopbar();
  wireKeyboard();
  requestAnimationFrame(frame);
  setState('pronto', false);

  // base quality hints arrive lazily (a few seconds server-side)
  api.quality().then((q) => {
    app.quality = q.quality;
    refreshSidebarBadges();
  }).catch(() => {});

  if ($('btnApply')) $('btnApply').disabled = !app.meta.allowApply;
  // race-free boot handshake: late-loading modules check the flag first
  window.__appBooted = true;
  window.dispatchEvent(new CustomEvent('editor:booted'));
}

function frame() {
  if (app.needsDraw) {
    app.needsDraw = false;
    const t0 = performance.now();
    app.renderer.draw();
    const ms = performance.now() - t0;
    $('sbZoom').textContent = `zoom ${ui.view.scale >= 1 ? ui.view.scale.toFixed(1) : ui.view.scale.toFixed(3)} px/m · ${ms.toFixed(0)} ms`;
  }
  requestAnimationFrame(frame);
}
const redraw = () => { app.needsDraw = true; };

// -------------------------------------------------------------- utilities
function setState(text, busy) {
  const el = $('sbState');
  el.textContent = text;
  el.classList.toggle('busy', !!busy);
}

let toastTimer = null;
export function toast(text, kind = '', ms = 3600) {
  const el = $('toast');
  el.textContent = text;
  el.className = kind;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function openModal(title, bodyHtml, footButtons = []) {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  if (typeof bodyHtml === 'string') body.innerHTML = bodyHtml;
  else { body.innerHTML = ''; body.appendChild(bodyHtml); }
  const foot = $('modalFoot');
  foot.innerHTML = '';
  for (const b of footButtons) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (b.primary) btn.className = 'primary';
    if (b.danger) btn.className = 'danger';
    btn.addEventListener('click', () => b.onClick(btn));
    foot.appendChild(btn);
  }
  $('modal').hidden = false;
  return { close: closeModal, body };
}
export function closeModal() { $('modal').hidden = true; }
$('modalClose').addEventListener('click', closeModal);
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

const routeById = (id) => app.data.routes.find((r) => r.id === id);
const smoothById = (id) => app.smoothed.routes.find((r) => r.id === id);
const routeLabel = (r) => (r.name ? `${r.name}` : r.id);
const kindLabel = (k) => (k === 'mainline' ? 'principale' : k === 'ramp' ? 'rampa' : k);

// ------------------------------------------------------------- layer chips
function buildLayerChips() {
  const wrap = $('layerChips');
  wrap.innerHTML = '';
  for (const [key, label, color] of LAYER_DEFS) {
    const chip = document.createElement('span');
    chip.className = `chip${ui.layers[key] ? ' on' : ''}`;
    chip.textContent = label;
    chip.style.setProperty('--chipc', color);
    chip.title = `Mostra/nascondi: ${label}`;
    chip.addEventListener('click', () => {
      ui.layers[key] = !ui.layers[key];
      chip.classList.toggle('on', ui.layers[key]);
      redraw();
    });
    wrap.appendChild(chip);
  }
}

// ---------------------------------------------------------------- sidebar
function routeMatches(r) {
  if (app.filter === 'mainline' && r.kind !== 'mainline') return false;
  if (app.filter === 'ramp' && r.kind !== 'ramp') return false;
  if (app.filter === 'edited' && !isEdited(r.id)) return false;
  if (app.filter === 'warn' && !(app.findingsByRoute.get(r.id) || []).length) return false;
  if (app.search) {
    const q = app.search.toLowerCase();
    const hay = `${r.id} ${r.code || ''} ${r.name || ''} ${r.nameJa || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function isEdited(routeId) {
  return window.__state ? window.__state.hasOps(routeId) : false;
}

function buildSidebar() {
  const list = $('routeList');
  list.innerHTML = '';
  const routes = [...app.data.routes].sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'mainline' ? -1 : 1));
  for (const r of routes) {
    const item = document.createElement('div');
    item.className = 'routeItem';
    item.dataset.id = r.id;
    item.setAttribute('role', 'option');
    item.innerHTML = `
      <div class="rname">${routeLabel(r)}</div>
      <div class="ricons">
        <button class="eye" title="Mostra/nascondi sulla mappa">👁</button>
      </div>
      <div class="rmeta">
        <span class="badge kind-${r.kind}">${kindLabel(r.kind)}</span>
        <span>${r.id}</span>
        <span>${(r.length / 1000).toFixed(1)} km</span>
        <span title="connessioni">⇄ ${app.connCount.get(r.id) || 0}</span>
        <span class="dyn"></span>
      </div>`;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('eye')) return;
      selectRoute(r.id, { fit: true });
    });
    item.querySelector('.eye').addEventListener('click', (e) => {
      e.stopPropagation();
      if (ui.hidden.has(r.id)) ui.hidden.delete(r.id); else ui.hidden.add(r.id);
      e.target.classList.toggle('off', ui.hidden.has(r.id));
      redraw();
    });
    list.appendChild(item);
  }
  applySidebarFilter();
}

function applySidebarFilter() {
  for (const item of $('routeList').children) {
    const r = routeById(item.dataset.id);
    item.style.display = routeMatches(r) ? '' : 'none';
  }
}

function refreshSidebarBadges() {
  for (const item of $('routeList').children) {
    const id = item.dataset.id;
    const dyn = item.querySelector('.dyn');
    const bits = [];
    if (isEdited(id)) bits.push('<span class="badge edited">modificato</span>');
    const f = app.findingsByRoute.get(id) || [];
    const errs = f.filter((x) => x.severity === 'error').length;
    const warns = f.length - errs;
    if (errs) bits.push(`<span class="badge errs">⛔ ${errs}</span>`);
    if (warns) bits.push(`<span class="badge warns">⚠ ${warns}</span>`);
    if (!f.length && app.quality && app.quality[id] && app.quality[id].hints) {
      bits.push(`<span class="badge hints" title="possibili difetti di curvatura nella strada attuale">≈ ${app.quality[id].hints}</span>`);
    }
    dyn.innerHTML = bits.join(' ');
    item.classList.toggle('sel', id === ui.selectedId);
  }
  applySidebarFilter();
}

// --------------------------------------------------------------- selection
export function selectRoute(id, { fit = false } = {}) {
  ui.selectedId = id;
  ui.handleSel.clear();
  if (ui.section.routeId !== id) ui.section = { routeId: id, a: null, b: null };
  if (fit && id) app.renderer.fitRoute(id);
  refreshSidebarBadges();
  renderRouteInfo();
  renderStatsPanel();
  window.dispatchEvent(new CustomEvent('editor:selected', { detail: { id } }));
  $('sbSel').textContent = id ? `selezionato: ${routeLabel(routeById(id))} (${id})` : '';
  redraw();
}

function renderRouteInfo() {
  const wrap = $('routeInfo');
  const id = ui.selectedId;
  if (!id) {
    wrap.innerHTML = '<div class="placeholder">Seleziona un percorso<br>cliccandolo sulla mappa<br>o dall\'elenco a sinistra.</div>';
    $('sectionTools').hidden = true;
    $('statsPanel').hidden = true;
    return;
  }
  const r = routeById(id);
  const sm = smoothById(id);
  const zones = app.zones[id] || [];
  const q = app.quality && app.quality[id];
  wrap.innerHTML = `
    <div class="title">${routeLabel(r)}</div>
    <div class="sub">${r.nameJa || ''} · <span class="badge kind-${r.kind}">${kindLabel(r.kind)}</span> ${r.closed ? '· anello chiuso' : ''} ${r.synthetic ? '· connettore sintetico (non modificabile dal fairing)' : ''}</div>
    <table>
      <tr><td>ID</td><td>${r.id}</td></tr>
      <tr><td>Lunghezza attuale</td><td>${sm ? (sm.length / 1000).toFixed(2) : '—'} km</td></tr>
      <tr><td>Corsie</td><td>${r.lanes || '—'} × 3.5 m</td></tr>
      <tr><td>Punti OSM / processati</td><td>${r.points.length} / ${sm ? sm.points.length : '—'}</td></tr>
      <tr><td>Connessioni</td><td>${app.connCount.get(id) || 0}</td></tr>
      <tr><td>Zone protette</td><td>${zones.length}</td></tr>
      ${q ? `<tr><td>Raggio min. attuale</td><td>${q.minRadius > 1e8 ? '∞' : `${Math.round(q.minRadius)} m`}</td></tr>
      <tr><td>Oscillazioni</td><td>${q.flipsPerKm.toFixed(1)} /km</td></tr>` : ''}
    </table>
    <div class="rowbtns">
      <button id="riFit">⤢ Adatta [F]</button>
      <button id="riIsolate">${ui.isolateId === id ? 'Mostra tutto' : '◎ Isola'}</button>
      <button id="riDeselect">✕ Deseleziona [Esc]</button>
    </div>`;
  $('riFit').addEventListener('click', () => { app.renderer.fitRoute(id); redraw(); });
  $('riIsolate').addEventListener('click', () => {
    ui.isolateId = ui.isolateId === id ? null : id;
    renderRouteInfo();
    redraw();
  });
  $('riDeselect').addEventListener('click', () => selectRoute(null));
  $('sectionTools').hidden = false;
  $('statsPanel').hidden = false;
}

// --------------------------------------------------- curvature mini-graph
function renderStatsPanel() {
  const id = ui.selectedId;
  if (!id) return;
  const cv = $('curvGraph');
  const ctx = cv.getContext('2d');
  const W = cv.width = cv.clientWidth * (window.devicePixelRatio || 1);
  const H = cv.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#10131a';
  ctx.fillRect(0, 0, W, H);
  const r = routeById(id);
  const draw = (pts, color) => {
    if (!pts || pts.length < 8) return null;
    const samples = crSample(pts, !!r.closed, 4);
    const kap = curvature(samples, 4);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < kap.length; i += 1) {
      const x = (i / (kap.length - 1)) * W;
      const y = H / 2 - Math.max(-1, Math.min(1, kap[i] * 600)) * (H / 2 - 4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    let maxK = 0;
    for (const k of kap) maxK = Math.max(maxK, Math.abs(k));
    return { maxK };
  };
  ctx.strokeStyle = '#262c38';
  ctx.beginPath(); ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2); ctx.stroke();
  const base = draw(smoothById(id)?.points, COLORS.current);
  const prev = draw(ui.previews.get(id), COLORS.preview);
  const fmtR = (m) => (m && m.maxK > 1e-9 ? `${Math.round(1 / m.maxK)} m` : '∞');
  $('statsText').textContent = `curvatura lungo il percorso (su: arancio = attuale, verde = anteprima)
raggio min: attuale ${fmtR(base)}${prev ? ` → anteprima ${fmtR(prev)}` : ''}`;
}

// ------------------------------------------------------------- map events
function wireMapEvents() {
  const cv = $('map');
  let drag = null; // {x, y, moved, panning}

  cv.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button };
  });

  window.addEventListener('mousemove', (e) => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
    updateStatusCoords(mx, my);
    if (!drag) return;
    const dx = e.clientX - drag.x; const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag.moved = true;
    ui.view.cx -= dx / ui.view.scale;
    ui.view.cz -= dy / ui.view.scale;
    drag.x = e.clientX; drag.y = e.clientY;
    redraw();
  });

  window.addEventListener('mouseup', (e) => {
    if (!drag) return;
    const wasClick = !drag.moved;
    drag = null;
    if (!wasClick) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
    if (e.target !== cv) return;
    const hit = app.renderer.hitTestRoute(mx, my);
    if (hit) {
      if (hit.id !== ui.selectedId) selectRoute(hit.id);
      window.dispatchEvent(new CustomEvent('editor:routeClick', { detail: { ...hit, mx, my } }));
    } else {
      selectRoute(null);
    }
  });

  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
    const [wx, wz] = app.renderer.screenToWorld(mx, my);
    const f = e.deltaY < 0 ? 1.22 : 1 / 1.22;
    const ns = Math.max(0.006, Math.min(40, ui.view.scale * f));
    // keep the world point under the cursor fixed
    ui.view.cx = wx - (mx - cv.clientWidth / 2) / ns;
    ui.view.cz = wz - (my - cv.clientHeight / 2) / ns;
    ui.view.scale = ns;
    redraw();
  }, { passive: false });

  cv.addEventListener('dblclick', (e) => {
    const rect = cv.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent('editor:dblclick', {
      detail: { mx: e.clientX - rect.left, my: e.clientY - rect.top },
    }));
  });

  // minimap navigation
  const mini = $('minimap');
  let miniDrag = false;
  const miniJump = (e) => {
    const rect = mini.getBoundingClientRect();
    const w = app.renderer.minimapToWorld(e.clientX - rect.left, e.clientY - rect.top);
    if (w) { ui.view.cx = w[0]; ui.view.cz = w[1]; redraw(); }
  };
  mini.addEventListener('mousedown', (e) => { miniDrag = true; miniJump(e); e.stopPropagation(); });
  window.addEventListener('mousemove', (e) => { if (miniDrag) miniJump(e); });
  window.addEventListener('mouseup', () => { miniDrag = false; });

  window.addEventListener('resize', () => { app.renderer.resize(); redraw(); });
}

function updateStatusCoords(mx, my) {
  const [wx, wz] = app.renderer.screenToWorld(mx, my);
  $('sbCoords').textContent = `x ${wx.toFixed(1)} · z ${wz.toFixed(1)}`;
  if (ui.selectedId) {
    const r = app.renderer.routes.get(ui.selectedId);
    if (r) {
      const prj = projectToPolyline(wx, wz, r.raw, r.rawCum, r.closed);
      $('sbStation').textContent = prj.d < 400 ? `progressiva ${prj.s.toFixed(0)} m (dist. ${prj.d.toFixed(1)} m)` : '';
    }
  } else {
    $('sbStation').textContent = '';
  }
}

// ----------------------------------------------------------------- topbar
function wireTopbar() {
  $('btnFitAll').addEventListener('click', () => { app.renderer.fitAll(); redraw(); });
  $('btnFitRoute').addEventListener('click', () => { if (ui.selectedId) { app.renderer.fitRoute(ui.selectedId); redraw(); } });
  $('btnFitSection').addEventListener('click', fitSection);
  $('btnResetView').addEventListener('click', () => { app.renderer.fitAll(); redraw(); });
  $('search').addEventListener('input', (e) => { app.search = e.target.value.trim(); applySidebarFilter(); });
  for (const b of $('filters').children) {
    b.addEventListener('click', () => {
      for (const x of $('filters').children) x.classList.remove('on');
      b.classList.add('on');
      app.filter = b.dataset.f;
      applySidebarFilter();
    });
  }
}

function fitSection() {
  const sec = ui.section;
  if (!sec.routeId || sec.a == null || sec.b == null) { toast('Imposta prima i marcatori A e B sulla sezione.'); return; }
  const r = app.renderer.routes.get(sec.routeId);
  const a = Math.min(sec.a, sec.b); const b = Math.max(sec.a, sec.b);
  const pts = [];
  for (let s = a; s <= b; s += 10) pts.push(polylineAt(r.raw, r.rawCum, r.closed, s));
  app.renderer.fitBounds(bbox(pts), 40);
  redraw();
}

// --------------------------------------------------------------- keyboard
function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    const k = e.key;
    if (k === 'a' || k === 'A') { app.renderer.fitAll(); redraw(); }
    else if (k === 'f' || k === 'F') { if (ui.selectedId) { app.renderer.fitRoute(ui.selectedId); redraw(); } }
    else if (k === 'g' || k === 'G') fitSection();
    else if (k === '0') { app.renderer.fitAll(); redraw(); }
    else if (k === 'Escape') {
      if (!$('modal').hidden) { closeModal(); return; }
      if (ui.isolateId) { ui.isolateId = null; renderRouteInfo(); }
      else selectRoute(null);
      redraw();
    } else if (k === '+' || k === '=') zoomKey(1.25);
    else if (k === '-' || k === '_') zoomKey(1 / 1.25);
    else if (k === 'ArrowLeft') panKey(-60, 0);
    else if (k === 'ArrowRight') panKey(60, 0);
    else if (k === 'ArrowUp') panKey(0, -60);
    else if (k === 'ArrowDown') panKey(0, 60);
    else window.dispatchEvent(new CustomEvent('editor:key', { detail: { key: k, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, ev: e } }));
  });
}
function zoomKey(f) {
  ui.view.scale = Math.max(0.006, Math.min(40, ui.view.scale * f));
  redraw();
}
function panKey(dx, dz) {
  ui.view.cx += dx / ui.view.scale;
  ui.view.cz += dz / ui.view.scale;
  redraw();
}

// ------------------------------------------------------------ shared exports
export { app, ui, redraw, setState, routeById, smoothById, routeLabel, refreshSidebarBadges, renderRouteInfo, renderStatsPanel };

boot().catch((e) => {
  setState('errore di avvio', false);
  toast(`Errore di avvio: ${e.message}`, 'error', 12000);
  console.error(e);
});
