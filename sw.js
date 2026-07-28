// BUMP THIS ON EVERY DEPLOY THAT CHANGES A CORE FILE.
//
// The fetch handler below is network-first, so in the normal case a deploy is
// picked up without touching this. But the offline fallback serves whatever is
// in Cache Storage, and on a free Render instance the site sleeps: the first
// request after a cold start can take long enough to fail, at which point the
// whole old build is served out of this cache and the player sees a deploy
// that "did not apply". Bumping the name is what makes install/activate run —
// it re-fetches CORE from the network and deletes the previous cache. With
// skipWaiting + clients.claim below, the fix lands on the next page load.
const CACHE = 'shutoko-nights-v66';
const CORE = [
  './', './index.html', './styles.css', './styles/dev-map.css', './styles/debug-stats.css', './styles/playground.css', './manifest.webmanifest', './icon.svg', './fonts/shutoko-signal-regular.woff2', './fonts/shutoko-signal-bold.woff2', './fonts/shutoko-signal-display.woff2',
  './js/game.js', './js/map.js', './js/progressive-merge.js', './js/progressive-merge-prototypes.js',
  './js/editor-map-patch.js', './js/lighting-config.js', './js/custom-assets.js', './js/building-types.js', './js/skybox-config.js', './js/skybox.js',
  './js/physics.js', './js/traffic.js', './js/data.js', './js/psx-car-pack.js', './js/car-models.js', './js/car-paint.js', './js/playground-config.js', './js/playground.js', './js/vhs-effect.js',
  './js/save.js', './js/audio.js', './js/garage.js', './js/tatsumi-pa.js', './js/ui.js', './js/dev-map.js', './js/debug-stats.js',
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
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
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
