/**
 * Editing controller: handles (maniglie), dragging, live server preview,
 * warnings, section tools, protected-zone locking, undo/redo.
 *
 * Loaded as a second module entry: shares the app.mjs singletons.
 */
import {
  app, ui, redraw, toast, openModal, closeModal,
  refreshSidebarBadges, renderStatsPanel, selectRoute,
} from './app.mjs';
import { api } from './api.mjs';
import { EditorState } from './state.mjs';
import { projectToPolyline, polylineAt, circumcircle } from './geometry.mjs';

const $ = (id) => document.getElementById(id);

export const state = new EditorState({
  storage: typeof localStorage !== 'undefined' ? localStorage : null,
  storageKey: 'roadEditor:draft',
});
window.__state = state;

const DEFAULT_INFLUENCE = 45;
const DEFAULT_WEIGHT = 24;

// ------------------------------------------------------------------ boot
// (guarded: editor:booted may fire while this module is still loading)
let editBooted = false;
async function initEdit() {
  if (editBooted) return;
  editBooted = true;
  try {
    const ov = await api.overrides();
    if (ov.ok) {
      state.load(ov.doc);
    } else {
      state.load(null);
      toast(`⚠ ${ov.error}\nL'editor parte senza override: nulla è stato perso, il file non viene toccato.`, 'error', 12000);
      window.dispatchEvent(new CustomEvent('editor:overridesCorrupt', { detail: ov }));
    }
  } catch (e) {
    state.load(null);
    toast(`Impossibile leggere gli override: ${e.message}`, 'error');
  }
  state.onChange = onDocChange;
  wireEditEvents();
  window.__stateReady = true;
  window.dispatchEvent(new CustomEvent('editor:stateReady'));
  onDocChange();
  syncPreviews();
}
if (window.__appBooted) initEdit();
else window.addEventListener('editor:booted', initEdit, { once: true });

// ------------------------------------------------------- doc change → UI
function onDocChange() {
  $('btnUndo').disabled = !state.canUndo;
  $('btnRedo').disabled = !state.canRedo;
  $('dirtyDot').hidden = !state.dirty;
  $('sbDraft').textContent = state.dirty ? 'modifiche non salvate' : '';
  rebuildHandles();
  refreshSidebarBadges();
  redraw();
}

// --------------------------------------------------------------- handles
function zoneWhy(routeId, s) {
  for (const z of app.zones[routeId] || []) {
    if (s >= z.s0 && s <= z.s1) return z.why;
  }
  return null;
}

function anchorDisplayPos(r, anchor) {
  if (anchor && Array.isArray(anchor.point)) return [anchor.point[0], 0, anchor.point[1]];
  if (anchor && Number.isFinite(anchor.station)) return polylineAt(r.raw, r.rawCum, r.closed, anchor.station);
  return [0, 0, 0];
}

export function rebuildHandles() {
  ui.handles = [];
  const id = ui.selectedId;
  if (!id || !app.renderer) { ui.handleSel.clear(); renderHandlePanel(); return; }
  const r = app.renderer.routes.get(id);
  for (const op of state.opsFor(id)) {
    let x; let z; let ox; let oz;
    if (op.op === 'move') {
      [x, z] = op.to;
      if (op.anchor && Array.isArray(op.anchor.point)) { ox = op.anchor.point[0]; oz = op.anchor.point[1]; }
    } else if (op.op === 'insert') {
      x = op.point[0]; z = op.point[op.point.length - 1];
    } else {
      const p = anchorDisplayPos(r, op.anchor);
      x = p[0]; z = p[2];
    }
    const s = op.anchor && Number.isFinite(op.anchor.station) ? op.anchor.station : null;
    ui.handles.push({
      opId: op.id,
      kind: op.op,
      x, z, ox, oz,
      influence: op.op === 'move' ? (op.influence ?? DEFAULT_INFLUENCE)
        : op.op === 'smooth' ? (op.span ?? 60)
          : op.op === 'pin' ? (op.span ?? 30) : 0,
      enabled: op.enabled !== false,
      locked: s !== null && !!zoneWhy(id, s),
      station: s,
    });
  }
  // prune stale selection indexes
  for (const i of [...ui.handleSel]) if (i >= ui.handles.length) ui.handleSel.delete(i);
  renderHandlePanel();
}

