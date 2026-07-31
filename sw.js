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
  './js/save.js', './js/audio.js', './js/garage.js', './js/tatsumi-pa.js', './js/tatsumi-pa-lot.js', './js/ui.js', './js/dev-map.js', './js/debug-stats.js',
  './js/road-barrier-styles.js', './data/routes-smoothed.js', './data/road-barriers.js'
];

// Editor texture files are content-hashed (textures/<name>-<hash>.<ext>), so a
// given URL never changes: serve them cache-first and only touch the network
// once, instead of re-downloading every image on every startup.
const isImmutableAsset = request => {
  const path=new URL(request.url).pathname;
  return path.includes('/data/editor/textures/')||path.includes('/3d/PSXStyleCars-DevEdition/');
};

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
      // Claiming the page does not re-run the modules it already loaded from
      // the previous worker, so without this the deploy needs one more manual
      // reload — which on a phone means the player has no way to get it. Tell
      // the page instead; index.html decides whether reloading is safe.
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then(clients => { for (const client of clients) client.postMessage({ type: 'hesi-sw-activated', cache: CACHE }); })
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (isImmutableAsset(event.request)) {
    event.respondWith(caches.match(event.request, { ignoreSearch: true }).then(hit => hit || fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    })));
    return;
  }
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok || response.type === 'opaque') {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(async () => {
    const hit = await caches.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    if (event.request.mode === 'navigate') return caches.match('./index.html');
    return Response.error();
  }));
});
