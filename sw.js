const CACHE = 'shutoko-nights-v22';
const CORE = [
  './', './index.html', './styles.css', './styles/dev-map.css', './manifest.webmanifest', './icon.svg',
  './js/game.js', './js/map.js', './js/progressive-merge.js', './js/progressive-merge-prototypes.js',
  './js/physics.js', './js/traffic.js', './js/data.js', './js/retro-post.js',
  './js/save.js', './js/audio.js', './js/garage.js', './js/ui.js', './js/dev-map.js', './data/routes-smoothed.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
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