function hitTestHandle(mx, my, px = 11) {
  let best = -1; let bestD = px;
  for (let i = 0; i < ui.handles.length; i += 1) {
    const [sx, sy] = app.renderer.worldToScreen(ui.handles[i].x, ui.handles[i].z);
    const d = Math.hypot(mx - sx, my - sy);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// ------------------------------------------------------- protected unlock
function askUnlock(why, onConfirm) {
  openModal('⛔ Zona protetta', `
    <p>Questo punto è dentro una <b>zona protetta</b>:</p>
    <p style="color:var(--zone)"><b>${why}</b></p>
    <p>Il runtime del gioco genera svincoli, raccordi (gore), spirali e aree di
    servizio direttamente da questa geometria: spostarla può creare muri
    scollegati, superfici sovrapposte o salti di quota.</p>
    <p><b>Procedi solo se sai esattamente cosa stai facendo.</b> La modifica
    verrà marcata come «sbloccata» e resterà segnalata negli avvisi.</p>`, [
    { label: 'Annulla', onClick: () => closeModal() },
    { label: 'Sblocca comunque (avanzato)', danger: true, onClick: () => { closeModal(); onConfirm(); } },
  ]);
}

// ----------------------------------------------------------- add handles
function addMoveHandle(routeId, wx, wz) {
  const r = app.renderer.routes.get(routeId);
  const prj = projectToPolyline(wx, wz, r.raw, r.rawCum, r.closed);
  if (prj.d > 60) { toast('Doppio clic troppo lontano dal percorso.'); return; }
  const why = zoneWhy(routeId, prj.s);
  const make = (unlocked) => {
    const op = state.addOp(routeId, {
      op: 'move',
      anchor: { station: Math.round(prj.s * 10) / 10, point: [round2(prj.x), round2(prj.z)], tolerance: 15 },
      to: [round2(prj.x), round2(prj.z)],
      influence: DEFAULT_INFLUENCE,
      weight: DEFAULT_WEIGHT,
      ...(unlocked ? { unlockProtected: true } : {}),
    });
    ui.handleSel.clear();
    ui.handleSel.add(ui.handles.findIndex((h) => h.opId === op.id));
    renderHandlePanel();
    schedulePreview(routeId);
    toast('Maniglia aggiunta: trascinala per correggere la curva.', '', 2500);
  };
  if (why) askUnlock(why, () => make(true));
  else make(false);
}

const round2 = (v) => Math.round(v * 100) / 100;

// -------------------------------------------------------------- dragging
let dragging = null; // { items: [{opId, startTo:[x,z]}], startW:[x,z], moved }
let boxSel = null;   // { x0, y0, el }
let armedSection = null; // 'a' | 'b' | null

function wireEditEvents() {
  const cv = $('map');

  cv.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
    const hi = hitTestHandle(mx, my);
    if (hi >= 0) {
      e.stopImmediatePropagation(); // keep app.mjs from panning
      if (e.shiftKey) {
        if (ui.handleSel.has(hi)) ui.handleSel.delete(hi); else ui.handleSel.add(hi);
        renderHandlePanel();
        redraw();
        return;
      }
      if (!ui.handleSel.has(hi)) { ui.handleSel.clear(); ui.handleSel.add(hi); }
      const [wx, wz] = app.renderer.screenToWorld(mx, my);
      dragging = {
        startW: [wx, wz],
        moved: false,
        items: [...ui.handleSel].map((i) => {
          const h = ui.handles[i];
          const op = state.findOp(ui.selectedId, h.opId);
          return { opId: h.opId, kind: h.kind, start: startPosOf(op) };
        }).filter((it) => it.start),
      };
      renderHandlePanel();
      redraw();
    } else if (e.shiftKey && ui.selectedId) {
      // rubber-band multi selection
      e.stopImmediatePropagation();
      boxSel = { x0: mx, y0: my, el: makeBoxEl(mx, my) };
    }
  }, { capture: true });

  window.addEventListener('mousemove', (e) => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
    if (boxSel) {
      const x = Math.min(boxSel.x0, mx); const y = Math.min(boxSel.y0, my);
      Object.assign(boxSel.el.style, {
        left: `${x}px`, top: `${y}px`,
        width: `${Math.abs(mx - boxSel.x0)}px`, height: `${Math.abs(my - boxSel.y0)}px`,
      });
      return;
    }
    if (!dragging) return;
    const [wx, wz] = app.renderer.screenToWorld(mx, my);
    let dx = wx - dragging.startW[0];
    let dz = wz - dragging.startW[1];
    if (Math.hypot(dx, dz) * ui.view.scale < 2 && !dragging.moved) return;
    dragging.moved = true;
    // snapping (single handle only): raw line, else 0.5 m grid
    if (ui.snap && dragging.items.length === 1) {
      const it = dragging.items[0];
      const tx = it.start[0] + dx; const tz = it.start[1] + dz;
      const r = app.renderer.routes.get(ui.selectedId);
      const prj = projectToPolyline(tx, tz, r.raw, r.rawCum, r.closed);
      if (prj.d * ui.view.scale < 14) { dx = prj.x - it.start[0]; dz = prj.z - it.start[1]; } else {
        dx = Math.round((tx) * 2) / 2 - it.start[0];
        dz = Math.round((tz) * 2) / 2 - it.start[1];
      }
    }
    for (const it of dragging.items) {
      applyDragTo(it, round2(it.start[0] + dx), round2(it.start[1] + dz));
    }
    rebuildHandles();
    schedulePreview(ui.selectedId, { light: true, delay: 90 });
    redraw();
  });

  window.addEventListener('mouseup', (e) => {
    if (boxSel) {
      const rect = cv.getBoundingClientRect();
      const mx = e.clientX - rect.left; const my = e.clientY - rect.top;
      const x0 = Math.min(boxSel.x0, mx); const x1 = Math.max(boxSel.x0, mx);
      const y0 = Math.min(boxSel.y0, my); const y1 = Math.max(boxSel.y0, my);
      boxSel.el.remove();
      boxSel = null;
      if (Math.abs(x1 - x0) > 6 || Math.abs(y1 - y0) > 6) {
        ui.handleSel.clear();
        ui.handles.forEach((h, i) => {
          const [sx, sy] = app.renderer.worldToScreen(h.x, h.z);
          if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ui.handleSel.add(i);
        });
        renderHandlePanel();
        redraw();
      }
      return;
    }
    if (dragging) {
      const wasDrag = dragging.moved;
      dragging = null;
      if (wasDrag) {
        state.commit();
        schedulePreview(ui.selectedId, { delay: 30 });
      }
    }
  });

  // double click → add handle (or first select the clicked route)
  window.addEventListener('editor:dblclick', (e) => {
    const { mx, my } = e.detail;
    const hit = app.renderer.hitTestRoute(mx, my, 12);
    if (!hit) return;
    if (hit.id !== ui.selectedId) { selectRoute(hit.id); return; }
    const [wx, wz] = app.renderer.screenToWorld(mx, my);
    addMoveHandle(hit.id, wx, wz);
  });

  // clicking the route while a section marker is armed
  window.addEventListener('editor:routeClick', (e) => {
    if (!armedSection || e.detail.id !== ui.selectedId) return;
    const r = app.renderer.routes.get(ui.selectedId);
    const prj = projectToPolyline(e.detail.x, e.detail.z, r.raw, r.rawCum, r.closed);
    ui.section.routeId = ui.selectedId;
    ui.section[armedSection] = Math.round(prj.s * 10) / 10;
    toast(`Marcatore ${armedSection.toUpperCase()} a ${prj.s.toFixed(0)} m.`, '', 1800);
    armedSection = null;
    redraw();
  });

  window.addEventListener('editor:selected', () => {
    ui.handleSel.clear();
    rebuildHandles();
    renderWarnPanel();
    redraw();
  });

  // keyboard (from app.mjs dispatcher)
  window.addEventListener('editor:key', (e) => {
    const { key, ctrl, shift, ev } = e.detail;
    if (ctrl && (key === 'z' || key === 'Z') && !shift) { ev.preventDefault(); doUndo(); }
    else if (ctrl && (key === 'y' || key === 'Y' || ((key === 'z' || key === 'Z') && shift))) { ev.preventDefault(); doRedo(); }
    else if (key === 'Delete' || key === 'Backspace') deleteSelectedHandles();
    else if ((key === 's' || key === 'S') && !ctrl) toggleSnap();
    else if (key === 'n') warnNav(1);
    else if (key === 'N') warnNav(-1);
  });

  $('btnUndo').addEventListener('click', doUndo);
  $('btnRedo').addEventListener('click', doRedo);
  $('btnSnap').addEventListener('click', toggleSnap);

  // handle panel
  for (const [id, apply] of [
    ['hx', (op, v) => patchHandlePos(op, [v, null])],
    ['hz', (op, v) => patchHandlePos(op, [null, v])],
    ['hinf', (op, v) => (op.op === 'move' ? { influence: clamp(v, 0, 2000) } : { span: clamp(v, 3, 2000) })],
    ['hw', (op, v) => (op.op === 'move' || op.op === 'insert' ? { weight: clamp(v, 1, 1e5) } : {})],
  ]) {
    $(id).addEventListener('change', () => {
      const op = firstSelectedOp();
      if (!op) return;
      const v = Number($(id).value);
      if (!Number.isFinite(v)) return;
      const patch = apply(op, v);
      if (patch) state.updateOp(ui.selectedId, op.id, patch);
      schedulePreview(ui.selectedId);
    });
  }
  $('hnote').addEventListener('change', () => {
    const op = firstSelectedOp();
    if (op) state.updateOp(ui.selectedId, op.id, { note: $('hnote').value.slice(0, 500) });
  });
  $('hen').addEventListener('change', () => {
    const op = firstSelectedOp();
    if (op) { state.updateOp(ui.selectedId, op.id, { enabled: $('hen').checked }); schedulePreview(ui.selectedId); }
  });
  $('btnHRestore').addEventListener('click', () => {
    const op = firstSelectedOp();
    if (!op) return;
    if (op.op === 'move' && op.anchor && Array.isArray(op.anchor.point)) {
      state.updateOp(ui.selectedId, op.id, { to: [...op.anchor.point] });
      schedulePreview(ui.selectedId);
    } else {
      toast('Il ripristino vale solo per le maniglie di spostamento.');
    }
  });
  $('btnHDelete').addEventListener('click', deleteSelectedHandles);

  // section tools
  $('btnSecA').addEventListener('click', () => { armedSection = 'a'; toast('Clicca sul percorso per fissare A.'); });
  $('btnSecB').addEventListener('click', () => { armedSection = 'b'; toast('Clicca sul percorso per fissare B.'); });
  $('btnSecClear').addEventListener('click', () => { ui.section = { routeId: ui.selectedId, a: null, b: null }; redraw(); });
  $('btnSecSmooth').addEventListener('click', () => sectionSmooth(0.25));
  $('btnSecCalm').addEventListener('click', () => sectionSmooth(0.1));
  $('btnSecStraighten').addEventListener('click', () => sectionFit('chord'));
  $('btnSecArc').addEventListener('click', () => sectionFit('arc'));
  $('btnSecReset').addEventListener('click', sectionReset);

  $('btnWarnPrev').addEventListener('click', () => warnNav(-1));
  $('btnWarnNext').addEventListener('click', () => warnNav(1));

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

