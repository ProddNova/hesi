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
    /**
     * Applies the saved road draft to the routes module. Must run BEFORE the
     * editor constructs HighwayMap so the generated asphalt, markings, and
     * analytic collision all reflect the draft; the playable game keeps
     * reading the published files until an explicit Apply to Game.
     *
     * - Production-route drafts overwrite the module's route points.
     * - Synthetic-route drafts merge into meta.editorRoadOverrides, the same
     *   channel HighwayMap already replays during construction.
     * - Draft entries whose route no longer exists are skipped with a status
     *   warning instead of failing the whole editor load.
     */
    async loadDraftIntoModule() {
      const payload = await responseJson(await fetch(ROUTES_ENDPOINT, { cache: 'no-store' }));
      const module = await import(ROUTES_MODULE_URL);
      const production = module.default;
      if (!production || typeof production !== 'object' || !Array.isArray(production.routes)) {
        throw new Error('Route data module did not export a document with a routes array');
      }
      const byId = new Map(production.routes.map((route) => [route.id, route]));
      const samePoints = (left, right) => JSON.stringify(left) === JSON.stringify(right);
      const record = (holder, key) => holder[key] = (holder[key] && typeof holder[key] === 'object' && !Array.isArray(holder[key])) ? holder[key] : {};
      const skipped = [];
      let pending = false;
      const savedRoutes = payload.document?.routes || {};
      for (const [id, entry] of Object.entries(savedRoutes)) {
        const route = byId.get(id);
        if (!route) { skipped.push(id); continue; }
        // The module still holds published data here, so a difference means
        // this draft has not been applied to the game yet.
        if (!samePoints(route.points, entry.points)) pending = true;
        route.points = structuredClone(entry.points);
      }
      const savedSyntheticRoutes = payload.document?.syntheticRoutes || {};
      if (Object.keys(savedSyntheticRoutes).length) {
        const syntheticRoutes = record(record(record(production, 'meta'), 'editorRoadOverrides'), 'syntheticRoutes');
        for (const [id, entry] of Object.entries(savedSyntheticRoutes)) {
          if (!samePoints(syntheticRoutes[id]?.points, entry.points)) pending = true;
          syntheticRoutes[id] = { points: structuredClone(entry.points) };
        }
      }
      const ids = [...Object.keys(savedRoutes).filter((id) => !skipped.includes(id)), ...Object.keys(savedSyntheticRoutes)].sort();
      if (skipped.length) {
        onStatus(`Skipped ${skipped.length} saved road draft${skipped.length === 1 ? '' : 's'} no longer in production data · ${skipped.join(', ')}`);
      } else if (ids.length) {
        onStatus(`Editor map includes ${ids.length} saved road route draft${ids.length === 1 ? '' : 's'}${pending ? ' · playable game not updated yet' : ''}`);
      }
      return { ...payload, routes: ids, pending, skipped };
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
