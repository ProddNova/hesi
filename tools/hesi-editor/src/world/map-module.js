/**
 * One module record for js/map.js, shared by everything in the editor.
 *
 * ES modules are keyed by their full specifier, so `/js/map.js` and
 * `/js/map.js?v=x` are two independent copies — each with its own imported
 * route document. The road draft is applied by mutating that document before
 * the world is built, so it only lands if every editor module that touches
 * routes goes through the SAME import. Route the map (and its route data)
 * through here rather than importing it directly.
 */
export const MAP_MODULE_URL = '/js/map.js?v=20260722b';

let modulePromise = null;

export function loadMapModule() {
  modulePromise ??= import(MAP_MODULE_URL);
  return modulePromise;
}

/** The live route document HighwayMap builds from — mutate before building. */
export async function loadRouteNetworkData() {
  const module = await loadMapModule();
  const data = module.getRouteNetworkData?.();
  if (!data || typeof data !== 'object' || !Array.isArray(data.routes)) {
    throw new Error('js/map.js did not expose a route document with a routes array');
  }
  return data;
}
