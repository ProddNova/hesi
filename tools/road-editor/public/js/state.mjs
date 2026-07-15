/**
 * Editor override-document state: v2 doc + undo/redo + draft autosave.
 * DOM-free — the browser passes localStorage, the Node tests a plain map.
 */
import { History } from './history.mjs';

export function makeOpId() {
  return `ov_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyDoc() {
  return { version: 2, meta: { tool: 'road-editor' }, routes: {} };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

export class EditorState {
  /**
   * @param {object} [opts]
   * @param {Storage|{getItem,setItem,removeItem}} [opts.storage] draft store
   * @param {string} [opts.storageKey]
   */
  constructor({ storage = null, storageKey = 'roadEditor:draft' } = {}) {
    this.storage = storage;
    this.storageKey = storageKey;
    this.doc = emptyDoc();
    this.history = new History(200);
    this.history.reset(JSON.stringify(this.doc));
    this.baseline = JSON.stringify(this.doc);
    this.onChange = null; // set by the UI; called after every doc change
  }

  /** Replace the document (server load / import / restore). */
  load(doc, { asBaseline = true } = {}) {
    this.doc = doc ? clone(doc) : emptyDoc();
    if (this.doc.version !== 2) {
      // legacy v1 imports become v2 with the v1 ops preserved per route
      const routes = {};
      for (const [id, ops] of Object.entries(this.doc)) {
        if (Array.isArray(ops)) routes[id] = ops;
      }
      this.doc = { version: 2, meta: { tool: 'road-editor', importedFrom: 'v1' }, routes };
    }
    if (!this.doc.routes) this.doc.routes = {};
    const snap = JSON.stringify(this.doc);
    this.history.reset(snap);
    if (asBaseline) this.baseline = snap;
    this.emit();
  }

  emit() { if (this.onChange) this.onChange(); }

  get dirty() { return JSON.stringify(this.doc) !== this.baseline; }

  markSaved() { this.baseline = JSON.stringify(this.doc); this.emit(); }

  hasOps(routeId) {
    const ops = this.doc.routes[routeId];
    return Array.isArray(ops) && ops.length > 0;
  }

  opsFor(routeId) { return this.doc.routes[routeId] || []; }

  editedRouteIds() {
    return Object.keys(this.doc.routes).filter((id) => this.doc.routes[id].length);
  }

  findOp(routeId, opId) {
    return this.opsFor(routeId).find((o) => o.id === opId) || null;
  }

  /** Commit the current doc to history (+ draft). Duplicate-safe. */
  commit() {
    const pushed = this.history.push(JSON.stringify(this.doc));
    if (pushed) this.draftSave();
    this.emit();
    return pushed;
  }

  // ------------------------------------------------------------ mutations
  /** Add an op; returns it. commit:false while dragging (call commit() at end). */
  addOp(routeId, op, { commit = true } = {}) {
    if (!op.id) op.id = makeOpId();
    if (op.enabled === undefined) op.enabled = true;
    if (!op.createdAt) op.createdAt = new Date().toISOString();
    if (!this.doc.routes[routeId]) this.doc.routes[routeId] = [];
    this.doc.routes[routeId].push(op);
    if (commit) this.commit();
    return op;
  }

  updateOp(routeId, opId, patch, { commit = true } = {}) {
    const op = this.findOp(routeId, opId);
    if (!op) return null;
    Object.assign(op, clone(patch));
    if (commit) this.commit();
    return op;
  }

  removeOp(routeId, opId, { commit = true } = {}) {
    const ops = this.doc.routes[routeId];
    if (!ops) return false;
    const i = ops.findIndex((o) => o.id === opId);
    if (i < 0) return false;
    ops.splice(i, 1);
    if (!ops.length) delete this.doc.routes[routeId];
    if (commit) this.commit();
    return true;
  }

  /** Remove every op anchored inside [s0,s1] on a route. Returns count. */
  removeOpsInRange(routeId, s0, s1, { commit = true } = {}) {
    const ops = this.doc.routes[routeId];
    if (!ops) return 0;
    const lo = Math.min(s0, s1); const hi = Math.max(s0, s1);
    const keep = ops.filter((o) => {
      const s = o.anchor && Number.isFinite(o.anchor.station) ? o.anchor.station : null;
      return s === null || s < lo || s > hi;
    });
    const removed = ops.length - keep.length;
    if (removed) {
      if (keep.length) this.doc.routes[routeId] = keep;
      else delete this.doc.routes[routeId];
      if (commit) this.commit();
    }
    return removed;
  }

  clearRoute(routeId, { commit = true } = {}) {
    if (!this.doc.routes[routeId]) return false;
    delete this.doc.routes[routeId];
    if (commit) this.commit();
    return true;
  }

  // ---------------------------------------------------------- undo / redo
  get canUndo() { return this.history.canUndo; }

  get canRedo() { return this.history.canRedo; }

  undo() {
    const snap = this.history.undo();
    if (snap === null) return false;
    this.doc = JSON.parse(snap);
    this.draftSave();
    this.emit();
    return true;
  }

  redo() {
    const snap = this.history.redo();
    if (snap === null) return false;
    this.doc = JSON.parse(snap);
    this.draftSave();
    this.emit();
    return true;
  }

  // --------------------------------------------------------------- drafts
  draftSave() {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify({
        doc: this.doc,
        baseline: this.baseline,
        at: new Date().toISOString(),
      }));
    } catch { /* quota — non-fatal */ }
  }

  draftLoad() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || typeof d !== 'object' || !d.doc) return null;
      return d;
    } catch {
      return null;
    }
  }

  draftClear() {
    if (this.storage) this.storage.removeItem(this.storageKey);
  }
}