function startPosOf(op) {
  if (!op) return null;
  if (op.op === 'move') return [...op.to];
  if (op.op === 'insert') return [op.point[0], op.point[op.point.length - 1]];
  if (op.anchor && Array.isArray(op.anchor.point)) return [...op.anchor.point];
  return null;
}

function applyDragTo(item, x, z) {
  const op = state.findOp(ui.selectedId, item.opId);
  if (!op) return;
  if (op.op === 'move') {
    state.updateOp(ui.selectedId, op.id, { to: [x, z] }, { commit: false });
  } else if (op.op === 'insert') {
    const pt = op.point.length === 3 ? [x, op.point[1], z] : [x, z];
    state.updateOp(ui.selectedId, op.id, { point: pt }, { commit: false });
  } else {
    // pin/smooth slide along the route: re-anchor at the nearest raw position
    const r = app.renderer.routes.get(ui.selectedId);
    const prj = projectToPolyline(x, z, r.raw, r.rawCum, r.closed);
    state.updateOp(ui.selectedId, op.id, {
      anchor: { ...op.anchor, station: Math.round(prj.s * 10) / 10, point: [round2(prj.x), round2(prj.z)] },
    }, { commit: false });
  }
}

function makeBoxEl(x, y) {
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'absolute', left: `${x}px`, top: `${y}px`, width: '0', height: '0',
    border: '1px dashed #3ddc97', background: '#3ddc9718', pointerEvents: 'none', zIndex: 20,
  });
  $('mapwrap').appendChild(el);
  return el;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function patchHandlePos(op, [x, z]) {
  if (op.op === 'move') {
    const to = [...op.to];
    if (x !== null) to[0] = x;
    if (z !== null) to[1] = z;
    return { to };
  }
  if (op.op === 'insert') {
    const pt = [...op.point];
    pt[0] = x !== null ? x : pt[0];
    pt[pt.length - 1] = z !== null ? z : pt[pt.length - 1];
    return { point: pt };
  }
  return null;
}

