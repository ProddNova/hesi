/**
 * Service-worker update path: the phone-only failure where a deploy never
 * reaches the player and old textures stay on screen.
 *
 * A unit test rather than a browser probe because the cause is a storage quota
 * an ordinary browser will not impose: desktop Chrome grants tens of GB, so the
 * bug is invisible there, which is exactly why it read as "fine on PC, stuck on
 * mobile". The quota is supplied directly instead.
 *
 * The failure it locks down: the worker mirrored ~68 MB of editor textures plus
 * the ~12 MB asset manifest into Cache Storage. On a phone that overran the
 * origin quota, so install's cache write rejected → install failed → the OLD
 * worker stayed in charge → activate (which is what deleted the previous cache)
 * never ran → the next attempt hit the same full storage. Self-perpetuating:
 * the phone served the previous build indefinitely.
 *
 * Run: node --test .devtests/sw-cache.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SW_SOURCE = await readFile(new URL('../sw.js', import.meta.url), 'utf8');

class QuotaExceededError extends Error {
  constructor() { super('Quota exceeded'); this.name = 'QuotaExceededError'; }
}

/** Cache Storage with a byte budget, which is the part browsers differ on. */
function mockCacheStorage({ quotaBytes = Infinity, fetchImpl } = {}) {
  const caches = new Map(); // name -> Map(url -> { body, bytes })
  const used = () => [...caches.values()]
    .reduce((total, entry) => total + [...entry.values()].reduce((sum, r) => sum + r.bytes, 0), 0);

  const stripSearch = (url) => url.split('?')[0];

  const wrap = (name) => {
    const entries = caches.get(name);
    const cache = {
      async put(request, response) {
        const bytes = response.__bytes ?? 0;
        if (used() + bytes > quotaBytes) throw new QuotaExceededError();
        entries.set(new URL(request.url, 'https://x/').href, { body: response.__body, bytes });
      },
      async add(url) {
        const response = await fetchImpl(new Request(new URL(url, 'https://x/').href));
        if (!response.ok) throw new Error(`add() failed for ${url}`);
        await cache.put(new Request(new URL(url, 'https://x/').href), response);
      },
      async match(request, { ignoreSearch = false } = {}) {
        const href = new URL(request.url, 'https://x/').href;
        if (entries.has(href)) return makeResponse(entries.get(href).body, entries.get(href).bytes);
        if (!ignoreSearch) return undefined;
        for (const [key, value] of entries) {
          if (stripSearch(key) === stripSearch(href)) return makeResponse(value.body, value.bytes);
        }
        return undefined;
      },
    };
    return cache;
  };

  return {
    __raw: caches,
    __used: used,
    async open(name) { if (!caches.has(name)) caches.set(name, new Map()); return wrap(name); },
    async keys() { return [...caches.keys()]; },
    async delete(name) { return caches.delete(name); },
    // The global match — searches EVERY cache, which is the leak the worker
    // must not rely on.
    async match(request, options) {
      for (const name of caches.keys()) {
        const hit = await wrap(name).match(request, options);
        if (hit) return hit;
      }
      return undefined;
    },
  };
}

function makeResponse(body, bytes = 0, { ok = true, type = 'basic' } = {}) {
  const response = { ok, type, __body: body, __bytes: bytes };
  response.clone = () => makeResponse(body, bytes, { ok, type });
  return response;
}

/** Loads sw.js as a classic script with injected globals. */
function loadWorker({ cacheStorage, fetchImpl }) {
  const listeners = new Map();
  const self = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [] },
  };
  const factory = new Function(
    'self', 'caches', 'fetch', 'Request', 'Response', 'URL',
    SW_SOURCE,
  );
  factory(self, cacheStorage, fetchImpl, Request, { error: () => makeResponse(null, 0, { ok: false }) }, URL);

  return {
    listeners,
    async install() {
      let pending;
      await listeners.get('install')({ waitUntil: (promise) => { pending = promise; } });
      return pending;
    },
    /** Returns the response the worker committed to, or undefined for passthrough. */
    async handleFetch(url, { mode = 'no-cors' } = {}) {
      let responded;
      const request = new Request(new URL(url, 'https://x/').href);
      Object.defineProperty(request, 'mode', { value: mode });
      await listeners.get('fetch')({ request, respondWith: (promise) => { responded = promise; } });
      return responded ? await responded : undefined;
    },
  };
}

const cacheName = SW_SOURCE.match(/const CACHE = '([^']+)'/)[1];

