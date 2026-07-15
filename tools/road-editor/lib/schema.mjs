/**
 * data/route-overrides.json schema + validator (no dependencies).
 *
 * Accepts:
 *   v2 (stable editor format) — { version: 2, meta?, routes: { id: [op…] } }
 *   v1 (legacy index format)  — { id: [ {op:'move'|'insert'|'delete', …} ] }
 *
 * validateOverrides(doc) → { ok, version, errors: [ { path, message } ] }
 * Messages are in Italian: they surface directly in the editor UI.
 */

const OPS_V2 = new Set(['move', 'insert', 'delete', 'pin', 'smooth']);
const OPS_V1 = new Set(['move', 'insert', 'delete']);
const MAX_OPS_PER_ROUTE = 500;
const MAX_ROUTES = 512;
const MAX_NOTE = 500;
const COORD_LIMIT = 1e6; // |x|,|z| sanity bound (m)

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isXY = (v) => Array.isArray(v) && v.length === 2 && isFiniteNum(v[0]) && isFiniteNum(v[1])
  && Math.abs(v[0]) < COORD_LIMIT && Math.abs(v[1]) < COORD_LIMIT;
const isXYZ = (v) => Array.isArray(v) && v.length === 3 && v.every(isFiniteNum)
  && Math.abs(v[0]) < COORD_LIMIT && Math.abs(v[2]) < COORD_LIMIT;

export function detectVersion(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 0;
  if (doc.version === 2 && doc.routes && typeof doc.routes === 'object' && !Array.isArray(doc.routes)) return 2;
  // v1: every value is an array (empty object counts as v1-compatible)
  const keys = Object.keys(doc);
  if (keys.every((k) => Array.isArray(doc[k]))) return 1;
  return 0;
}

function validateAnchor(anchor, path, errors, { requirePoint = false } = {}) {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    errors.push({ path, message: 'anchor mancante o non valido' });
    return;
  }
  const hasStation = anchor.station !== undefined;
  const hasPoint = anchor.point !== undefined;
  if (hasStation && !isFiniteNum(anchor.station)) {
    errors.push({ path: `${path}.station`, message: 'station deve essere un numero finito (metri lungo il percorso)' });
  }
  if (hasPoint && !isXY(anchor.point)) {
    errors.push({ path: `${path}.point`, message: 'point deve essere [x, z] con numeri finiti' });
  }
  if (!hasStation && !hasPoint) {
    errors.push({ path, message: 'anchor richiede almeno station o point' });
  }
  if (requirePoint && !hasPoint) {
    errors.push({ path: `${path}.point`, message: 'questa operazione richiede anchor.point per un aggancio sicuro' });
  }
  if (anchor.tolerance !== undefined && (!isFiniteNum(anchor.tolerance) || anchor.tolerance <= 0 || anchor.tolerance > 200)) {
    errors.push({ path: `${path}.tolerance`, message: 'tolerance deve essere in (0, 200] metri' });
  }
  if (anchor.fingerprint !== undefined) {
    const fp = anchor.fingerprint;
    if (!Array.isArray(fp) || fp.length > 2 || !fp.every(isXY)) {
      errors.push({ path: `${path}.fingerprint`, message: 'fingerprint deve essere una lista di al massimo 2 punti [x, z]' });
    }
  }
}

function validateOpV2(op, path, errors) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    errors.push({ path, message: 'operazione non valida (atteso un oggetto)' });
    return;
  }
  if (!OPS_V2.has(op.op)) {
    errors.push({ path: `${path}.op`, message: `op sconosciuta '${op.op}' (valide: ${[...OPS_V2].join(', ')})` });
    return;
  }
  if (op.id !== undefined && (typeof op.id !== 'string' || !op.id.length || op.id.length > 64)) {
    errors.push({ path: `${path}.id`, message: 'id deve essere una stringa (max 64 caratteri)' });
  }
  if (op.enabled !== undefined && typeof op.enabled !== 'boolean') {
    errors.push({ path: `${path}.enabled`, message: 'enabled deve essere true o false' });
  }
  if (op.note !== undefined && (typeof op.note !== 'string' || op.note.length > MAX_NOTE)) {
    errors.push({ path: `${path}.note`, message: `note deve essere una stringa (max ${MAX_NOTE} caratteri)` });
  }
  if (op.createdAt !== undefined && typeof op.createdAt !== 'string') {
    errors.push({ path: `${path}.createdAt`, message: 'createdAt deve essere una stringa ISO' });
  }
  if (op.unlockProtected !== undefined && typeof op.unlockProtected !== 'boolean') {
    errors.push({ path: `${path}.unlockProtected`, message: 'unlockProtected deve essere true o false' });
  }
  switch (op.op) {
    case 'move':
      validateAnchor(op.anchor, `${path}.anchor`, errors);
      if (!isXY(op.to)) errors.push({ path: `${path}.to`, message: 'to deve essere [x, z] con numeri finiti' });
      if (op.influence !== undefined && (!isFiniteNum(op.influence) || op.influence < 0 || op.influence > 2000)) {
        errors.push({ path: `${path}.influence`, message: 'influence deve essere in [0, 2000] metri' });
      }
      if (op.weight !== undefined && (!isFiniteNum(op.weight) || op.weight < 1 || op.weight > 1e5)) {
        errors.push({ path: `${path}.weight`, message: 'weight deve essere in [1, 1e5]' });
      }
      break;
    case 'insert':
      validateAnchor(op.anchor, `${path}.anchor`, errors);
      if (!isXY(op.point) && !isXYZ(op.point)) {
        errors.push({ path: `${path}.point`, message: 'point deve essere [x, z] oppure [x, y, z]' });
      }
      if (op.weight !== undefined && (!isFiniteNum(op.weight) || op.weight < 1 || op.weight > 1e5)) {
        errors.push({ path: `${path}.weight`, message: 'weight deve essere in [1, 1e5]' });
      }
      break;
    case 'delete':
      validateAnchor(op.anchor, `${path}.anchor`, errors, { requirePoint: true });
      break;
    case 'pin':
      validateAnchor(op.anchor, `${path}.anchor`, errors);
      if (op.span !== undefined && (!isFiniteNum(op.span) || op.span < 3 || op.span > 2000)) {
        errors.push({ path: `${path}.span`, message: 'span deve essere in [3, 2000] metri' });
      }
      break;
    case 'smooth':
      validateAnchor(op.anchor, `${path}.anchor`, errors);
      if (op.span !== undefined && (!isFiniteNum(op.span) || op.span < 6 || op.span > 2000)) {
        errors.push({ path: `${path}.span`, message: 'span deve essere in [6, 2000] metri' });
      }
      if (op.factor !== undefined && (!isFiniteNum(op.factor) || op.factor < 0.02 || op.factor > 1)) {
        errors.push({ path: `${path}.factor`, message: 'factor deve essere in [0.02, 1]' });
      }
      break;
    default:
  }
}

