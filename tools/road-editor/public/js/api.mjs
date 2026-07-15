/** Thin fetch wrappers for the editor server API. */

async function handle(res) {
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  meta: () => fetch('/api/meta').then(handle),
  network: () => fetch('/api/network').then(handle),
  quality: () => fetch('/api/quality').then(handle),
  overrides: () => fetch('/api/overrides').then(handle),
  backups: () => fetch('/api/backups').then(handle),
  preview: (routeId, overrides, light = false, signal = undefined) => fetch('/api/preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ routeId, overrides, light }),
    signal,
  }).then(handle),
  save: (doc) => fetch('/api/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc }),
  }).then(handle),
  restore: (name) => fetch('/api/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).then(handle),
  generatePreview: (overrides) => fetch('/api/generate-preview', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides }),
  }).then(handle),
  validateQuick: (overrides) => fetch('/api/validate-quick', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ overrides }),
  }).then(handle),
  apply: (doc, confirm) => fetch('/api/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ doc, confirm }),
  }).then(handle),
  /** Streams full validation output; onChunk(text) per chunk. */
  validateFull: async (onChunk) => {
    const res = await fetch('/api/validate-full', { method: 'POST' });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(dec.decode(value, { stream: true }));
    }
  },
};