function firstSelectedOp() {
  const i = [...ui.handleSel][0];
  if (i === undefined) return null;
  const h = ui.handles[i];
  return h ? state.findOp(ui.selectedId, h.opId) : null;
}

function deleteSelectedHandles() {
  if (!ui.selectedId || !ui.handleSel.size) return;
  const ids = [...ui.handleSel].map((i) => ui.handles[i] && ui.handles[i].opId).filter(Boolean);
  for (const opId of ids) state.removeOp(ui.selectedId, opId, { commit: false });
  state.commit();
  ui.handleSel.clear();
  schedulePreview(ui.selectedId);
  toast(`${ids.length} maniglia/e eliminata/e.`, '', 1800);
}

function toggleSnap() {
  ui.snap = !ui.snap;
  $('btnSnap').classList.toggle('on', ui.snap);
}

function doUndo() { if (state.undo()) syncPreviews(); }
function doRedo() { if (state.redo()) syncPreviews(); }

// ---------------------------------------------------------- section tools
function sectionRange() {
  const sec = ui.section;
  if (!sec.routeId || sec.a == null || sec.b == null || sec.routeId !== ui.selectedId) {
    toast('Imposta prima i marcatori A e B su questo percorso.');
    return null;
  }
  const a = Math.min(sec.a, sec.b); const b = Math.max(sec.a, sec.b);
  if (b - a < 20) { toast('Sezione troppo corta (< 20 m).'); return null; }
  return { a, b };
}

