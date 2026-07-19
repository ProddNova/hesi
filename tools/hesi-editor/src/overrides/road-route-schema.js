const SOURCE_PATH = 'data/editor/road-route-overrides.json';
const PRODUCTION_JSON_PATH = 'data/routes-smoothed.json';
const PRODUCTION_MODULE_PATH = 'data/routes-smoothed.js';
const MAX_ROUTES = 512;
const MAX_POINTS_PER_ROUTE = 20000;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  const rounded = Math.round((value + Number.EPSILON) * 100000) / 100000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function canonicalPoints(points, label) {
  if (!Array.isArray(points) || points.length < 2) throw new TypeError(`${label} must contain at least 2 points`);
  if (points.length > MAX_POINTS_PER_ROUTE) throw new TypeError(`${label} exceeds ${MAX_POINTS_PER_ROUTE} points`);
  return points.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 3) throw new TypeError(`${label}[${index}] must be an [x, y, z] triple`);
    return point.map((value, axis) => finiteNumber(value, `${label}[${index}][${axis}]`));
  });
}

export function validateProductionRouteDocument(document) {
  if (!isRecord(document) || !Array.isArray(document.routes)) {
    throw new TypeError('Production route document must be an object with a routes array');
  }
  if (!document.routes.length || document.routes.length > MAX_ROUTES) {
    throw new TypeError(`Production route document must contain 1-${MAX_ROUTES} routes`);
  }
  const ids = new Set();
  for (const route of document.routes) {
    if (!isRecord(route) || typeof route.id !== 'string' || !route.id.trim()) throw new TypeError('Every production route needs a non-empty string id');
    if (ids.has(route.id)) throw new TypeError(`Duplicate production route id: ${route.id}`);
    ids.add(route.id);
    canonicalPoints(route.points, `Production route ${route.id}.points`);
  }
  return document;
}

export function blankRoadRouteOverrides() {
  return { version: 1, source: PRODUCTION_JSON_PATH, routes: {}, syntheticRoutes: {} };
}

/**
 * Structurally validates and normalizes a road-route override document.
 * With `production`, override ids are checked against production routes;
 * `dropUnknown` silently drops overrides whose production route no longer
 * exists (stale files after an OSM/route rebuild) instead of failing every
 * subsequent save and publish.
 */
export function canonicalizeRoadRouteOverrides(document, { production = null, dropUnknown = false } = {}) {
  if (!isRecord(document)) throw new TypeError('Road route overrides must be an object');
  if (document.version !== 1) throw new TypeError('Road route overrides version must be 1');
  if (document.source !== PRODUCTION_JSON_PATH) throw new TypeError(`Road route overrides source must be ${PRODUCTION_JSON_PATH}`);
  if (!isRecord(document.routes)) throw new TypeError('Road route overrides routes must be an object keyed by route id');
  const syntheticDocument = document.syntheticRoutes ?? {};
  if (!isRecord(syntheticDocument)) throw new TypeError('Road route overrides syntheticRoutes must be an object keyed by runtime route id');
  const productionRoutes = production
    ? new Map(validateProductionRouteDocument(production).routes.map((route) => [route.id, route]))
    : null;
  const ids = Object.keys(document.routes).sort();
  const syntheticIds = Object.keys(syntheticDocument).sort();
  if (ids.length + syntheticIds.length > MAX_ROUTES) throw new TypeError(`Road route overrides exceed ${MAX_ROUTES} routes`);
  const routes = {};
  for (const id of ids) {
    if (!id.trim()) throw new TypeError('Road route override id cannot be empty');
    if (productionRoutes && !productionRoutes.has(id)) {
      if (dropUnknown) continue;
      throw new TypeError(`Road route override references unknown production route: ${id}`);
    }
    const entry = document.routes[id];
    if (!isRecord(entry)) throw new TypeError(`Road route override ${id} must be an object`);
    routes[id] = { points: canonicalPoints(entry.points, `Road route override ${id}.points`) };
  }
  const syntheticRoutes = {};
  for (const id of syntheticIds) {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(id)) throw new TypeError(`Synthetic road route override has an invalid id: ${id}`);
    if (productionRoutes?.has(id)) throw new TypeError(`Synthetic road route override duplicates a production route: ${id}`);
    const entry = syntheticDocument[id];
    if (!isRecord(entry)) throw new TypeError(`Synthetic road route override ${id} must be an object`);
    syntheticRoutes[id] = { points: canonicalPoints(entry.points, `Synthetic road route override ${id}.points`) };
  }
  return { version: 1, source: PRODUCTION_JSON_PATH, routes, syntheticRoutes };
}

export function mergeRoadRouteUpdates(previous, updates, production) {
  const base = canonicalizeRoadRouteOverrides(previous || blankRoadRouteOverrides(), { production, dropUnknown: true });
  if (!Array.isArray(updates) || !updates.length) throw new TypeError('Road route save requires at least one route update');
  const seen = new Set();
  const routes = { ...base.routes };
  const syntheticRoutes = { ...base.syntheticRoutes };
  const productionIds = new Set(validateProductionRouteDocument(production).routes.map((route) => route.id));
  for (const update of updates) {
    if (!isRecord(update) || typeof update.id !== 'string' || !update.id.trim()) throw new TypeError('Every road route update needs a non-empty string id');
    if (seen.has(update.id)) throw new TypeError(`Duplicate road route update: ${update.id}`);
    seen.add(update.id);
    const entry = { points: canonicalPoints(update.points, `Road route update ${update.id}.points`) };
    if (productionIds.has(update.id)) routes[update.id] = entry;
    else if (update.synthetic === true) syntheticRoutes[update.id] = entry;
    else throw new TypeError(`Road route update references unknown production route: ${update.id}`);
  }
  return canonicalizeRoadRouteOverrides({ ...base, routes, syntheticRoutes }, { production, dropUnknown: true });
}

export function applyRoadRouteOverrides(production, overrides) {
  validateProductionRouteDocument(production);
  const source = canonicalizeRoadRouteOverrides(overrides, { production, dropUnknown: true });
  const output = structuredClone(production);
  const byId = new Map(output.routes.map((route) => [route.id, route]));
  for (const [id, entry] of Object.entries(source.routes)) byId.get(id).points = structuredClone(entry.points);
  output.meta = isRecord(output.meta) ? output.meta : {};
  output.meta.editorRoadOverrides = {
    source: SOURCE_PATH,
    routes: Object.keys(source.routes).sort(),
    syntheticRoutes: structuredClone(source.syntheticRoutes),
  };
  return output;
}

export function serializeRoadRouteOverrides(document, options = {}) {
  return `${JSON.stringify(canonicalizeRoadRouteOverrides(document, options), null, 2)}\n`;
}

export function serializeProductionRoutes(document) {
  validateProductionRouteDocument(document);
  return JSON.stringify(document);
}

export function productionRouteModuleSource(json) {
  return '// GENERATED by tools/build-smoothed-routes.mjs from data/routes.json — do not edit by hand.\n'
    + '// Offline-faired centrelines (XZ only). Raw OSM data lives in data/routes.js.\n'
    + '// Data © OpenStreetMap contributors, ODbL 1.0.\n'
    + `export default ${json};\n`;
}

export const ROAD_ROUTE_PATHS = Object.freeze({
  source: SOURCE_PATH,
  productionJson: PRODUCTION_JSON_PATH,
  productionModule: PRODUCTION_MODULE_PATH,
});
