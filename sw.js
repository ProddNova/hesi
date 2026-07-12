const CACHE = 'shutoko-nights-v8';
const CORE = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon.svg',
  './js/game-v20260712d.js', './js/three-fallback-v20260712d.js', './js/map-v20260712d.js', './js/physics-v20260712d.js', './js/traffic-v20260712d.js', './js/data.js',
  './js/save.js', './js/audio.js', './js/garage-v20260712d.js', './js/ui-v20260712d.js'
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
    const hit = await caches.match(event.request);
    if (hit) return hit;
    if (event.request.mode === 'navigate') return caches.match('./index.html');
    return Response.error();
  }));
});
