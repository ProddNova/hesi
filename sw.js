const CACHE = 'shutoko-nights-v29';
const CORE = [
  './', './index.html', './styles.css', './styles/dev-map.css', './styles/debug-stats.css', './manifest.webmanifest', './icon.svg',
  './fonts/chakrapetch-400.woff2', './fonts/chakrapetch-500.woff2', './fonts/chakrapetch-700.woff2', './fonts/chakrapetch-700i.woff2',
  './fonts/sairacond-700.woff2', './fonts/sairacond-800.woff2', './fonts/sharetechmono-400.woff2', './fonts/doto-600.woff2', './fonts/doto-800.woff2',
  './js/game.js', './js/map.js', './js/progressive-merge.js', './js/progressive-merge-prototypes.js',
  './js/physics.js', './js/traffic.js', './js/data.js',
  './js/save.js', './js/audio.js', './js/garage.js', './js/ui.js', './js/dev-map.js', './js/debug-stats.js', './data/routes-smoothed.js'
];

// Editor texture files are content-hashed (textures/<name>-<hash>.<ext>), so a
// given URL never changes: serve them cache-first and only touch the network
// once, instead of re-downloading every image on every startup.
const isImmutableAsset = request => new URL(request.url).pathname.includes('/data/editor/textures/');

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
