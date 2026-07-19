/**
 * Road centreline persistence.
 *
 * Save writes only changed routes to the versioned editor source document.
 * Publish is a separate server action that validates and merges that source
 * into data/routes-smoothed.json + .js, which js/map.js and the game consume.
 */
const ROUTES_ENDPOINT = '/__hesi_editor_routes';
const ROUTES_MODULE_URL = '/data/routes-smoothed.js';

export function createRoutePersistence({ onStatus = () => {} } = {}) {
  const responseJson = async (response) => {
    const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Road route request failed (HTTP ${response.status})`);
    return payload;
  };

  return {
    async loadIntoModule(runtimeMap = null) {
      const payload = await responseJson(await fetch(ROUTES_ENDPOINT, { cache: 'no-store' }));
      const module = await import(ROUTES_MODULE_URL);
      const production = module.default;
      if (!production || typeof production !== 'object' || !Array.isArray(production.routes)) {
        throw new Error('Route data module did not export a document with a routes array');
      }
      const byId = new Map(production.routes.map((route) => [route.id, route]));
      const savedRoutes = payload.document?.routes || {};
      const samePoints = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      let pending = Object.entries(savedRoutes).some(([id, entry]) => !samePoints(byId.get(id)?.points, entry.points));
      for (const [id, entry] of Object.entries(savedRoutes)) {
        const route = byId.get(id);
        if (!route) throw new Error(`Saved road route is missing from production data: ${id}`);
        route.points = structuredClone(entry.points);
      }
      const savedSyntheticRoutes = payload.document?.syntheticRoutes || {};
      const publishedSyntheticRoutes = production.meta?.editorRoadOverrides?.syntheticRoutes || {};
      pending ||= Object.entries(savedSyntheticRoutes)
        .some(([id, entry]) => !samePoints(publishedSyntheticRoutes[id]?.points, entry.points));
      for (const [id, entry] of Object.entries(savedSyntheticRoutes)) {
        if (!runtimeMap?.routes?.has(id)) throw new Error(`Saved synthetic road route is missing from the runtime map: ${id}`);
        if (!runtimeMap.applyEditorRouteOverride?.(id, entry.points)) {
          throw new Error(`Saved synthetic road route endpoints no longer match the generated route: ${id}`);
        }
      }
      const ids = [...Object.keys(savedRoutes), ...Object.keys(savedSyntheticRoutes)].sort();
      if (ids.length) onStatus(`Loaded ${ids.length} saved road route${ids.length === 1 ? '' : 's'} pending/used for publish`);
      return { ...payload, routes: ids, pending };
    },

    async save(updates) {
      const payload = await responseJson(await fetch(ROUTES_ENDPOINT, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates }),
      }));
      onStatus(`Saved road draft · ${payload.path} · playable game unchanged`);
      return payload;
    },

    async publish() {
      const payload = await responseJson(await fetch(ROUTES_ENDPOINT, { method: 'POST' }));
      onStatus(`Applied ${payload.routes.length} road route${payload.routes.length === 1 ? '' : 's'} to the playable game · ${payload.modulePath}`);
      return payload;
    },
  };
}