function sectionSmooth(factor) {
  const rng = sectionRange();
  if (!rng) return;
  const r = app.renderer.routes.get(ui.selectedId);
  const mid = (rng.a + rng.b) / 2;
  const p = polylineAt(r.raw, r.rawCum, r.closed, mid);
  const why = zoneWhy(ui.selectedId, mid);
  const add = (unlocked) => {
    state.addOp(ui.selectedId, {
      op: 'smooth',
      anchor: { station: Math.round(mid * 10) / 10, point: [round2(p[0]), round2(p[2])], tolerance: 25 },
      span: Math.round((rng.b - rng.a) / 2 + 20),
      factor,
      note: `liscia sezione ${rng.a.toFixed(0)}–${rng.b.toFixed(0)} m`,
      ...(unlocked ? { unlockProtected: true } : {}),
    });
    schedulePreview(ui.selectedId);
  };
  if (why) askUnlock(why, () => add(true));
  else add(false);
}

/** Straighten (chord) or fit a broad arc between the two section stations. */
function sectionFit(mode) {
  const rng = sectionRange();
  if (!rng) return;
  const r = app.renderer.routes.get(ui.selectedId);
  const pa = polylineAt(r.raw, r.rawCum, r.closed, rng.a);
  const pb = polylineAt(r.raw, r.rawCum, r.closed, rng.b);
  const len = rng.b - rng.a;
  const k = Math.max(3, Math.ceil(len / 45));
  let targetAt;
  if (mode === 'chord') {
    targetAt = (t) => [pa[0] + (pb[0] - pa[0]) * t, pa[2] + (pb[2] - pa[2]) * t];
  } else {
    const pm = polylineAt(r.raw, r.rawCum, r.closed, (rng.a + rng.b) / 2);
    const cc = circumcircle(pa, pm, pb);
    if (!cc) { toast('La sezione è già praticamente dritta: uso la corda.'); targetAt = (t) => [pa[0] + (pb[0] - pa[0]) * t, pa[2] + (pb[2] - pa[2]) * t]; } else {
      targetAt = (t) => {
        const s = rng.a + len * t;
        const p = polylineAt(r.raw, r.rawCum, r.closed, s);
        const d = Math.hypot(p[0] - cc.cx, p[2] - cc.cz) || 1;
        return [cc.cx + ((p[0] - cc.cx) / d) * cc.r, cc.cz + ((p[2] - cc.cz) / d) * cc.r];
      };
    }
  }
  let added = 0; let blocked = 0;
  for (let i = 1; i < k; i += 1) {
    const t = i / k;
    const s = rng.a + len * t;
    if (zoneWhy(ui.selectedId, s)) { blocked += 1; continue; }
    const p = polylineAt(r.raw, r.rawCum, r.closed, s);
    const tgt = targetAt(t);
    state.addOp(ui.selectedId, {
      op: 'move',
      anchor: { station: Math.round(s * 10) / 10, point: [round2(p[0]), round2(p[2])], tolerance: 15 },
      to: [round2(tgt[0]), round2(tgt[1])],
      influence: Math.round(Math.min(90, (len / k) * 0.95)),
      weight: 40,
      note: mode === 'chord' ? 'raddrizza sezione' : 'arco sezione',
    }, { commit: false });
    added += 1;
  }
  state.commit();
  schedulePreview(ui.selectedId);
  toast(`${mode === 'chord' ? 'Raddrizzamento' : 'Arco'}: ${added} maniglie generate${blocked ? `, ${blocked} saltate (zona protetta)` : ''}.`);
}