function validateOpV1(op, path, errors) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    errors.push({ path, message: 'operazione non valida (atteso un oggetto)' });
    return;
  }
  if (!OPS_V1.has(op.op)) {
    errors.push({ path: `${path}.op`, message: `op sconosciuta '${op.op}' (formato v1: move, insert, delete)` });
    return;
  }
  if (op.op === 'move') {
    if (!Number.isInteger(op.index) || op.index < 0) errors.push({ path: `${path}.index`, message: 'index deve essere un intero >= 0' });
    if (!isXY(op.to) && !isXYZ(op.to)) errors.push({ path: `${path}.to`, message: 'to deve essere [x, z] o [x, y, z]' });
  } else if (op.op === 'insert') {
    if (!Number.isInteger(op.after) || op.after < 0) errors.push({ path: `${path}.after`, message: 'after deve essere un intero >= 0' });
    if (!isXY(op.point) && !isXYZ(op.point)) errors.push({ path: `${path}.point`, message: 'point deve essere [x, z] o [x, y, z]' });
  } else if (op.op === 'delete') {
    if (!Number.isInteger(op.index) || op.index < 0) errors.push({ path: `${path}.index`, message: 'index deve essere un intero >= 0' });
  }
}

/**
 * Validate an overrides document (either format).
 * knownRouteIds (optional Set/Array) flags unknown route ids as errors.
 */
export function validateOverrides(doc, knownRouteIds = null) {
  const errors = [];
  const version = detectVersion(doc);
  if (version === 0) {
    return {
      ok: false,
      version: 0,
      errors: [{ path: '$', message: 'documento non riconosciuto: atteso formato v2 {version:2, routes:{…}} o v1 {routeId:[…]}' }],
    };
  }
  const known = knownRouteIds ? new Set(knownRouteIds) : null;
  const routesObj = version === 2 ? doc.routes : doc;
  const ids = Object.keys(routesObj);
  if (ids.length > MAX_ROUTES) {
    errors.push({ path: '$.routes', message: `troppi percorsi (${ids.length} > ${MAX_ROUTES})` });
  }
  if (version === 2 && doc.meta !== undefined && (typeof doc.meta !== 'object' || Array.isArray(doc.meta))) {
    errors.push({ path: '$.meta', message: 'meta deve essere un oggetto' });
  }
  for (const id of ids) {
    if (version === 1 && id === 'version') continue;
    const base = version === 2 ? `$.routes.${id}` : `$.${id}`;
    if (known && !known.has(id)) {
      errors.push({ path: base, message: `percorso sconosciuto '${id}'` });
    }
    const ops = routesObj[id];
    if (!Array.isArray(ops)) {
      errors.push({ path: base, message: 'attesa una lista di operazioni' });
      continue;
    }
    if (ops.length > MAX_OPS_PER_ROUTE) {
      errors.push({ path: base, message: `troppe operazioni (${ops.length} > ${MAX_OPS_PER_ROUTE})` });
      continue;
    }
    const seen = new Set();
    ops.forEach((op, i) => {
      const path = `${base}[${i}]`;
      if (version === 2) {
        validateOpV2(op, path, errors);
        if (op && typeof op.id === 'string') {
          if (seen.has(op.id)) errors.push({ path: `${path}.id`, message: `id duplicato '${op.id}'` });
          seen.add(op.id);
        }
      } else {
        validateOpV1(op, path, errors);
      }
    });
  }
  return { ok: errors.length === 0, version, errors };
}

/** Empty v2 document skeleton. */
export function emptyOverrides() {
  return { version: 2, meta: { tool: 'road-editor' }, routes: {} };
}
