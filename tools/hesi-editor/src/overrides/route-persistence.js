/**
 * Road centreline persistence.
 *
 * Save writes only changed routes to the versioned editor source document.
 * Publish is a separate server action that validates and merges that source
 * into data/routes-smoothed.json + .js, which js/map.js and the game consume.
 */
import { loadRouteNetworkData } from '../world/map-module.js';

const ROUTES_ENDPOINT = '/__hesi_editor_routes';

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
     *
     * The document comes from js/map.js itself (see world/map-module.js).
     * Importing '/data/routes-smoothed.js' directly returns a SECOND module
     * record — mutating that one left HighwayMap building from the published
     * data, which is why a saved road draft used to survive neither Save Draft
     * nor a reload.
     */
    async loadDraftIntoModule() {
      const payload = await responseJson(await fetch(ROUTES_ENDPOINT, { cache: 'no-store' }));
      const production = await loadRouteNetworkData();
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
          // `base` travels with the draft: it is what lets HighwayMap accept
          // this edit verbatim instead of re-running its stale-override guard.
          syntheticRoutes[id] = {
            points: structuredClone(entry.points),
            ...(entry.base ? { base: structuredClone(entry.base) } : {}),
          };
        }
      }
      // Deleted roads travel the same channel: HighwayMap reads them straight
      // off the module meta, so the editor's world builds without them exactly
      // as the game will once the draft is applied.
      const savedRemovedRoutes = Array.isArray(payload.document?.removedRoutes) ? payload.document.removedRoutes : [];
      const overrideMeta = record(record(production, 'meta'), 'editorRoadOverrides');
      const previousRemoved = Array.isArray(overrideMeta.removedRoutes) ? overrideMeta.removedRoutes : [];
      if (previousRemoved.join('|') !== savedRemovedRoutes.join('|')) pending = true;
      overrideMeta.removedRoutes = [...savedRemovedRoutes];
      const ids = [...Object.keys(savedRoutes).filter((id) => !skipped.includes(id)), ...Object.keys(savedSyntheticRoutes)].sort();
      if (skipped.length) {
        onStatus(`Skipped ${skipped.length} saved road draft${skipped.length === 1 ? '' : 's'} no longer in production data · ${skipped.join(', ')}`);
      } else if (ids.length) {
        onStatus(`Editor map includes ${ids.length} saved road route draft${ids.length === 1 ? '' : 's'}${pending ? ' · playable game not updated yet' : ''}`);
      }
      return { ...payload, routes: ids, removedRoutes: savedRemovedRoutes, pending, skipped };
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
