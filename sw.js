// STAMPED AT BUILD TIME — do not edit by hand; scripts/stamp-build.mjs rewrites
// this line with the deployed commit as Render's build command. The value
// committed here is whatever the last local stamp produced and is only a
// placeholder.
//
// Why it has to change per deploy: the fetch handler below is network-first, so
// normally an update is picked up without any cache work. But the offline
// fallback serves whatever is in Cache Storage, and a free Render instance
// sleeps — the first request after a cold start can take long enough to fail,
// at which point the whole previous build is served out of this cache and the
// player sees a deploy that "did not apply". A new name is what makes
// install/activate run: it re-fetches CORE from the network and deletes the old
// cache. This was a manual bump until 28 Jul 2026, which meant it was sometimes
// simply forgotten.
const CACHE = 'shutoko-nights-aa56cc4f53cb';
const CORE = [
  './', './index.html', './styles.css', './styles/dev-map.css', './styles/debug-stats.css', './styles/playground.css', './manifest.webmanifest', './icon.svg', './fonts/shutoko-signal-regular.woff2', './fonts/shutoko-signal-bold.woff2', './fonts/shutoko-signal-display.woff2',
  './js/game.js', './js/map.js', './js/progressive-merge.js', './js/progressive-merge-prototypes.js',
  './js/editor-map-patch.js', './js/lighting-config.js', './js/custom-assets.js', './js/building-types.js', './js/skybox-config.js', './js/skybox.js',
  './js/physics.js', './js/traffic.js', './js/data.js', './js/psx-car-pack.js', './js/car-models.js', './js/car-paint.js', './js/playground-config.js', './js/playground.js', './js/vhs-effect.js', './js/ps2-filter.js',
  './js/save.js', './js/audio.js', './js/garage.js', './js/tatsumi-pa.js', './js/ui.js', './js/dev-map.js', './js/debug-stats.js',
  './js/road-barrier-styles.js', './data/routes-smoothed.js', './data/road-barriers.js'
];

// Editor texture files are content-hashed (textures/<name>-<hash>.<ext>) AND
// served `immutable, max-age=31536000` (render.yaml), so the HTTP cache already
// answers them without a network trip and a given URL can never go stale. The
// worker deliberately does NOT copy them into Cache Storage as well: they are
// ~68 MB against a ~2 MB core, and mirroring them put the origin over the
// storage quota a phone actually grants. See the install handler for what that
// cost — this passthrough is the main reason the update now fits.
const isHttpCachedAsset = request => new URL(request.url).pathname.includes('/data/editor/textures/');

// The car pack is NOT content-hashed — 3d/.../car.glb keeps its URL when the
// model changes — so it cannot be cache-first across deploys without freezing
// old models on the client forever, the same trap this file is fixing. Scoping
// the lookup to the current CACHE gets both halves: within one build it is
// served from storage with no round-trips, and a new build starts from an empty
// cache and re-fetches.
const isBuildScopedAsset = request => new URL(request.url).pathname.includes('/3d/PSXStyleCars-DevEdition/');

const deleteOtherCaches = async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
};

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    // Reclaim the previous build's storage BEFORE writing the new core, not in
    // activate afterwards. Cache Storage on a phone is a fraction of what a
    // desktop grants, and "previous build + new build" did not fit: the write
    // below rejected on quota, which failed install, which left the OLD worker
    // in charge — and a failed install never reaches activate, so the old cache
    // was never freed and every retry hit the same wall. The phone stayed on
    // the old build indefinitely (old textures) while desktop, with quota to
    // spare, updated normally. Purging first makes the update fit. The outgoing
    // worker is network-first, so it keeps serving from the network meanwhile.
    await deleteOtherCaches();
    const cache = await caches.open(CACHE);
    // Per-file rather than addAll(): addAll is all-or-nothing, so one flaky
    // request on a phone aborted the entire install and postponed the update
    // until some later load happened to get 41 requests through cleanly. A
    // single miss here only costs the offline fallback for that one file.
    await Promise.allSettled(CORE.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    // Install already purged; this catches anything a worker that installed
    // concurrently may have left behind.
    deleteOtherCaches()
      .then(() => self.clients.claim())
      // Claiming the page does not re-run the modules it already loaded from
      // the previous worker, so without this the deploy needs one more manual
      // reload — which on a phone means the player has no way to get it. Tell
      // the page instead; index.html decides whether reloading is safe.
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => { for (const client of clients) client.postMessage({ type: 'hesi-sw-activated', cache: CACHE }); })
  );
});

// A quota failure must never reject: an unhandled rejection here used to be
// able to take down the waitUntil it was started from. Storing a response is
// an optimisation, so losing one is not worth failing the request over.
const store = (request, response) => {
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
};

// Only ever fall back to THIS build's cache. The global caches.match() searches
// every cache the origin holds, so a leftover cache from an earlier deploy
// could answer — handing back that build's custom-assets.json, whose texture
// URLs point at the images that shipped with it. That is a stale manifest
// producing stale textures even though every texture URL is content-correct.
const cachedFallback = async (request) => {
  const cache = await caches.open(CACHE);
  // ignoreSearch because CORE is stored unstamped ('./js/game.js') while the
  // page requests the stamped URL ('./js/game.js?v=<build>').
  return cache.match(request, { ignoreSearch: true });
};

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // Content-hashed and marked immutable: let the browser's own HTTP cache serve
  // it. Nothing to add here, and not duplicating 68 MB is the point.
  if (isHttpCachedAsset(event.request)) return;

  if (isBuildScopedAsset(event.request)) {
    event.respondWith((async () => {
      const hit = await cachedFallback(event.request);
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) store(event.request, response);
      return response;
    })());
    return;
  }

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok || response.type === 'opaque') store(event.request, response);
      return response;
    } catch {
      const hit = await cachedFallback(event.request);
      if (hit) return hit;
      if (event.request.mode === 'navigate') {
        const shell = await cachedFallback(new Request('./index.html'));
        if (shell) return shell;
      }
      return Response.error();
    }
  })());
});