function sectionReset() {
  const rng = sectionRange();
  if (!rng) return;
  const n = state.removeOpsInRange(ui.selectedId, rng.a, rng.b);
  schedulePreview(ui.selectedId);
  toast(n ? `${n} modifiche rimosse nella sezione.` : 'Nessuna modifica manuale nella sezione.');
}

// ------------------------------------------------------------ live preview
const inflight = new Map(); // routeId → AbortController
let previewTimers = new Map();
let calcCount = 0;

export function schedulePreview(routeId, { light = false, delay = 130 } = {}) {
  if (!routeId) return;
  clearTimeout(previewTimers.get(routeId));
  previewTimers.set(routeId, setTimeout(() => runPreview(routeId, light), delay));
}

async function runPreview(routeId, light) {
  if (!state.hasOps(routeId)) {
    app.renderer.setPreview(routeId, null);
    app.findingsByRoute.delete(routeId);
    updateMarkers();
    renderWarnPanel();
    renderStatsPanel();
    refreshSidebarBadges();
    redraw();
    return;
  }
  const prev = inflight.get(routeId);
  if (prev) prev.abort();
  const ctl = new AbortController();
  inflight.set(routeId, ctl);
  calcCount += 1;
  $('calcBadge').hidden = false;
  try {
    const res = await api.preview(routeId, state.doc, light, ctl.signal);
    if (inflight.get(routeId) !== ctl) return; // superseded
    app.renderer.setPreview(routeId, res.pts);
    const findings = [...res.findings];
    for (const w of res.overrideWarnings || []) findings.push({ severity: 'warning', code: 'override', message: w });
    res.light = light;
    app.findingsByRoute.set(routeId, findings);
    app.lastStats = res.stats;
    updateMarkers();
    markLockedHandles(findings);
    renderWarnPanel();
    renderStatsPanel();
    renderDevReadout(res.stats);
    refreshSidebarBadges();
    redraw();
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Anteprima fallita: ${e.message}`, 'error');
  } finally {
    if (inflight.get(routeId) === ctl) inflight.delete(routeId);
    calcCount -= 1;
    if (calcCount <= 0) { calcCount = 0; $('calcBadge').hidden = true; }
  }
}

/** Recompute previews for every edited route; clear stale ones. */
export function syncPreviews() {
  const edited = new Set(state.editedRouteIds());
  for (const id of [...ui.previews.keys()]) {
    if (!edited.has(id)) schedulePreview(id, { delay: 10 });
  }
  for (const id of edited) schedulePreview(id, { delay: 10 });
}

function markLockedHandles(findings) {
  for (const f of findings) {
    if ((f.code === 'protected' || f.code === 'protected-unlocked') && f.opId) {
      const h = ui.handles.find((x) => x.opId === f.opId);
      if (h) h.locked = true;
    }
  }
}

function renderDevReadout(stats) {
  if (!stats) return;
  const d = stats.devFromRaw;
  $('sbSel').textContent = `deviazione max dall'OSM ${d ? d.max.toFixed(2) : '—'} m · Δlunghezza ${stats.lenDelta >= 0 ? '+' : ''}${stats.lenDelta.toFixed(1)} m`;
}

// --------------------------------------------------------- warnings panel
function allFindings() {
  const list = [];
  for (const [routeId, fs] of app.findingsByRoute) {
    for (const f of fs) list.push({ ...f, routeId });
  }
  list.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return list;
}

export function renderWarnPanel() {
  const wrap = $('findings');
  const focus = ui.selectedId;
  const list = allFindings().filter((f) => !focus || f.routeId === focus);
  if (!list.length) {
    wrap.innerHTML = '<div class="placeholder">Nessun avviso.</div>';
    return;
  }
  wrap.innerHTML = '';
  list.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = `finding ${f.severity}${i === app.warnCursor ? ' cur' : ''}`;
    el.innerHTML = `<div class="fcode">${f.severity === 'error' ? '⛔ ERRORE BLOCCANTE' : '⚠ avviso'} · ${f.routeId} · ${f.code}</div>${f.message}`;
    el.addEventListener('click', () => focusFinding(f));
    wrap.appendChild(el);
  });
}