test('install completes on a phone-sized quota by reclaiming the previous build first', async () => {
  // A quota that fits ONE build, not two — the phone case. The previous deploy
  // is already holding it all.
  const quotaBytes = 5_000;
  const fetchImpl = async (request) => makeResponse(`fresh:${request.url}`, 100);
  const cacheStorage = mockCacheStorage({ quotaBytes, fetchImpl });

  const stale = await cacheStorage.open('shutoko-nights-oldbuild');
  for (let i = 0; i < 45; i += 1) {
    await stale.put(new Request(`https://x/old-${i}.png`), makeResponse('old', 100));
  }
  assert.ok(cacheStorage.__used() > quotaBytes / 2, 'previous build should dominate storage');

  const worker = loadWorker({ cacheStorage, fetchImpl });
  await worker.install(); // must not reject — this is the regression

  assert.deepEqual(await cacheStorage.keys(), [cacheName], 'the previous build must be gone');
  const core = cacheStorage.__raw.get(cacheName);
  assert.ok(core.size > 30, `core should be populated, got ${core.size} entries`);
});

test('a deploy that reused the previous cache name still replaces its contents', async () => {
  // The stamp is only as reliable as the deploy running it. render.yaml's
  // buildCommand runs stamp-build, but a Render service that is not
  // Blueprint-managed ignores render.yaml entirely — and the committed CACHE
  // has in fact sat several commits behind main. install must not assume the
  // name changed; it runs because the worker bytes changed, which is enough.
  const fetchImpl = async (request) => makeResponse(`fresh:${request.url}`, 10);
  const cacheStorage = mockCacheStorage({ fetchImpl });

  const sameName = await cacheStorage.open(cacheName); // identical id, stale contents
  await sameName.put(new Request('https://x/data/editor/custom-assets.json'), makeResponse('OLD MANIFEST', 10));

  const worker = loadWorker({ cacheStorage, fetchImpl });
  await worker.install();

  const entries = cacheStorage.__raw.get(cacheName);
  const manifest = entries.get('https://x/data/editor/custom-assets.json');
  assert.equal(manifest, undefined, 'the stale manifest must not survive an install under the same name');
  assert.ok(entries.size > 30, 'and the core is repopulated from the network');
});

test('install survives a file that fails to fetch', async () => {
  // addAll() was all-or-nothing: one flaky request aborted the whole update.
  const fetchImpl = async (request) => (request.url.includes('traffic.js')
    ? makeResponse(null, 0, { ok: false })
    : makeResponse(`fresh:${request.url}`, 10));
  const cacheStorage = mockCacheStorage({ fetchImpl });
  const worker = loadWorker({ cacheStorage, fetchImpl });

  await worker.install();

  const core = cacheStorage.__raw.get(cacheName);
  assert.ok(core.size > 30, 'the rest of the core must still be cached');
  assert.ok(![...core.keys()].some(k => k.includes('traffic.js')), 'the failed file is simply absent');
});

test('content-hashed textures are left to the HTTP cache, not mirrored into storage', async () => {
  const fetchImpl = async () => makeResponse('image', 1_000_000);
  const cacheStorage = mockCacheStorage({ fetchImpl });
  const worker = loadWorker({ cacheStorage, fetchImpl });

  const responded = await worker.handleFetch('/data/editor/textures/asphalt3-eb0a085b8f.png');

  assert.equal(responded, undefined, 'the worker must not intercept it at all');
  assert.equal(cacheStorage.__used(), 0, 'nothing may be copied into Cache Storage');
});

test('a network failure never falls back to a previous build cache', async () => {
  // The stale-manifest path: an old cache answering custom-assets.json hands
  // back that build's texture URLs, so the player sees old textures even though
  // every texture file on disk is content-correct.
  const fetchImpl = async () => { throw new Error('offline'); };
  const cacheStorage = mockCacheStorage({ fetchImpl });

  const stale = await cacheStorage.open('shutoko-nights-oldbuild');
  await stale.put(new Request('https://x/data/editor/custom-assets.json'), makeResponse('OLD MANIFEST', 10));

  const worker = loadWorker({ cacheStorage, fetchImpl });
  const responded = await worker.handleFetch('/data/editor/custom-assets.json');

  assert.notEqual(responded?.__body, 'OLD MANIFEST', 'must not serve a previous build manifest');
  assert.equal(responded?.ok, false, 'with nothing in the current cache it is a plain failure');
});

test('the current build cache still answers when the network is down', async () => {
  let online = true;
  const fetchImpl = async (request) => {
    if (!online) throw new Error('offline');
    return makeResponse(`fresh:${request.url}`, 10);
  };
  const cacheStorage = mockCacheStorage({ fetchImpl });
  const worker = loadWorker({ cacheStorage, fetchImpl });
  await worker.install();

  online = false;
  // Requested with the build stamp; CORE is stored unstamped.
  const responded = await worker.handleFetch(`/js/game.js?v=${cacheName.split('-').pop()}`);

  assert.equal(responded?.__body, 'fresh:https://x/js/game.js', 'offline fallback still works across the ?v= stamp');
});