function focusFinding(f) {
  if (f.routeId && f.routeId !== ui.selectedId) selectRoute(f.routeId);
  if (f.x !== undefined) {
    ui.view.cx = f.x; ui.view.cz = f.z;
    ui.view.scale = Math.max(ui.view.scale, 1.2);
  } else if (Number.isFinite(f.station)) {
    const r = app.renderer.routes.get(f.routeId);
    if (r) {
      const p = polylineAt(r.raw, r.rawCum, r.closed, f.station);
      ui.view.cx = p[0]; ui.view.cz = p[2];
      ui.view.scale = Math.max(ui.view.scale, 1.2);
    }
  }
  redraw();
}

function warnNav(dir) {
  const list = allFindings();
  if (!list.length) { toast('Nessun avviso da scorrere.'); return; }
  app.warnCursor = ((app.warnCursor + dir) % list.length + list.length) % list.length;
  focusFinding(list[app.warnCursor]);
  renderWarnPanel();
}

function updateMarkers() {
  ui.markers = [];
  for (const [routeId, fs] of app.findingsByRoute) {
    for (const f of fs) {
      if (f.x !== undefined) ui.markers.push({ x: f.x, z: f.z, severity: f.severity, routeId });
    }
  }
}

// ------------------------------------------------------------ handle panel
export function renderHandlePanel() {
  const panel = $('handlePanel');
  const op = firstSelectedOp();
  if (!op) { panel.hidden = true; return; }
  panel.hidden = false;
  const n = ui.handleSel.size;
  const kindName = { move: 'spostamento', insert: 'inserimento', pin: 'blocco (pin)', smooth: 'levigatura', delete: 'eliminazione' }[op.op] || op.op;
  $('handleTitle').textContent = n > 1 ? `${kindName} (+${n - 1} selezionate)` : kindName;
  const pos = startPosOf(op) || [0, 0];
  $('hx').value = pos[0];
  $('hz').value = pos[1];
  $('hinf').value = op.op === 'move' ? (op.influence ?? DEFAULT_INFLUENCE) : (op.span ?? (op.op === 'smooth' ? 60 : 30));
  $('hw').value = op.weight ?? DEFAULT_WEIGHT;
  $('hw').disabled = !(op.op === 'move' || op.op === 'insert');
  $('hnote').value = op.note || '';
  $('hen').checked = op.enabled !== false;
  const s = op.anchor && Number.isFinite(op.anchor.station) ? `${op.anchor.station.toFixed(0)} m` : '—';
  const why = op.anchor && Number.isFinite(op.anchor.station) ? zoneWhy(ui.selectedId, op.anchor.station) : null;
  $('handleMeta').innerHTML = `progressiva ${s} · id ${op.id}${op.unlockProtected ? ' · <b style="color:var(--error)">SBLOCCATA in zona protetta</b>' : ''}${why && !op.unlockProtected ? ` · <b style="color:var(--zone)">zona protetta: ${why}</b>` : ''}`;
}
